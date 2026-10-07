namespace Cipheroom.Domain.Rooms;

/// <summary>What a published track carries. One track per source per participant.</summary>
public enum TrackSource
{
    Microphone,
    Camera,
    Screen,
}

public enum TrackKind
{
    Audio,
    Video,
}

public static class TrackSources
{
    /// <summary>Wire names, as clients send them.</summary>
    public static bool TryParse(string? value, out TrackSource source)
    {
        switch (value)
        {
            case "microphone":
                source = TrackSource.Microphone;
                return true;
            case "camera":
                source = TrackSource.Camera;
                return true;
            case "screen":
                source = TrackSource.Screen;
                return true;
            default:
                source = default;
                return false;
        }
    }

    public static bool IsValid(string? value) => TryParse(value, out _);

    public static string ToWire(this TrackSource source) => source switch
    {
        TrackSource.Microphone => "microphone",
        TrackSource.Camera => "camera",
        TrackSource.Screen => "screen",
        _ => throw new ArgumentOutOfRangeException(nameof(source)),
    };

    public static TrackKind Kind(this TrackSource source) =>
        source == TrackSource.Microphone ? TrackKind.Audio : TrackKind.Video;
}
