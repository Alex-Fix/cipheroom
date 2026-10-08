using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests;

/// <summary>Room ids in the real format, and a quick way into a room (signatures are checked outside the domain).</summary>
internal static class TestRooms
{
    public static readonly RoomId Id1 = new("aaaaaaaaaaaaaaaaaaaaaaaaaa");
    public static readonly RoomId Id2 = new("bbbbbbbbbbbbbbbbbbbbbbbbbb");

    public static readonly HostKeys HostKeys = new(TestIdentity.Ed25519Pub, TestIdentity.X25519Pub);

    /// <summary>Distinct identities per name, so authority rules (which go by identity) can tell people apart.</summary>
    public static IdentityKeys Identity(string seed) =>
        new(Pub(seed, 'A'), TestIdentity.X25519Pub, TestIdentity.Sig);

    /// <summary>The first one in becomes host; everyone after is admitted by them.</summary>
    public static Participant Join(this Room room, string connectionId)
    {
        var identity = Identity(connectionId);
        if (room.Admitters.Count == 0)
            return room.JoinAsHost(connectionId, identity, VideoCodecs.Baseline, HostKeys, TestIdentity.Sig);

        var guest = room.EnterLobby(connectionId, identity, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch);
        return room.Admit(room.Admitters[0].Id, guest.Id, TestIdentity.Sig);
    }

    /// <summary>43 base64url characters (32 bytes) that differ per seed.</summary>
    private static string Pub(string seed, char pad)
    {
        var chars = new string([.. seed.Where(char.IsAsciiLetterOrDigit)]);
        return (chars + new string(pad, 43))[..42] + "A";
    }
}
