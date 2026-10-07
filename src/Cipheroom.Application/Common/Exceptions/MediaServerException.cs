namespace Cipheroom.Application.Common.Exceptions;

/// <summary>The media server refused or failed a request. The message is constant and safe to show to clients; the
/// cause (status / error code only, never SDP) is kept for the server log.</summary>
public sealed class MediaServerException(Exception? innerException = null)
    : Exception("Media server unavailable.", innerException);
