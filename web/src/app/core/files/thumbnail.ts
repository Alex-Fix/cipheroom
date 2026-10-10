import { toBase64Url } from '../crypto/encoding';

/** Longest edge of the preview that travels inside the file card. */
export const THUMBNAIL_EDGE = 64;
/** Largest preview we put in a card (base64url adds a third; the card must fit a chat event). */
export const THUMBNAIL_MAX_BYTES = 6 * 1024;
const QUALITIES = [0.7, 0.5, 0.3] as const;

/**
 * A small, blurred-looking JPEG preview of an image (base64url), drawn by this browser — re-encoding drops all
 * metadata. Undefined if the image can't be decoded here or no quality fits the size limit.
 */
export async function makeThumbnail(image: Blob): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' });
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    // JPEG has no transparency: put transparent images on white rather than black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return await smallestFitting((quality) => canvas.convertToBlob({ type: 'image/jpeg', quality }));
  } catch {
    return undefined;
  }
}

/** Tries decreasing qualities until the encoding fits THUMBNAIL_MAX_BYTES. */
export async function smallestFitting(encode: (quality: number) => Promise<Blob>): Promise<string | undefined> {
  for (const quality of QUALITIES) {
    const blob = await encode(quality);
    if (blob.size <= THUMBNAIL_MAX_BYTES) return toBase64Url(new Uint8Array(await blob.arrayBuffer()));
  }
  return undefined;
}
