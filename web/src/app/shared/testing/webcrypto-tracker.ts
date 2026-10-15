/**
 * For specs that fake timers but use real WebCrypto, which finishes off the main thread at its own pace: counts the
 * WebCrypto calls in flight so a spec can wait for them before it moves the fake clock. Waiting a fixed number of
 * event-loop turns instead was enough on a fast laptop and too few on CI runners, so debounces and retries fired
 * before the crypto that should have come first.
 */
const METHODS = [
  'encrypt',
  'decrypt',
  'sign',
  'verify',
  'digest',
  'generateKey',
  'deriveKey',
  'deriveBits',
  'importKey',
  'exportKey',
  'wrapKey',
  'unwrapKey',
] as const;

type Subtle = Record<(typeof METHODS)[number], (...args: unknown[]) => Promise<unknown>>;

let pending = 0;
let slowTurns = 0;

/** One real event-loop turn (setImmediate is never faked in these specs). */
export const realTick = () =>
  new Promise<void>((resolve) =>
    (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(resolve),
  );

/** Starts counting (and, with `slow`, delaying) WebCrypto calls; returns the function that undoes it. */
export function trackWebCrypto(options: { slow?: number } = {}): () => void {
  const subtle = globalThis.crypto.subtle as unknown as Subtle;
  const originals = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  slowTurns = options.slow ?? 0;
  pending = 0;
  for (const name of METHODS) {
    const original = subtle[name];
    originals.set(name, original);
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        pending++;
        try {
          const result = await original.apply(subtle, args);
          for (let i = 0; i < slowTurns; i++) await realTick();
          return result;
        } finally {
          pending--;
        }
      },
    });
  }
  return () => {
    for (const name of METHODS) delete (subtle as Partial<Subtle>)[name];
    pending = 0;
    slowTurns = 0;
  };
}

/**
 * Waits (in real event-loop turns) until no WebCrypto call has been in flight for `quiet` turns in a row: between two
 * calls the code may pass through a real turn (IndexedDB, a worker message), so one idle turn isn't the end.
 */
export async function webCryptoIdle(quiet = 5, maxTurns = 100_000): Promise<void> {
  for (let idle = 0, i = 0; idle < quiet && i < maxTurns; i++) {
    await realTick();
    idle = pending > 0 ? 0 : idle + 1;
  }
}
