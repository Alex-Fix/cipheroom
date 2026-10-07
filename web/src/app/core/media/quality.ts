/** Camera send quality. 'auto' = the best the camera supports, up to 4K. */
export type VideoQuality = 'auto' | '2160p' | '1080p' | '720p';

export const VIDEO_QUALITIES: readonly VideoQuality[] = ['auto', '2160p', '1080p', '720p'];

const SIZES: Record<Exclude<VideoQuality, 'auto'>, { width: number; height: number }> = {
  '2160p': { width: 3840, height: 2160 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
};

/** getUserMedia video constraints for a quality (device / facing mode are added by the caller). */
export function captureConstraints(quality: VideoQuality): MediaTrackConstraints {
  const { width, height } = SIZES[quality === 'auto' ? '2160p' : quality];
  return {
    // 'ideal' lets the browser pick the camera's closest mode; explicit choices also cap it.
    width: quality === 'auto' ? { ideal: width } : { ideal: width, max: width },
    height: quality === 'auto' ? { ideal: height } : { ideal: height, max: height },
    frameRate: { ideal: 30 },
  };
}

/** Qualities worth offering for a camera: higher presets only if it can capture them. */
export function supportedQualities(maxHeight: number | undefined): VideoQuality[] {
  return VIDEO_QUALITIES.filter(
    (q) =>
      q === 'auto' || q === '720p' || (maxHeight !== undefined && maxHeight >= SIZES[q].height),
  );
}

/** Bitrate ceiling for camera video of this height (30 fps; H.264 Constrained Baseline, VP8 similar). */
export function bitrateFor(height: number): number {
  if (height >= 2160) return 8_000_000;
  if (height >= 1440) return 5_000_000;
  if (height >= 1080) return 3_000_000;
  if (height >= 720) return 1_500_000;
  if (height >= 540) return 800_000;
  if (height >= 360) return 500_000;
  return 200_000;
}

/** Simulcast layers for a camera captured at `height`: full (f), half (h) and quarter (q) resolution. */
export function cameraEncodings(height: number): RTCRtpEncodingParameters[] {
  return [
    { rid: 'f', maxBitrate: bitrateFor(height) },
    { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: bitrateFor(height / 2) },
    { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: bitrateFor(height / 4) },
  ];
}
