/** The user's display name, remembered in this browser only (never sent anywhere but the room they join). */
export const DISPLAY_NAME_KEY = 'cipheroom.displayName';

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, name);
  } catch {
    // Storage unavailable (private mode) — name just won't be remembered.
  }
}
