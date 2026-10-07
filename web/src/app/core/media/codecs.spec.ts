import { cameraCodecOrder } from './codecs';

const vp8 = { mimeType: 'video/VP8' };
const rtx = { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' };
const vp9 = { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' };
const h264High = {
  mimeType: 'video/H264',
  sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
};
const h264Baseline = {
  mimeType: 'video/H264',
  sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
};
const h264Mode0 = {
  mimeType: 'video/H264',
  sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
};

describe('cameraCodecOrder', () => {
  it('puts constrained-baseline H.264 first, other H.264 next, then VP8, then the rest', () => {
    const order = cameraCodecOrder([vp8, rtx, vp9, h264Mode0, h264High, h264Baseline], true);
    expect(order).toEqual([h264Baseline, h264High, h264Mode0, vp8, rtx, vp9]);
  });

  it('leads with VP8 when the browser cannot send H.264', () => {
    const order = cameraCodecOrder([h264Baseline, vp9, vp8, rtx], false);
    expect(order).toEqual([vp8, h264Baseline, vp9, rtx]);
  });

  it('keeps every codec', () => {
    const input = [vp8, rtx, vp9, h264Baseline];
    expect(cameraCodecOrder(input, true)).toHaveLength(input.length);
  });
});
