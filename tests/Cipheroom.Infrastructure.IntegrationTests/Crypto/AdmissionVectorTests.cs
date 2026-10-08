using System.Buffers.Text;
using System.Text.Json;
using Cipheroom.Application.Admission;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Crypto;

namespace Cipheroom.Infrastructure.IntegrationTests.Crypto;

/// <summary>
/// Vectors signed by WebCrypto (tests/fixtures/admission-vectors.json, generated with Node's WebCrypto — the same
/// primitives the browser uses). The server must derive the same room id and accept exactly these signatures.
/// </summary>
public sealed class AdmissionVectorTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static readonly Vectors V = JsonSerializer.Deserialize<Vectors>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Crypto", "admission-vectors.json")), Json)!;

    private static readonly RoomId Room = new(V.RoomId);
    private readonly Ed25519SignatureVerifier _verifier = new();

    [Fact]
    public void Fields_encoding_matches_the_browser() =>
        Assert.Equal(V.FieldsSample.Hex, Convert.ToHexStringLower(AdmissionMessages.Fields("label", "é", 7u, new byte[] { 1, 2 })));

    [Fact]
    public void The_room_id_derives_from_the_host_keys() =>
        Assert.Equal(V.RoomId, AdmissionMessages.RoomIdFor(new HostKeys(V.HostEd25519Pub, V.HostX25519Pub)));

    [Fact]
    public void Every_statement_verifies()
    {
        Assert.True(Verify(V.HostEd25519Pub, AdmissionMessages.Host(Room, V.Identity), V.Attestation));
        Assert.True(Verify(V.Identity, AdmissionMessages.Ticket(Room, V.Identity, V.Guest), V.Ticket));
        Assert.True(Verify(V.Identity, AdmissionMessages.CoHost(Room, V.Identity, V.Guest), V.CoHost));
        Assert.True(Verify(V.Identity, AdmissionMessages.Revoke(Room, V.Identity, V.Guest), V.Revoke));
        Assert.True(Verify(V.Identity, AdmissionMessages.Settings(Room, V.Identity, 3, true), V.Settings));
        Assert.True(Verify(V.Identity, AdmissionMessages.End(Room, V.Identity), V.End));
        Assert.True(Verify(V.Identity, AdmissionMessages.Mute(Room, V.Identity, V.Guest, 5), V.Mute));
    }

    [Fact]
    public void Statements_do_not_verify_for_another_purpose_room_or_signer()
    {
        var otherRoom = new RoomId("aaaaaaaaaaaaaaaaaaaaaaaaaa");
        Assert.False(Verify(V.Identity, AdmissionMessages.CoHost(Room, V.Identity, V.Guest), V.Ticket));
        Assert.False(Verify(V.Identity, AdmissionMessages.Ticket(otherRoom, V.Identity, V.Guest), V.Ticket));
        Assert.False(Verify(V.Guest, AdmissionMessages.Ticket(Room, V.Identity, V.Guest), V.Ticket));
        Assert.False(Verify(V.Identity, AdmissionMessages.Settings(Room, V.Identity, 3, false), V.Settings));
        Assert.False(Verify(V.Identity, AdmissionMessages.Mute(Room, V.Identity, V.Guest, 6), V.Mute));
    }

    [Fact]
    public void Malformed_keys_and_signatures_are_rejected_not_thrown()
    {
        Assert.False(_verifier.VerifyEd25519(new byte[31], [1], new byte[64]));
        Assert.False(_verifier.VerifyEd25519(new byte[32], [1], new byte[63]));
        Assert.False(_verifier.VerifyEd25519(new byte[32], [1], new byte[64]));
    }

    private bool Verify(string publicKey, byte[] message, string sig) =>
        _verifier.VerifyEd25519(Base64Url.DecodeFromChars(publicKey), message, Base64Url.DecodeFromChars(sig));

    private sealed record Vectors(
        FieldsSample FieldsSample,
        string HostEd25519Pub,
        string HostX25519Pub,
        string RoomId,
        string Identity,
        string Guest,
        string Attestation,
        string Ticket,
        string CoHost,
        string Revoke,
        string Settings,
        string End,
        string Mute);

    private sealed record FieldsSample(string Hex);
}
