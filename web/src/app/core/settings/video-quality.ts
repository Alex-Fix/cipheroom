import { VIDEO_QUALITIES, VideoQuality } from '../media/quality';

/** The user's camera quality choice, remembered in this browser only. */
export const VIDEO_QUALITY_KEY = 'cipheroom.videoQuality';

export function loadVideoQuality(): VideoQuality {
  try {
    const stored = localStorage.getItem(VIDEO_QUALITY_KEY);
    return VIDEO_QUALITIES.find((q) => q === stored) ?? 'auto';
  } catch {
    return 'auto';
  }
}

export function saveVideoQuality(quality: VideoQuality): void {
  try {
    localStorage.setItem(VIDEO_QUALITY_KEY, quality);
  } catch {
    // Storage unavailable (private mode) — the choice just won't be remembered.
  }
}
