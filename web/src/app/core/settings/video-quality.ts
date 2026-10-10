import { DEFAULT_VIDEO_QUALITY, VIDEO_QUALITIES, VideoQuality } from '../media/quality';

/** The user's camera quality choice, remembered in this browser only. */
export const VIDEO_QUALITY_KEY = 'cipheroom.videoQuality';

export function loadVideoQuality(): VideoQuality {
  try {
    const stored = localStorage.getItem(VIDEO_QUALITY_KEY);
    // Includes the old 'auto' choice, which falls back to the default.
    return VIDEO_QUALITIES.find((q) => q === stored) ?? DEFAULT_VIDEO_QUALITY;
  } catch {
    return DEFAULT_VIDEO_QUALITY;
  }
}

export function saveVideoQuality(quality: VideoQuality): void {
  try {
    localStorage.setItem(VIDEO_QUALITY_KEY, quality);
  } catch {
    // Storage unavailable (private mode) — the choice just won't be remembered.
  }
}
