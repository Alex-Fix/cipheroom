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
  it('names our codecs only', () => {
    expect(videoCodecOf('video/VP9')).toBe('vp9');
    expect(videoCodecOf('video/av1')).toBe('av1');
    expect(videoCodecOf('video/H264')).toBeUndefined();
  });

  it('lists codecs in wire order, always with VP8', () => {
    expect(codecsIn(CHROME)).toEqual(['vp8', 'vp9', 'av1']);
    expect(codecsIn([cap('video/VP9')])).toEqual(['vp8', 'vp9']);
    expect(codecsIn(undefined)).toEqual(['vp8']);
  });

  describe('sendCodec', () => {
    const all = ['vp8', 'vp9', 'av1'] as const;

    it('uses the chosen codec when we encode it and everyone decodes it', () => {
      expect(sendCodec('av1', all, [all, all])).toBe('av1');
      expect(sendCodec('vp8', all, [all])).toBe('vp8');
      expect(sendCodec('av1', all, [])).toBe('av1'); // alone in the call
    });

    it('falls back to VP9, then VP8, when someone can’t decode it', () => {
      expect(sendCodec('av1', all, [all, ['vp8', 'vp9']])).toBe('vp9');
      expect(sendCodec('av1', all, [['vp8']])).toBe('vp8');
      expect(sendCodec('vp9', all, [['vp8', 'av1']])).toBe('vp8');
    });

    it('falls back when we can’t encode it', () => {
      expect(sendCodec('av1', ['vp8', 'vp9'], [all])).toBe('vp9');
      expect(sendCodec('vp9', ['vp8'], [all])).toBe('vp8');
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
    expect(codecPreferences(CHROME, 'av1')[0].mimeType).toBe('video/AV1');
    expect(codecPreferences([cap('video/VP8')], 'av1')).toEqual([]);
  });

  it('asks for L1T3 simulcast layers for VP9 and AV1, leaves VP8 alone', () => {
    expect(simulcastScalabilityMode('vp9')).toBe('L1T3');
    expect(simulcastScalabilityMode('av1')).toBe('L1T3');
    expect(simulcastScalabilityMode('vp8')).toBeUndefined();
  });
});
