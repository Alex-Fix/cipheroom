using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Usage;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.JoinLobby;

/// <summary>
/// Enter a room: the host (proving it holds the host key the room id is derived from) and anyone holding a valid ticket
/// from earlier in this call (a reconnect) join straight in; everyone else waits in the lobby until an admitter lets
/// them in. Raw client input: validated by <see cref="JoinLobbyCommandValidator"/> before the handler runs.
/// </summary>
/// <param name="Identity">The caller's public E2EE keys for this call; required (no unencrypted joins).</param>
/// <param name="VideoCodecs">Video codecs the caller's browser can decode (<c>vp8</c> required).</param>
/// <param name="HostProof">Only from the host's browser.</param>
/// <param name="Ticket">The ticket that admitted this identity earlier in the call, if any.</param>
public sealed record JoinLobbyCommand(
    string ConnectionId,
    string? RoomId,
    IdentityInput? Identity,
    IReadOnlyList<string?>? VideoCodecs,
    HostProofInput? HostProof = null,
    TicketInput? Ticket = null) : ICommand<JoinLobbyResult>;

/// <summary>Raw public identity keys (base64url) as the client sent them.</summary>
public sealed record IdentityInput(string? Ed25519Pub, string? X25519Pub, string? Sig);

/// <summary>The host's public keys and the host key's signature over the caller's identity (base64url).</summary>
public sealed record HostProofInput(string? HostEd25519Pub, string? HostX25519Pub, string? Attestation);

/// <summary>An admission ticket: the issuing admitter's identity and its signature over the caller's identity.</summary>
public sealed record TicketInput(string? Issuer, string? Sig);

/// <param name="Self">Set when the caller is in the call; <paramref name="Guest"/> when waiting in the lobby.</param>
/// <param name="Others">Participants who were already in the call (empty for lobby guests).</param>
/// <param name="AuthorityChanged">A host or co-host came (back): the lobby and the room should hear about it.</param>
public sealed record JoinLobbyResult(
    Participant? Self,
    LobbyGuest? Guest,
    IReadOnlyList<Participant> Others,
    RoomAuthority Authority,
    bool AuthorityChanged)
{
    public RoomId RoomId => Self?.RoomId ?? Guest!.RoomId;
}

public sealed class JoinLobbyCommandValidator : AbstractValidator<JoinLobbyCommand>
{
    public const string InvalidIdentity = "Invalid identity.";
    public const string InvalidVideoCodecs = "Invalid video codecs.";

    public JoinLobbyCommandValidator()
    {
        // Report one problem at a time, room id first (the client shows a single message).
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.RoomId).Must(Domain.Rooms.RoomId.IsValid).WithMessage("Invalid room id.");
        RuleFor(c => c.Identity)
            .Must(i => i is not null && IdentityKeys.IsValid(i.Ed25519Pub, i.X25519Pub, i.Sig))
            .WithMessage(InvalidIdentity);
        RuleFor(c => c.VideoCodecs).Must(Domain.Rooms.VideoCodecs.IsValid).WithMessage(InvalidVideoCodecs);
        RuleFor(c => c.HostProof)
            .Must(p => p is null || (Base64UrlBytes.IsPublicKey(p.HostEd25519Pub) && Base64UrlBytes.IsPublicKey(p.HostX25519Pub) && Base64UrlBytes.IsSignature(p.Attestation)))
            .WithMessage(AdmissionRules.InvalidHostProof);
        RuleFor(c => c.Ticket)
            .Must(t => t is null || (Base64UrlBytes.IsPublicKey(t.Issuer) && Base64UrlBytes.IsSignature(t.Sig)))
            .WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class JoinLobbyCommandHandler(
    IRoomStore rooms,
    ISignatureVerifier verifier,
    TimeProvider time,
    CipheroomMetrics metrics,
    IUsageGuard usage)
    : ICommandHandler<JoinLobbyCommand, JoinLobbyResult>
{
    public ValueTask<JoinLobbyResult> Handle(JoinLobbyCommand command, CancellationToken cancellationToken)
    {
        var roomId = new RoomId(command.RoomId!);
        var identity = new IdentityKeys(command.Identity!.Ed25519Pub!, command.Identity.X25519Pub!, command.Identity.Sig!);
        var videoCodecs = new VideoCodecs([.. command.VideoCodecs!.Select(c => c!)]);
        var hostKeys = command.HostProof is { } proof ? CheckHostProof(roomId, identity, proof) : null;
        var ticket = command.Ticket is { } t && verifier.VerifyEd25519(
                Key(t.Issuer!), AdmissionMessages.Ticket(roomId, t.Issuer!, identity.Ed25519Pub), Key(t.Sig!))
            ? new Statement(identity.Ed25519Pub, t.Issuer!, t.Sig!)
            : null;
        var now = time.GetUtcNow();
        var level = usage.Current.Level;

        var result = rooms.Enter(roomId, command.ConnectionId, room =>
        {
            Participant[] others = [.. room.Participants];
            // Usage guard: at audio-only only reconnects into a call already running get in; when paused, nobody.
            var callRunning = others.Length > 0;
            if (level >= UsageLevel.Paused || (level == UsageLevel.AudioOnly && !callRunning))
                throw new DomainException(UsageRules.CallsPaused);
            if (hostKeys is not null)
            {
                var host = room.JoinAsHost(command.ConnectionId, identity, videoCodecs, hostKeys, command.HostProof!.Attestation!);
                return new JoinLobbyResult(host, null, others, room.Authority(), AuthorityChanged: true);
            }
            if (ticket is not null && room.CanRejoinWith(identity, ticket))
            {
                var self = room.JoinWithTicket(command.ConnectionId, identity, videoCodecs, ticket);
                return new JoinLobbyResult(self, null, others, room.Authority(), self.IsAdmitter);
            }
            // A ticket that doesn't check out (e.g. the call restarted) just means asking again — not when it's audio-only.
            if (level == UsageLevel.AudioOnly)
                throw new DomainException(UsageRules.CallsPaused);
            var guest = room.EnterLobby(command.ConnectionId, identity, videoCodecs, now);
            return new JoinLobbyResult(null, guest, [], room.Authority(), AuthorityChanged: false);
        });

        metrics.Admission(result.Self is not null ? CipheroomMetrics.AdmissionJoined : CipheroomMetrics.AdmissionWaiting);
        return ValueTask.FromResult(result);
    }

    /// <summary>The host keys must derive the room id, and the host key must have signed the caller's identity.</summary>
    private HostKeys CheckHostProof(RoomId roomId, IdentityKeys identity, HostProofInput proof)
    {
        var keys = new HostKeys(proof.HostEd25519Pub!, proof.HostX25519Pub!);
        if (AdmissionMessages.RoomIdFor(keys) != roomId.Value
            || !verifier.VerifyEd25519(Key(keys.Ed25519Pub), AdmissionMessages.Host(roomId, identity.Ed25519Pub), Key(proof.Attestation!)))
            throw new DomainException(AdmissionRules.InvalidHostProof);
        return keys;
    }

    private static byte[] Key(string base64Url) => System.Buffers.Text.Base64Url.DecodeFromChars(base64Url);
}
