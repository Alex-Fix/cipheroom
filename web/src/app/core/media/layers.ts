import { VideoLayer } from '../signaling/signaling.types';

/**
 * Smallest simulcast layer that still looks sharp in a tile. Camera layers are ~1280 (f), ~640 (h) and ~320 (q)
 * pixels wide; a layer is good enough until the tile is ~1.25× wider than it.
 * @param width Rendered tile width in CSS pixels; 0 when not on screen.
 */
export function layerFor(width: number, pixelRatio = 1, visible = true): VideoLayer {
  if (!visible || width <= 0) return 'q';
  const pixels = width * pixelRatio;
  if (pixels > 800) return 'f';
  if (pixels > 400) return 'h';
  return 'q';
}
