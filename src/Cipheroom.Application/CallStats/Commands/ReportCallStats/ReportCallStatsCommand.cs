using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.CallStats.Commands.ReportCallStats;

/// <summary>
/// A browser's call-quality summary for the last interval (~15 s): numbers only — no ids, names, addresses or media.
/// Recorded as metrics; never logged, stored or shown to other participants.
/// </summary>
public sealed record ReportCallStatsCommand(string ConnectionId, CallStatsInput? Stats) : ICommand;

/// <param name="Platform">Coarse browser bucket (<see cref="CallStatsRules.Platforms"/>).</param>
/// <param name="Path">direct / relay / unknown.</param>
/// <param name="RttMs">Round trip on the connection to Cloudflare (selected ICE candidate pair).</param>
public sealed record CallStatsInput(
    string? Platform,
    string? Path,
    double IntervalSeconds,
    double? RttMs,
    StreamStatsInput? AudioSent,
    StreamStatsInput? AudioReceived,
    StreamStatsInput? VideoSent,
    StreamStatsInput? VideoReceived,
    E2eeStatsInput? E2ee);

/// <summary>One direction of one media kind, summed over its streams for the interval.</summary>
/// <param name="FreezeSeconds">Received video only: time frozen during the interval.</param>
/// <param name="Height">Received video: tallest stream; sent video: what we encode.</param>
public sealed record StreamStatsInput(
    double Bytes,
    double Packets,
    double PacketsLost,
    double? JitterMs,
    double? FreezeSeconds,
    double? Height,
    double? Fps);

/// <summary>End-to-end encryption health for the interval (counts and seconds only).</summary>
public sealed record E2eeStatsInput(
    double FramesEncrypted,
    double FramesDecrypted,
    double FramesFailed,
    double FramesMissingKey,
    double EnvelopesDropped,
    double SecuringSeconds);

public sealed class ReportCallStatsCommandValidator : AbstractValidator<ReportCallStatsCommand>
{
    public ReportCallStatsCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Stats).Must(IsValid).WithMessage(CallStatsRules.InvalidStats);
    }

    private static bool IsValid(CallStatsInput? s) =>
        s is not null
        && s.Platform is { Length: > 0 and <= 32 }
        && s.Path is { Length: > 0 and <= 16 }
        && s.IntervalSeconds is > 0 and <= CallStatsRules.MaxIntervalSeconds
        && CallStatsRules.InRange(s.RttMs, CallStatsRules.MaxRttMs)
        && IsValid(s.AudioSent) && IsValid(s.AudioReceived) && IsValid(s.VideoSent) && IsValid(s.VideoReceived)
        && IsValid(s.E2ee);

    private static bool IsValid(StreamStatsInput? s) =>
        s is null
        || (CallStatsRules.InRange(s.Bytes, CallStatsRules.MaxBytes)
            && CallStatsRules.InRange(s.Packets, CallStatsRules.MaxPackets)
            && CallStatsRules.InRange(s.PacketsLost, CallStatsRules.MaxPackets)
            && CallStatsRules.InRange(s.JitterMs, CallStatsRules.MaxJitterMs)
            && CallStatsRules.InRange(s.FreezeSeconds, CallStatsRules.MaxIntervalSeconds)
            && CallStatsRules.InRange(s.Height, CallStatsRules.MaxHeight)
            && CallStatsRules.InRange(s.Fps, CallStatsRules.MaxFps));

    private static bool IsValid(E2eeStatsInput? e) =>
        e is null
        || (CallStatsRules.InRange(e.FramesEncrypted, CallStatsRules.MaxFrames)
            && CallStatsRules.InRange(e.FramesDecrypted, CallStatsRules.MaxFrames)
            && CallStatsRules.InRange(e.FramesFailed, CallStatsRules.MaxFrames)
            && CallStatsRules.InRange(e.FramesMissingKey, CallStatsRules.MaxFrames)
            && CallStatsRules.InRange(e.EnvelopesDropped, CallStatsRules.MaxEnvelopes)
            && CallStatsRules.InRange(e.SecuringSeconds, CallStatsRules.MaxSecuringSeconds));
}

public sealed class ReportCallStatsCommandHandler(IRoomStore rooms, CipheroomMetrics metrics) : ICommandHandler<ReportCallStatsCommand>
{
    public ValueTask<Unit> Handle(ReportCallStatsCommand command, CancellationToken cancellationToken)
    {
        // Only people in a call report on one.
        _ = MediaSessions.Member(rooms, command.ConnectionId);

        var stats = command.Stats!;
        var platform = CallStatsRules.Platforms.Contains(stats.Platform!) ? stats.Platform! : CallStatsRules.OtherPlatform;
        var path = CallStatsRules.Paths.Contains(stats.Path!) ? stats.Path! : CallStatsRules.UnknownPath;
        metrics.CallReport(stats, platform, path);
        return ValueTask.FromResult(Unit.Value);
    }
}
