import { VideoCodec } from './codecs';

/** Camera send quality. */
export type VideoQuality = '2160p' | '1080p' | '720p';

/** Highest first (the picker's order). */
export const VIDEO_QUALITIES: readonly VideoQuality[] = ['2160p', '1080p', '720p'];

/** Full HD unless the user picks otherwise; a camera that can't do it sends the best it has below. */
export const DEFAULT_VIDEO_QUALITY: VideoQuality = '1080p';

const SIZES: Record<VideoQuality, { width: number; height: number }> = {
  '2160p': { width: 3840, height: 2160 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
};

/**
 * getUserMedia video constraints for a quality (device / facing mode are added by the caller): 'ideal' lets the
 * browser pick the camera's closest mode when it can't do that size, 'max' keeps a bigger camera from sending more.
 */
export function captureConstraints(quality: VideoQuality): MediaTrackConstraints {
  const { width, height } = SIZES[quality];
  return {
    width: { ideal: width, max: width },
    height: { ideal: height, max: height },
    frameRate: { ideal: 30 },
  };
}

/**
 * Qualities worth offering for a camera: 4K and 1080p only if it can capture them, 720p always. Before a camera has
 * run (capabilities unknown): the default and 720p.
 */
export function supportedQualities(maxHeight: number | undefined): VideoQuality[] {
  if (maxHeight === undefined) return [DEFAULT_VIDEO_QUALITY, '720p'];
  return VIDEO_QUALITIES.filter((q) => q === '720p' || maxHeight >= SIZES[q].height);
}

/** What a choice turns into on a camera offering `available`: the highest offered quality not above it. */
export function closestQuality(
  chosen: VideoQuality,
  available: readonly VideoQuality[],
): VideoQuality {
  const order = VIDEO_QUALITIES;
  return (
    available
      .filter((q) => order.indexOf(q) >= order.indexOf(chosen))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? '720p'
  );
}

/**
 * Bitrate ceiling relative to VP8 for about the same picture: starting points from published codec comparisons,
 * to be tuned with the call-quality numbers in Grafana.
 */
const CODEC_BITRATE_FACTOR: Record<VideoCodec, number> = { vp8: 1, vp9: 0.65 };

/** Bitrate ceiling for a video of this height (30 fps, camera content). */
export function bitrateFor(height: number, codec: VideoCodec = 'vp8'): number {
  return Math.round(vp8BitrateFor(height) * CODEC_BITRATE_FACTOR[codec]);
}

function vp8BitrateFor(height: number): number {
  if (height >= 2160) return 8_000_000;
  if (height >= 1440) return 5_000_000;
  if (height >= 1080) return 3_000_000;
  if (height >= 720) return 1_500_000;
  if (height >= 540) return 800_000;
  if (height >= 360) return 500_000;
  return 200_000;
}

/**
 * Simulcast layers for a camera captured at `height`: full (f), half (h) and quarter (q) resolution.
 * `scalabilityMode`: set on every layer when given (see `simulcastScalabilityMode`).
 */
export function cameraEncodings(
  height: number,
  codec: VideoCodec = 'vp8',
  scalabilityMode?: string,
): RTCRtpEncodingParameters[] {
  const mode = scalabilityMode ? { scalabilityMode } : {};
  return [
    { rid: 'f', maxBitrate: bitrateFor(height, codec), ...mode },
    { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: bitrateFor(height / 2, codec), ...mode },
    { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: bitrateFor(height / 4, codec), ...mode },
  ];
}
