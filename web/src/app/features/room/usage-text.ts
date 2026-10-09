import { UsageDto } from '../../core/signaling/signaling.types';

/** "1 November" — when the usage guard's month resets (it's a UTC calendar month). */
export function resetDate(usage: Pick<UsageDto, 'resetsAt'>): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(usage.resetsAt));
}

/** Why camera and screen share are off right now (usage guard), or undefined when video is allowed. */
export function videoBlockedReason(usage: UsageDto | undefined): string | undefined {
  return usage && (usage.level === 'audio-only' || usage.level === 'paused')
    ? `Video is paused until ${resetDate(usage)} to stay within the free tier.`
    : undefined;
}

/** The server refused to start or join a call because of the usage guard. */
export function isCallsPaused(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith('Calls are paused.');
}
