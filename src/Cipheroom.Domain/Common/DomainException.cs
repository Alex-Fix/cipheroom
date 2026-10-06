namespace Cipheroom.Domain.Common;

/// <summary>A business rule was violated. The message is safe to show to clients (constant text, no input echoed).</summary>
public class DomainException(string message) : Exception(message);
