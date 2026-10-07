/** The parts of RTCRtpCodec we look at. */
export interface CodecLike {
  mimeType: string;
  sdpFmtpLine?: string;
}

/**
 * Codec order for the camera. H.264 first: phones and most laptops encode it in hardware (iOS can't keep up with
 * software VP8 simulcast while also decoding others) and every browser decodes it. Within H.264, packetization-mode=1
 * Constrained Baseline (42e0xx) first — the variant every device decodes. VP8 next, as the fallback when the browser
 * can't send H.264. Everything else (VP9, AV1, rtx, red, ulpfec…) keeps its place after that: rtx/red/fec must stay
 * in the list. The sort is stable, so the browser's own order is kept within each rank.
 */
export function cameraCodecOrder<T extends CodecLike>(
  codecs: readonly T[],
  canSendH264: boolean,
): T[] {
  const rank = (c: T): number => {
    const mime = c.mimeType.toLowerCase();
    if (mime === 'video/h264' && canSendH264) {
      const fmtp = c.sdpFmtpLine ?? '';
      const mode1 = /packetization-mode=1/.test(fmtp);
      const constrainedBaseline = /profile-level-id=42e0/i.test(fmtp);
      if (mode1 && constrainedBaseline) return 0;
      return mode1 ? 1 : 2;
    }
    if (mime === 'video/vp8') return 3;
    return 4;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}
