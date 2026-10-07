import { Injectable, signal } from '@angular/core';

/**
 * Plays call audio. Browsers may refuse to start sound without a user gesture (autoplay policy); blocked elements
 * are remembered and `blocked` turns true until `resume()` is called from a click.
 */
@Injectable({ providedIn: 'root' })
export class AudioPlayback {
  private readonly waiting = new Set<HTMLMediaElement>();

  readonly blocked = signal(false);

  play(element: HTMLMediaElement): void {
    element.play().catch((e: unknown) => {
      if ((e as { name?: string } | undefined)?.name !== 'NotAllowedError') return;
      this.waiting.add(element);
      this.blocked.set(true);
    });
  }

  /** The element is going away (track detached). */
  forget(element: HTMLMediaElement): void {
    this.waiting.delete(element);
    if (this.waiting.size === 0) this.blocked.set(false);
  }

  /** Must be called from a user gesture. */
  async resume(): Promise<void> {
    const elements = [...this.waiting];
    this.waiting.clear();
    this.blocked.set(false);
    await Promise.all(elements.map((e) => e.play().catch(() => undefined)));
  }
}
