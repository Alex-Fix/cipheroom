import { VideoLayer } from '../signaling/signaling.types';

/** Device pixels a tile must be at least as wide as to receive the full / half layer. */
export const FULL_LAYER_MIN_PX = 960;
export const HALF_LAYER_MIN_PX = 360;

/**
 * Layer to receive for a remote camera, from its tile's rendered width (CSS px; 0 = off screen or hidden): the full
 * layer for a big tile (the stage), half for mid-size grid tiles, quarter for thumbnails and anything nobody can see.
 * Cloudflare steps down further by itself when the receiver's bandwidth can't take it. A tile that never reported a
 * size gets the full layer (subscriptions start there).
 */
export function receiveLayer(
  cssWidth: number | undefined,
  devicePixelRatio = 1,
  pageVisible = true,
): VideoLayer {
  if (!pageVisible) return 'q';
  if (cssWidth === undefined) return 'f';
  const width = cssWidth * Math.max(devicePixelRatio, 1);
  if (width >= FULL_LAYER_MIN_PX) return 'f';
  if (width >= HALF_LAYER_MIN_PX) return 'h';
  return 'q';
}
