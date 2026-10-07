/**
 * Debug flag for checking that the SFU really carries ciphertext: `?e2ee=passthrough` makes *this* browser stop
 * decrypting what it receives (others then look and sound like garbage) and log the frame worker's counters;
 * `?e2ee=off` clears it. Remembered for the tab so rejoins keep it. It never weakens what anyone sends: our own
 * frames are always encrypted.
 */
const STORAGE_KEY = 'cipheroom.e2eeDebug';

export function passThroughRequested(search = location.search): boolean {
  const requested = new URLSearchParams(search).get('e2ee');
  try {
    if (requested === 'passthrough') sessionStorage.setItem(STORAGE_KEY, requested);
    else if (requested === 'off') sessionStorage.removeItem(STORAGE_KEY);
    return sessionStorage.getItem(STORAGE_KEY) === 'passthrough';
  } catch {
    return requested === 'passthrough';
  }
}
