import { DEFAULT_VIDEO_CODEC, VIDEO_CODECS, VideoCodec } from '../media/codecs';

/** The user's video codec choice, remembered in this browser only. */
export const VIDEO_CODEC_KEY = 'cipheroom.videoCodec';

export function loadVideoCodec(): VideoCodec {
  try {
    const stored = localStorage.getItem(VIDEO_CODEC_KEY);
    return VIDEO_CODECS.find((c) => c === stored) ?? DEFAULT_VIDEO_CODEC;
  } catch {
    return DEFAULT_VIDEO_CODEC;
  }
}

export function saveVideoCodec(codec: VideoCodec): void {
  try {
    localStorage.setItem(VIDEO_CODEC_KEY, codec);
  } catch {
    // Storage unavailable (private mode) — the choice just won't be remembered.
  }
}
