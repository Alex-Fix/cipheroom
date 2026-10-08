/**
 * Video codec choice (designs: docs/plans/2026-10-08-video-compression-design.md, …-remove-av1-design.md). Every
 * frame is end-to-end
 * encrypted whatever the codec (see crypto/frame-codec.ts); the codec only changes how many bytes a picture costs.
 *
 * - VP9 (default): ~⅓ fewer bytes than VP8 for the same picture, decoded by every modern browser.
 * - VP8: the baseline every client decodes.
 * AV1 was removed: Cloudflare can't switch a viewer back up to a sharper simulcast layer with it.
 *
 * Cloudflare doesn't forward a codec change on a published track, so the codec is chosen when we join, from who's
 * in the call; changing it (or a newcomer who can't decode it) means rejoining.
 */

export type VideoCodec = 'vp9' | 'vp8';

/** Picker order. */
export const VIDEO_CODECS: readonly VideoCodec[] = ['vp9', 'vp8'];

export const DEFAULT_VIDEO_CODEC: VideoCodec = 'vp9';

/** What we fall back to, in order, when the chosen codec can't be used. VP8 always works. */
const FALLBACKS: readonly VideoCodec[] = ['vp9', 'vp8'];

/** Wire order of `videoCodecs` in JoinRoom / ParticipantDto. */
const WIRE_ORDER: readonly VideoCodec[] = ['vp8', 'vp9'];

/** A codec capability as RTCRtpSender/RTCRtpReceiver.getCapabilities report it. */
export interface CodecCapability {
  mimeType: string;
  clockRate: number;
  sdpFmtpLine?: string;
}

/** Our codec for a capability's mime type (`video/VP9` → `vp9`), or `undefined` for anything else. */
export function videoCodecOf(mimeType: string): VideoCodec | undefined {
  const name = mimeType.toLowerCase();
  return VIDEO_CODECS.find((c) => name === `video/${c}`);
}

/** Codecs in these capabilities, in wire order; VP8 always included (the baseline). */
export function codecsIn(capabilities: readonly CodecCapability[] | undefined): VideoCodec[] {
  const found = new Set((capabilities ?? []).map((c) => videoCodecOf(c.mimeType)));
  return WIRE_ORDER.filter((c) => c === 'vp8' || found.has(c));
}

/** What this browser can decode — sent with JoinRoom so others pick a codec we can play. */
export function decodableCodecs(): VideoCodec[] {
  return codecsIn(
    typeof RTCRtpReceiver !== 'undefined'
      ? RTCRtpReceiver.getCapabilities?.('video')?.codecs
      : undefined,
  );
}

/** What this browser can encode (the picker only offers these). */
export function encodableCodecs(): VideoCodec[] {
  return codecsIn(
    typeof RTCRtpSender !== 'undefined'
      ? RTCRtpSender.getCapabilities?.('video')?.codecs
      : undefined,
  );
}

/**
 * The codec to send: the chosen one if we can encode it and everyone else in the call can decode it, otherwise the
 * first fallback that works (VP9, then VP8).
 */
export function sendCodec(
  chosen: VideoCodec,
  encodable: readonly VideoCodec[],
  others: readonly (readonly string[])[],
): VideoCodec {
  const usable = (c: VideoCodec) =>
    c === 'vp8' || (encodable.includes(c) && others.every((decodes) => decodes.includes(c)));
  return [chosen, ...FALLBACKS].find(usable) ?? 'vp8';
}

/**
 * Codec preferences for a video transceiver: only `codec` (its baseline profile first) plus the helper entries
 * (rtx, red, ulpfec…). Other codecs are left out — we never switch codecs on a published track (see above), and a
 * codec the frame layout doesn't know would be dropped anyway. Empty when the browser doesn't offer `codec`.
 */
export function codecPreferences(
  capabilities: readonly CodecCapability[],
  codec: VideoCodec,
): CodecCapability[] {
  const chosen = capabilities
    .filter((c) => videoCodecOf(c.mimeType) === codec)
    .sort((a, b) => Number(!isBaselineProfile(a)) - Number(!isBaselineProfile(b)));
  if (!chosen.length) return [];
  const helpers = capabilities.filter((c) => /\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType));
  return [...chosen, ...helpers];
}

/**
 * Scalability mode for each simulcast layer: VP9 needs an explicit single-spatial-layer mode, or Chrome turns our
 * three encodings into one SVC stream that Cloudflare's rid-based layer selection can't use. Chrome doesn't list scalability modes in getCapabilities, so this is always asked for;
 * browsers that reject it get the encodings without it (MediaService).
 */
export function simulcastScalabilityMode(codec: VideoCodec): string | undefined {
  return codec === 'vp8' ? undefined : 'L1T3';
}

function isBaselineProfile(c: CodecCapability): boolean {
  return (
    !c.sdpFmtpLine ||
    /(profile-id|profile)=0(;|$)/.test(c.sdpFmtpLine) ||
    !/profile/.test(c.sdpFmtpLine)
  );
}
