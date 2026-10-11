/**
 * What a session description negotiates, reduced to what is safe to put in the Connection report: each media
 * section's mid, kind and codec names (`0:audio[opus] 1:video[VP9,VP8]`). Nothing else leaves the SDP — no payload
 * types, fmtp, addresses, ICE credentials or fingerprints; anything that doesn't look like a mid or codec name
 * becomes `?`. Same format as the api's log (SdpCodecs.cs).
 */
export function sdpCodecs(sdp: string | undefined | null): string {
  if (!sdp) return 'none';
  const sections = sdp
    .split('\nm=')
    .slice(1, MAX_SECTIONS + 1)
    .map((section) => {
      const lines = section.split('\n').map((l) => l.replace(/\r$/, ''));
      const kind = safe(lines[0].split(' ')[0]);
      const mid = safe(lines.find((l) => l.startsWith('a=mid:'))?.slice(6));
      const codecs = new Set(
        lines
          .filter((l) => l.startsWith('a=rtpmap:'))
          .map((l) => safe(l.split(' ')[1]?.split('/')[0]))
          .filter((c) => !HELPER.test(c)),
      );
      return `${mid}:${kind}[${[...codecs].join(',')}]`;
    });
  const summary = sections.length ? sections.join(' ') : 'none';
  return summary.length <= MAX_LENGTH ? summary : `${summary.slice(0, MAX_LENGTH)}…`;
}

const MAX_SECTIONS = 64;
const MAX_LENGTH = 1024;
const TOKEN = /^[A-Za-z0-9_-]{1,32}$/;
/** Retransmission and error-correction entries say nothing about which codec is missing. */
const HELPER = /^(rtx|red|ulpfec|flexfec-03)$/i;

function safe(value: string | undefined): string {
  return value !== undefined && TOKEN.test(value) ? value : '?';
}
