import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SignalingService } from '../signaling/signaling.service';
import { IdentityDto, ParticipantDto, RtcConfig } from '../signaling/signaling.types';
import { CryptoService } from '../crypto/crypto.service';
import { FrameCrypto } from '../crypto/frame-transforms';
import { MediaService } from './media.service';

/** Public keys only; the shape is all these tests need. */
const identity: IdentityDto = { ed25519Pub: 'ed', x25519Pub: 'x', sig: 'sig' };

/** Just enough of RTCPeerConnection: transceivers get mids on setLocalDescription, like the real one. */
class FakePeerConnection {
  static last: FakePeerConnection;

  readonly transceivers: FakeTransceiver[] = [];
  localDescription?: RTCSessionDescriptionInit;
  remoteDescriptions: RTCSessionDescriptionInit[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  ontrack?: (e: Partial<RTCTrackEvent>) => void;
  onconnectionstatechange?: () => void;
  closed = false;

  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.last = this;
  }

  getTransceivers() {
    return this.transceivers;
  }

  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit) {
    const t = new FakeTransceiver(track, init);
    this.transceivers.push(t);
    return t;
  }

  readonly offers: (RTCOfferOptions | undefined)[] = [];

  async createOffer(options?: RTCOfferOptions) {
    this.offers.push(options);
    return { type: 'offer' as const, sdp: `v=0 offer ${this.transceivers.length}` };
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: 'v=0 answer' };
  }

  async setLocalDescription(d: RTCSessionDescriptionInit) {
    if (d.type === 'rollback') {
      this.signalingState = 'stable';
      return;
    }
    this.transceivers.forEach((t, i) => (t.mid ??= String(i)));
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescriptions.push(d);
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  stats = new Map<string, object>();

  async getStats() {
    return this.stats;
  }

  /** Simulates the network changing the connection state. */
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  close() {
    this.closed = true;
  }
}

class FakeTransceiver {
  mid: string | null = null;
  stopped = false;
  readonly sender = { replaceTrack: vi.fn().mockResolvedValue(undefined) };
  readonly setCodecPreferences = vi.fn();

  constructor(
    readonly track: MediaStreamTrack,
    readonly init: RTCRtpTransceiverInit,
  ) {}

  stop() {
    this.stopped = true;
  }
}

function fakeTrack(kind: 'audio' | 'video', label = '', height = 720, maxHeight = 1080) {
  return {
    kind,
    label,
    enabled: true,
    contentHint: '',
    stop: vi.fn(),
    getSettings: () => ({ deviceId: `${kind}-1`, height }),
    getCapabilities: () => ({ height: { max: maxHeight } }),
    addEventListener: vi.fn(),
  } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

const config: RtcConfig = { iceServers: [], forceRelay: false };

/** CryptoService's frame transforms: records what gets attached. */
function fakeFrames() {
  return {
    peerConnectionConfig: { encodedInsertableStreams: true },
    attachSender: vi.fn(),
    attachReceiver: vi.fn(),
    terminate: vi.fn(),
  };
}

/** Everyone counts as secured unless a test says otherwise. */
function fakeCrypto() {
  return {
    secured: signal<ReadonlySet<string>>(new Set(['bob'])),
    telemetry: vi.fn(() => ({
      framesEncrypted: 0,
      framesDecrypted: 0,
      framesFailed: 0,
      framesMissingKey: 0,
      envelopesDropped: 0,
      securingSeconds: 0,
    })),
  };
}

function bobWithCamera(): ParticipantDto {
  return {
    id: 'bob',
    displayName: 'Bob',
    identity,
    videoCodecs: ['vp8'],
    tracks: [{ source: 'camera', kind: 'video', muted: false }],
  };
}

function setup({ inCall = [] as ParticipantDto[] } = {}) {
  const participants = signal<ParticipantDto[]>(inCall);
  const signaling = {
    participants,
    publishTracks: vi.fn().mockResolvedValue('v=0 sfu answer'),
    subscribeTracks: vi.fn(),
    renegotiate: vi.fn().mockResolvedValue(undefined),
    unsubscribeTracks: vi.fn().mockResolvedValue(undefined),
    setTrackMuted: vi.fn().mockResolvedValue(undefined),
    selectVideoLayer: vi.fn().mockResolvedValue(undefined),
    restartIce: vi.fn().mockResolvedValue('v=0 restart answer'),
    reportCallStats: vi.fn().mockResolvedValue(undefined),
  };
  const mic = fakeTrack('audio');
  const camera = fakeTrack('video', 'FaceTime HD Camera');
  const devices = {
    getUserMedia: vi.fn(async (c: MediaStreamConstraints) => ({
      getAudioTracks: () => [mic],
      getVideoTracks: () => [c.video ? camera : undefined],
    })),
    getDisplayMedia: vi.fn(),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  };
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: devices });

  const frames = fakeFrames();
  const crypto = fakeCrypto();
  TestBed.configureTestingModule({
    providers: [
      MediaService,
      { provide: SignalingService, useValue: signaling },
      { provide: CryptoService, useValue: crypto },
    ],
  });
  const media = TestBed.inject(MediaService);
  media.connect(config, { id: 'me', displayName: 'Alex' }, frames as unknown as FrameCrypto);
  media.startReceiving();
  return {
    media,
    signaling,
    participants,
    mic,
    camera,
    pc: FakePeerConnection.last,
    frames,
    crypto,
  };
}

/** Lets effects run and queued negotiations settle. */
async function settle() {
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('MediaService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('publishes a device on first use: offer → SFU → answer', async () => {
    const { media, signaling, pc } = setup();

    await media.setMicrophone(true);

    expect(signaling.publishTracks).toHaveBeenCalledWith('v=0 offer 1', [
      { mid: '0', source: 'microphone' },
    ]);
    expect(pc.remoteDescriptions).toEqual([{ type: 'answer', sdp: 'v=0 sfu answer' }]);
    expect(media.micEnabled()).toBe(true);
  });

  it('publishes the camera with three simulcast layers', async () => {
    const { media, pc } = setup();

    await media.setCamera(true);

    expect(pc.transceivers[0].init.sendEncodings?.map((e) => e.rid)).toEqual(['f', 'h', 'q']);
    expect(media.tiles()[0].video).toBeDefined();
  });

  it('mutes without renegotiating', async () => {
    const { media, signaling, mic } = setup();
    await media.setMicrophone(true);

    await media.setMicrophone(false);

    expect(mic.enabled).toBe(false);
    expect(signaling.setTrackMuted).toHaveBeenCalledWith('microphone', true);
    expect(signaling.publishTracks).toHaveBeenCalledTimes(1);
    expect(media.tiles()[0].micMuted).toBe(true);
  });

  it('turning the camera off releases it and keeps the published track', async () => {
    const { media, signaling, camera, pc } = setup();
    await media.setCamera(true);

    await media.setCamera(false);

    expect(camera.stop).toHaveBeenCalled();
    expect(pc.transceivers[0].sender.replaceTrack).toHaveBeenCalled();
    expect(pc.transceivers[0].stopped).toBe(false);
    expect(signaling.setTrackMuted).toHaveBeenCalledWith('camera', true);
    expect(media.tiles()[0].video).toBeUndefined();

    await media.setCamera(true);
    expect(signaling.publishTracks).toHaveBeenCalledTimes(1);
    expect(signaling.setTrackMuted).toHaveBeenLastCalledWith('camera', false);
  });

  it('a failed publish rolls back so later negotiations still work', async () => {
    const { media, signaling, pc, mic } = setup();
    signaling.publishTracks.mockRejectedValueOnce(new Error('Media server unavailable.'));

    await expect(media.setMicrophone(true)).rejects.toThrow('Media server unavailable.');

    expect(pc.signalingState).toBe('stable');
    expect(pc.transceivers[0].stopped).toBe(true);
    expect(mic.stop).toHaveBeenCalled();
    expect(media.micEnabled()).toBe(false);
  });

  it('pulls tracks others publish, answers the SFU offer and shows them', async () => {
    const { media, signaling, participants, pc } = setup();
    signaling.subscribeTracks.mockResolvedValue({
      offerSdp: 'v=0 sfu offer',
      tracks: [
        { participantId: 'bob', source: 'microphone', mid: '5' },
        { participantId: 'bob', source: 'camera', mid: '6' },
      ],
    });

    participants.set([
      {
        id: 'bob',
        displayName: 'Bob',
        identity,
        videoCodecs: ['vp8'],
        tracks: [
          { source: 'microphone', kind: 'audio', muted: false },
          { source: 'camera', kind: 'video', muted: false },
        ],
      },
    ]);
    await settle();

    expect(signaling.subscribeTracks).toHaveBeenCalledWith([
      { participantId: 'bob', source: 'microphone' },
      { participantId: 'bob', source: 'camera' },
    ]);
    expect(pc.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'v=0 sfu offer' }]);
    expect(signaling.renegotiate).toHaveBeenCalledWith('v=0 answer');

    const bobVideo = fakeTrack('video');
    pc.ontrack!({ transceiver: { mid: '6' } as RTCRtpTransceiver, track: bobVideo });
    const bobTile = media.tiles().find((t) => t.key === 'bob:camera')!;
    expect(bobTile.video).toBe(bobVideo);
    expect(bobTile.micMuted).toBe(false);
    expect(media.participants().map((p) => p.name)).toEqual(['Alex', 'Bob']);
  });

  it('drops tracks of participants who leave', async () => {
    const { media, signaling, participants } = setup();
    signaling.subscribeTracks.mockResolvedValue({
      offerSdp: null,
      tracks: [{ participantId: 'bob', source: 'camera', mid: '6' }],
    });
    participants.set([
      {
        id: 'bob',
        displayName: 'Bob',
        identity,
        videoCodecs: ['vp8'],
        tracks: [{ source: 'camera', kind: 'video', muted: false }],
      },
    ]);
    await settle();

    participants.set([]);
    await settle();

    expect(signaling.unsubscribeTracks).toHaveBeenCalledWith(['6']);
    expect(media.tiles().map((t) => t.key)).toEqual(['me:camera']);
  });

  it('disconnect closes the connection and stops capture', async () => {
    const { media, pc, mic } = setup();
    await media.setMicrophone(true);

    await media.disconnect();

    expect(pc.closed).toBe(true);
    expect(mic.stop).toHaveBeenCalled();
    expect(media.tiles()).toEqual([]);
    expect(media.state()).toBe('disconnected');
  });

  describe('quality and recovery', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function withBobsCamera() {
      const ctx = setup();
      ctx.signaling.subscribeTracks.mockResolvedValue({
        offerSdp: null,
        tracks: [{ participantId: 'bob', source: 'camera', mid: '6' }],
      });
      ctx.participants.set([
        {
          id: 'bob',
          displayName: 'Bob',
          identity,
          videoCodecs: ['vp8'],
          tracks: [{ source: 'camera', kind: 'video', muted: false }],
        },
      ]);
      await settle();
      return ctx;
    }

    it('receives the highest layer by default and the smallest only off screen', async () => {
      const { media, signaling } = await withBobsCamera();

      // On screen, any size: the full layer we subscribed with — nothing to send.
      media.setTileSize('bob:camera', 160);
      await vi.advanceTimersByTimeAsync(500);
      expect(signaling.selectVideoLayer).not.toHaveBeenCalled();

      media.setTileSize('bob:camera', 0);
      media.setTileSize('me:camera', 0);
      await vi.advanceTimersByTimeAsync(500);
      expect(signaling.selectVideoLayer).toHaveBeenCalledTimes(1);
      expect(signaling.selectVideoLayer).toHaveBeenCalledWith('6', 'q');

      media.setTileSize('bob:camera', 640);
      await vi.advanceTimersByTimeAsync(500);
      expect(signaling.selectVideoLayer).toHaveBeenLastCalledWith('6', 'f');
    });

    it('drops to the smallest layer while the tab is hidden', async () => {
      const { signaling } = await withBobsCamera();

      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(500);

      expect(signaling.selectVideoLayer).toHaveBeenLastCalledWith('6', 'q');
    });

    it('marks speaking participants from audio levels', async () => {
      const { media, signaling, participants, pc } = setup();
      signaling.subscribeTracks.mockResolvedValue({
        offerSdp: null,
        tracks: [{ participantId: 'bob', source: 'microphone', mid: '5' }],
      });
      participants.set([
        {
          id: 'bob',
          displayName: 'Bob',
          identity,
          videoCodecs: ['vp8'],
          tracks: [{ source: 'microphone', kind: 'audio', muted: false }],
        },
      ]);
      await settle();
      pc.ontrack!({
        transceiver: { mid: '5' } as RTCRtpTransceiver,
        track: { id: 'bob-mic' } as MediaStreamTrack,
      });

      pc.stats.set('in', {
        type: 'inbound-rtp',
        kind: 'audio',
        trackIdentifier: 'bob-mic',
        audioLevel: 0.3,
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(media.participants().find((p) => p.identity === 'bob')!.isSpeaking).toBe(true);
      expect(media.tiles().find((t) => t.key === 'bob:camera')!.isSpeaking).toBe(true);

      pc.stats.set('in', {
        type: 'inbound-rtp',
        kind: 'audio',
        trackIdentifier: 'bob-mic',
        audioLevel: 0,
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(media.participants().find((p) => p.identity === 'bob')!.isSpeaking).toBe(false);
    });

    it('restarts ICE when the connection fails and recovers', async () => {
      const { media, signaling, pc } = setup();

      pc.setConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(media.state()).toBe('reconnecting');
      expect(pc.offers.at(-1)).toEqual({ iceRestart: true });
      expect(signaling.restartIce).toHaveBeenCalledWith('v=0 offer 0');
      expect(pc.remoteDescriptions.at(-1)).toEqual({ type: 'answer', sdp: 'v=0 restart answer' });

      pc.setConnectionState('connected');
      expect(media.state()).toBe('connected');
    });

    it('waits briefly before restarting after a short disconnect', async () => {
      const { signaling, pc } = setup();

      pc.setConnectionState('disconnected');
      await vi.advanceTimersByTimeAsync(1000);
      pc.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(5000);

      expect(signaling.restartIce).not.toHaveBeenCalled();
    });

    it('gives up after two restarts so the room can rejoin', async () => {
      const { media, signaling, pc } = setup();

      pc.setConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(signaling.restartIce).toHaveBeenCalledTimes(2);
      expect(media.state()).toBe('disconnected');
    });

    it('a rejected restart ends the call state as disconnected', async () => {
      const { media, signaling, pc } = setup();
      signaling.restartIce.mockRejectedValue(new Error('No media session.'));

      pc.setConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(media.state()).toBe('disconnected');
      expect(pc.signalingState).toBe('stable');
    });
  });

  describe('camera quality', () => {
    beforeEach(() => localStorage.removeItem('cipheroom.videoQuality'));

    it('captures the best the camera has (up to 4K) by default, with bitrates for that resolution', async () => {
      const { media, pc } = setup();
      const devices = navigator.mediaDevices as unknown as {
        getUserMedia: ReturnType<typeof vi.fn>;
      };

      await media.setCamera(true);

      expect(media.videoQuality()).toBe('auto');
      expect(devices.getUserMedia).toHaveBeenCalledWith({
        video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
      });
      // The fake camera delivered 720p.
      expect(pc.transceivers[0].init.sendEncodings?.map((e) => e.maxBitrate)).toEqual([
        1_500_000, 500_000, 200_000,
      ]);
      // It can do 1080p but not 4K.
      expect(media.availableQualities()).toEqual(['auto', '1080p', '720p']);
    });

    it('changing quality re-captures the same camera in place and is remembered', async () => {
      const { media, signaling, pc, camera } = setup();
      const devices = navigator.mediaDevices as unknown as {
        getUserMedia: ReturnType<typeof vi.fn>;
      };
      await media.setCamera(true);

      await media.setVideoQuality('1080p');

      expect(devices.getUserMedia).toHaveBeenLastCalledWith({
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30 },
          deviceId: { exact: 'video-1' },
        },
      });
      expect(camera.stop).toHaveBeenCalled();
      expect(pc.transceivers[0].sender.replaceTrack).toHaveBeenCalled();
      expect(signaling.publishTracks).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('cipheroom.videoQuality')).toBe('1080p');
    });

    it('with the camera off, a new quality applies the next time it turns on', async () => {
      const { media } = setup();
      const devices = navigator.mediaDevices as unknown as {
        getUserMedia: ReturnType<typeof vi.fn>;
      };

      await media.setVideoQuality('720p');
      expect(devices.getUserMedia).not.toHaveBeenCalled();

      await media.setCamera(true);
      expect(devices.getUserMedia).toHaveBeenLastCalledWith({
        video: expect.objectContaining({ height: { ideal: 720, max: 720 } }),
      });
    });
  });

  describe('pull retries', () => {
    afterEach(() => vi.useRealTimers());

    const bob: ParticipantDto = {
      id: 'bob',
      displayName: 'Bob',
      identity,
      videoCodecs: ['vp8'],
      tracks: [
        { source: 'microphone', kind: 'audio', muted: false },
        { source: 'camera', kind: 'video', muted: false },
      ],
    };

    it('answers the SFU offer for the tracks it got and retries the ones it left out', async () => {
      const { signaling, participants, pc } = setup();
      vi.useFakeTimers();
      signaling.subscribeTracks
        .mockResolvedValueOnce({
          offerSdp: 'v=0 sfu offer',
          tracks: [{ participantId: 'bob', source: 'microphone', mid: '5' }],
        })
        .mockResolvedValueOnce({
          offerSdp: 'v=0 sfu offer 2',
          tracks: [{ participantId: 'bob', source: 'camera', mid: '6' }],
        });

      participants.set([bob]);
      await settle();

      expect(pc.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'v=0 sfu offer' }]);
      expect(signaling.renegotiate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(signaling.subscribeTracks).toHaveBeenLastCalledWith([
        { participantId: 'bob', source: 'camera' },
      ]);
      expect(signaling.renegotiate).toHaveBeenCalledTimes(2);
    });

    it('retries a failed request with growing delays and stops once the publisher is gone', async () => {
      const { signaling, participants } = setup();
      vi.useFakeTimers();
      signaling.subscribeTracks.mockRejectedValue(new Error('Media server unavailable.'));

      participants.set([bob]);
      await settle();
      expect(signaling.subscribeTracks).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(signaling.subscribeTracks).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(signaling.subscribeTracks).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(signaling.subscribeTracks).toHaveBeenCalledTimes(3);

      participants.set([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signaling.subscribeTracks).toHaveBeenCalledTimes(3);
    });
  });

  describe('negotiation order', () => {
    it('does not pull anyone else before startReceiving', async () => {
      const participants = signal<ParticipantDto[]>([
        {
          id: 'bob',
          displayName: 'Bob',
          identity,
          videoCodecs: ['vp8'],
          tracks: [{ source: 'camera', kind: 'video', muted: false }],
        },
      ]);
      const signaling = {
        participants,
        subscribeTracks: vi.fn().mockResolvedValue({ offerSdp: null, tracks: [] }),
      };
      vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
      TestBed.configureTestingModule({
        providers: [
          MediaService,
          { provide: SignalingService, useValue: signaling },
          { provide: CryptoService, useValue: fakeCrypto() },
        ],
      });
      const media = TestBed.inject(MediaService);

      media.connect(
        config,
        { id: 'me', displayName: 'Alex' },
        fakeFrames() as unknown as FrameCrypto,
      );
      await settle();
      expect(signaling.subscribeTracks).not.toHaveBeenCalled();

      media.startReceiving();
      await settle();
      expect(signaling.subscribeTracks).toHaveBeenCalledOnce();
    });

    it('reserves the camera with muted placeholder frames; turning it on later is a track swap', async () => {
      const placeholder = fakeTrack('video', '', 180);
      // jsdom has no canvas capture: provide one for the placeholder.
      Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
        configurable: true,
        value: () => ({ getVideoTracks: () => [placeholder] }),
      });
      onTestFinished(() => {
        delete (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream;
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
      const { media, signaling, pc } = setup();

      await media.reserveCamera();

      expect(signaling.publishTracks).toHaveBeenCalledWith('v=0 offer 1', [
        { mid: '0', source: 'camera' },
      ]);
      expect(signaling.setTrackMuted).toHaveBeenCalledWith('camera', true);
      expect(media.cameraEnabled()).toBe(false);
      expect(media.tiles()[0].video).toBeUndefined();

      await media.setCamera(true);

      expect(signaling.publishTracks).toHaveBeenCalledOnce();
      expect(pc.transceivers[0].sender.replaceTrack).toHaveBeenCalled();
      expect(placeholder.stop).toHaveBeenCalled();
      expect(signaling.setTrackMuted).toHaveBeenLastCalledWith('camera', false);
      expect(media.cameraEnabled()).toBe(true);

      // Already reserved / published: nothing to do.
      await media.reserveCamera();
      expect(signaling.publishTracks).toHaveBeenCalledOnce();
    });
  });

  describe('call-quality reports', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends what changed every 15 s — numbers only', async () => {
      const { signaling, pc, crypto } = setup();
      let received = 0;
      vi.spyOn(pc, 'getStats').mockImplementation(async () => {
        received += 100_000;
        return new Map([
          [
            'in-v',
            {
              id: 'in-v',
              type: 'inbound-rtp',
              kind: 'video',
              bytesReceived: received,
              packetsReceived: received / 1000,
              packetsLost: 0,
            },
          ],
        ]);
      });
      crypto.telemetry
        .mockReturnValueOnce({
          framesEncrypted: 0,
          framesDecrypted: 0,
          framesFailed: 0,
          framesMissingKey: 0,
          envelopesDropped: 0,
          securingSeconds: 0,
        })
        .mockReturnValueOnce({
          framesEncrypted: 500,
          framesDecrypted: 900,
          framesFailed: 0,
          framesMissingKey: 3,
          envelopesDropped: 0,
          securingSeconds: 0.5,
        });

      await vi.advanceTimersByTimeAsync(250 * 2); // baseline
      expect(signaling.reportCallStats).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250 * 60); // one interval later

      expect(signaling.reportCallStats).toHaveBeenCalledOnce();
      const [stats] = signaling.reportCallStats.mock.calls[0];
      expect(stats.intervalSeconds).toBeCloseTo(15, 0);
      expect(stats.videoReceived.bytes).toBe(6_000_000);
      expect(stats.e2ee).toMatchObject({
        framesEncrypted: 500,
        framesMissingKey: 3,
        securingSeconds: 0.5,
      });
    });

    it('stops reporting when the call ends', async () => {
      const { media, signaling } = setup();
      await media.disconnect();
      await vi.advanceTimersByTimeAsync(250 * 200);
      expect(signaling.reportCallStats).not.toHaveBeenCalled();
    });
  });

  describe('end-to-end encryption', () => {
    it('opens the connection with the frame transforms’ settings', () => {
      const { pc, frames } = setup();
      expect(pc.config).toMatchObject(frames.peerConnectionConfig);
    });

    it('encrypts every sender from its first frame', async () => {
      const { media, pc, frames } = setup();
      await media.setMicrophone(true);
      await media.setCamera(true);

      // No codec capabilities in this test environment: VP8, the baseline.
      expect(frames.attachSender.mock.calls).toEqual([
        [pc.transceivers[0].sender, 'audio', undefined],
        [pc.transceivers[1].sender, 'video', 'vp8'],
      ]);
    });

    it('never publishes without frame transforms', async () => {
      const { media, signaling } = setup();
      await media.disconnect();
      await expect(media.setMicrophone(true)).rejects.toThrow();
      expect(signaling.publishTracks).not.toHaveBeenCalled();
    });

    it('decrypts every receiver with the keys of the participant it carries', async () => {
      const { signaling, participants, pc, frames } = setup();
      signaling.subscribeTracks.mockResolvedValue({
        offerSdp: 'v=0 sfu offer',
        tracks: [{ participantId: 'bob', source: 'camera', mid: '6' }],
      });
      participants.set([bobWithCamera()]);
      await settle();

      const receiver = {} as RTCRtpReceiver;
      pc.ontrack!({
        transceiver: { mid: '6' } as RTCRtpTransceiver,
        receiver,
        track: fakeTrack('video'),
      });
      expect(frames.attachReceiver).toHaveBeenCalledWith(receiver, 'video', 'bob');
    });

    it('shows remote tiles as securing until that participant’s key arrived', async () => {
      const { media, participants, crypto } = setup();
      crypto.secured.set(new Set());
      participants.set([bobWithCamera()]);
      expect(media.tiles().find((t) => t.key === 'bob:camera')?.securing).toBe(true);
      expect(media.tiles().find((t) => t.isLocal)?.securing).toBe(false);

      crypto.secured.set(new Set(['bob']));
      expect(media.tiles().find((t) => t.key === 'bob:camera')?.securing).toBe(false);
    });

    it('leaves the worker to CryptoService when the call ends', async () => {
      const { media, frames } = setup();
      await media.disconnect();
      expect(frames.terminate).not.toHaveBeenCalled();
    });
  });

  describe('video codec', () => {
    const capabilities = {
      codecs: [
        { mimeType: 'video/VP8', clockRate: 90000 },
        { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
        { mimeType: 'video/AV1', clockRate: 90000 },
        { mimeType: 'video/rtx', clockRate: 90000 },
      ],
    };
    const decodes = (...videoCodecs: string[]): ParticipantDto => ({
      ...bobWithCamera(),
      videoCodecs,
    });

    beforeEach(() => {
      localStorage.removeItem('cipheroom.videoCodec');
      vi.stubGlobal('RTCRtpSender', { getCapabilities: () => capabilities });
      vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => capabilities });
    });

    it('sends VP9 by default, offering every codec this browser can send', () => {
      const { media } = setup();
      expect(media.videoCodec()).toBe('vp9');
      expect(media.sendingCodec()).toBe('vp9');
      expect(media.availableCodecs).toEqual(['vp9', 'av1', 'vp8']);
      expect(media.decodableCodecs).toEqual(['vp8', 'vp9', 'av1']);
    });

    it('negotiates only the sending codec, with L1T3 simulcast layers and matching bitrates', async () => {
      const { media, pc, frames } = setup();
      await media.setCamera(true);

      const camera = pc.transceivers[0];
      expect(camera.setCodecPreferences).toHaveBeenCalledWith([
        capabilities.codecs[1],
        capabilities.codecs[3],
      ]);
      expect(
        camera.init.sendEncodings!.map((e) => [
          e.rid,
          e.maxBitrate,
          (e as { scalabilityMode?: string }).scalabilityMode,
        ]),
      ).toEqual([
        ['f', 975_000, 'L1T3'],
        ['h', 325_000, 'L1T3'],
        ['q', 130_000, 'L1T3'],
      ]);
      expect(frames.attachSender).toHaveBeenCalledWith(camera.sender, 'video', 'vp9');
    });

    it('sends the simulcast layers without a scalability mode where the browser rejects it', async () => {
      const { media, pc } = setup();
      const add = pc.addTransceiver.bind(pc);
      vi.spyOn(pc, 'addTransceiver').mockImplementation((track, init) => {
        if (init.sendEncodings?.some((e) => 'scalabilityMode' in e))
          throw new DOMException('unsupported', 'OperationError');
        return add(track, init);
      });
      await media.setCamera(true);

      expect(pc.transceivers).toHaveLength(1);
      expect(pc.transceivers[0].init.sendEncodings!.map((e) => e.rid)).toEqual(['f', 'h', 'q']);
    });

    it('falls back to a codec everyone already in the call can decode', () => {
      localStorage.setItem('cipheroom.videoCodec', 'av1');
      const { media } = setup({ inCall: [decodes('vp8', 'vp9')] });
      expect(media.videoCodec()).toBe('av1');
      expect(media.sendingCodec()).toBe('vp9');
    });

    it('asks for a rejoin when someone joins who can’t decode what we send', () => {
      localStorage.setItem('cipheroom.videoCodec', 'av1');
      const { media, participants } = setup();
      expect(media.codecUnsupported()).toBe(false);

      participants.set([decodes('vp8', 'vp9', 'av1')]);
      expect(media.codecUnsupported()).toBe(false);
      participants.set([decodes('vp8', 'vp9')]);
      expect(media.codecUnsupported()).toBe(true);
    });

    it('remembers a new codec and says whether it needs a rejoin', () => {
      const { media } = setup({ inCall: [decodes('vp8', 'vp9')] });
      expect(media.setVideoCodec('vp8')).toBe(true);
      expect(localStorage.getItem('cipheroom.videoCodec')).toBe('vp8');
      expect(media.setVideoCodec('vp9')).toBe(false); // still what we send
      expect(media.setVideoCodec('av1')).toBe(false); // Bob can't play it: we'd still send VP9
    });
  });
});
