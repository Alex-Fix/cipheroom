/**
 * SPIKE flag (step 1 of docs/plans/2026-10-07-e2ee-media-design.md), removed once real keys exist.
 * `?e2ee=spike` encrypts frames with a fixed test key; `?e2ee=passthrough` also stops decrypting what we receive (to
 * see ciphertext arrive); `?e2ee=off` clears it. Remembered for the tab so rejoins keep it.
 */
export type E2eeSpikeMode = 'spike' | 'passthrough';

const STORAGE_KEY = 'cipheroom.e2eeSpike';

export function e2eeSpikeMode(search = location.search): E2eeSpikeMode | undefined {
  const requested = new URLSearchParams(search).get('e2ee');
  try {
    if (requested === 'spike' || requested === 'passthrough')
      sessionStorage.setItem(STORAGE_KEY, requested);
    else if (requested === 'off') sessionStorage.removeItem(STORAGE_KEY);
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored === 'spike' || stored === 'passthrough' ? stored : undefined;
  } catch {
    return requested === 'spike' || requested === 'passthrough' ? requested : undefined;
  }
}
