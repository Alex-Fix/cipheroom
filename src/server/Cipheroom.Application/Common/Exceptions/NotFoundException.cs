namespace Cipheroom.Application.Common.Exceptions;

/// <summary>The caller referred to something that doesn't exist (for them). The message is safe to show to clients.</summary>
public sealed class NotFoundException(string message) : Exception(message);
