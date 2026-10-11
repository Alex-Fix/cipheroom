import { sdpCodecs } from './sdp-codecs';

describe('sdpCodecs', () => {
  it('keeps only mids, kinds and codec names', () => {
    const sdp = [
      'v=0',
      'o=- 1 2 IN IP4 203.0.113.9',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:0',
      'a=ice-pwd:secretpassword',
      'a=rtpmap:111 opus/48000/2',
      'm=video 9 UDP/TLS/RTP/SAVPF 98 96 99',
      'c=IN IP4 203.0.113.9',
      'a=mid:3',
      'a=fingerprint:sha-256 AB:CD',
      'a=rtpmap:98 VP9/90000',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:99 rtx/90000',
      '',
    ].join('\r\n');
    const summary = sdpCodecs(sdp);
    expect(summary).toBe('0:audio[opus] 3:video[VP9,VP8]');
    expect(summary).not.toContain('203.0.113.9');
    expect(summary).not.toContain('secret');
  });

  it('replaces anything unexpected and handles empty input', () => {
    expect(sdpCodecs(undefined)).toBe('none');
    expect(sdpCodecs('v=0')).toBe('none');
    expect(sdpCodecs('v=0\nm=video 9 X 96\na=mid:1 10.0.0.1\na=rtpmap:96 <b>/90000')).toBe(
      '?:video[?]',
    );
  });

  it('is bounded', () => {
    const sdp =
      'v=0' +
      Array.from(
        { length: 200 },
        (_, i) => `\nm=video 9 X 96\na=mid:${i}\na=rtpmap:96 VP8/90000`,
      ).join('');
    const summary = sdpCodecs(sdp);
    expect(summary.length).toBeLessThanOrEqual(1025);
    expect(summary).not.toContain('64:video');
  });
});
