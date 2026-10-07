import { VideoLayer } from '../signaling/signaling.types';

/**
 * Layer to receive for a remote camera: always the highest (full) while it's on screen — Cloudflare steps down by
 * itself when the receiver's bandwidth can't take it — and the smallest when nobody can see it.
 */
export function receiveLayer(onScreen: boolean): VideoLayer {
  return onScreen ? 'f' : 'q';
}
