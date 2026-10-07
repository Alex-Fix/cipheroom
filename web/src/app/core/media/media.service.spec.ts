import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SignalingService } from '../signaling/signaling.service';
import { ParticipantDto, RtcConfig } from '../signaling/signaling.types';
import { MediaService } from './media.service';

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

  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit) {
    const t = new FakeTransceiver(track, init);
    this.transceivers.push(t);
    return t;
  }

  async createOffer() {
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

  async getStats() {
    return new Map();
  }

  close() {
    this.closed = true;
  }
}

class FakeTransceiver {
  mid: string | null = null;
  stopped = false;
  readonly sender = { replaceTrack: vi.fn().mockResolvedValue(undefined) };

  constructor(
    readonly track: MediaStreamTrack,
    readonly init: RTCRtpTransceiverInit,
  ) {}

  stop() {
    this.stopped = true;
  }
}

function fakeTrack(kind: 'audio' | 'video', label = '') {
  return {
    kind,
    label,
    enabled: true,
    contentHint: '',
    stop: vi.fn(),
    getSettings: () => ({ deviceId: `${kind}-1` }),
    addEventListener: vi.fn(),
  } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

const config: RtcConfig = { livekitUrl: '', token: '', iceServers: [], forceRelay: false };

function setup() {
  const participants = signal<ParticipantDto[]>([]);
  const signaling = {
    participants,
    publishTracks: vi.fn().mockResolvedValue('v=0 sfu answer'),
    subscribeTracks: vi.fn(),
    renegotiate: vi.fn().mockResolvedValue(undefined),
    unsubscribeTracks: vi.fn().mockResolvedValue(undefined),
    setTrackMuted: vi.fn().mockResolvedValue(undefined),
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

  TestBed.configureTestingModule({
    providers: [MediaService, { provide: SignalingService, useValue: signaling }],
  });
  const media = TestBed.inject(MediaService);
  media.connect(config, { id: 'me', displayName: 'Alex' });
  return { media, signaling, participants, mic, camera, pc: FakePeerConnection.last };
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
});
