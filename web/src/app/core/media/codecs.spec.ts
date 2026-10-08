import {
  CodecCapability,
  codecPreferences,
  codecsIn,
  sendCodec,
  simulcastScalabilityMode,
  videoCodecOf,
} from './codecs';

const cap = (mimeType: string, extra: Partial<CodecCapability> = {}): CodecCapability => ({
  mimeType,
  clockRate: 90000,
  ...extra,
});

const CHROME: CodecCapability[] = [
  cap('video/VP8', {}),
  cap('video/rtx'),
  cap('video/VP9', { sdpFmtpLine: 'profile-id=2' }),
  cap('video/VP9', { sdpFmtpLine: 'profile-id=0' }),
  cap('video/H264', { sdpFmtpLine: 'profile-level-id=42e01f' }),
  cap('video/AV1', { sdpFmtpLine: 'level-idx=5;profile=0;tier=0' }),
  cap('video/red'),
  cap('video/ulpfec'),
];

describe('video codecs', () => {
  it('names our codecs only (AV1 was removed)', () => {
    expect(videoCodecOf('video/VP9')).toBe('vp9');
    expect(videoCodecOf('video/vp8')).toBe('vp8');
    expect(videoCodecOf('video/AV1')).toBeUndefined();
    expect(videoCodecOf('video/H264')).toBeUndefined();
  });

  it('lists codecs in wire order, always with VP8, ignoring AV1', () => {
    expect(codecsIn(CHROME)).toEqual(['vp8', 'vp9']);
    expect(codecsIn([cap('video/AV1')])).toEqual(['vp8']);
    expect(codecsIn(undefined)).toEqual(['vp8']);
  });

  describe('sendCodec', () => {
    const both = ['vp8', 'vp9'] as const;

    it('uses the chosen codec when we encode it and everyone decodes it', () => {
      expect(sendCodec('vp9', both, [both, both])).toBe('vp9');
      expect(sendCodec('vp8', both, [both])).toBe('vp8');
      expect(sendCodec('vp9', both, [])).toBe('vp9'); // alone in the call
    });

    it('falls back to VP8 when someone can’t decode VP9', () => {
      expect(sendCodec('vp9', both, [both, ['vp8']])).toBe('vp8');
      expect(sendCodec('vp9', both, [['vp8', 'av1']])).toBe('vp8'); // an AV1 entry from anyone changes nothing
    });

    it('falls back when we can’t encode it', () => {
      expect(sendCodec('vp9', ['vp8'], [both])).toBe('vp8');
    });
  });

  it('prefers only the chosen codec (baseline profile first) plus rtx / red / ulpfec', () => {
    expect(
      codecPreferences(CHROME, 'vp9').map((c) => `${c.mimeType} ${c.sdpFmtpLine ?? ''}`.trim()),
    ).toEqual([
      'video/VP9 profile-id=0',
      'video/VP9 profile-id=2',
      'video/rtx',
      'video/red',
      'video/ulpfec',
    ]);
    expect(codecPreferences(CHROME, 'vp8')[0].mimeType).toBe('video/VP8');
    expect(codecPreferences([cap('video/VP8')], 'vp9')).toEqual([]);
  });

  it('asks for L1T3 simulcast layers for VP9, leaves VP8 alone', () => {
    expect(simulcastScalabilityMode('vp9')).toBe('L1T3');
    expect(simulcastScalabilityMode('vp8')).toBeUndefined();
  });
});
