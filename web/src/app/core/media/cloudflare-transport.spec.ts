import { FrameCrypto } from '../crypto/frame-transforms';
import { SignalingService } from '../signaling/signaling.service';
import { CloudflareRtcConfig, IdentityDto, ParticipantDto } from '../signaling/signaling.types';
import { CloudflareTransport } from './cloudflare-transport';
import { TransportEvents } from './media-transport';

/** The MediaTransport contract as MediaService relies on it; behaviour in depth is covered by media.service.spec. */

const identity: IdentityDto = { ed25519Pub: 'ed', x25519Pub: 'x', sig: 'sig' };

class FakePeerConnection {
  static last: FakePeerConnection;
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  ontrack?: (e: Partial<RTCTrackEvent>) => void;
  onconnectionstatechange?: () => void;
  closed = false;
  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.last = this;
  }
  getTransceivers() {
    return [];
  }
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'v=0 answer' };
  }
  async setLocalDescription() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
  }
}

const config: CloudflareRtcConfig = { provider: 'cloudflare', iceServers: [], forceRelay: true };

function bob(tracks: ParticipantDto['tracks']): ParticipantDto {
  return { id: 'bob', ticket: null, identity, videoCodecs: ['vp8'], tracks };
}

function setup() {
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  const events = {
    state: vi.fn(),
    remoteTrack: vi.fn(),
    subscribed: vi.fn(),
    dropped: vi.fn(),
    negotiationFailure: vi.fn(),
  } satisfies TransportEvents;
  const signaling = {
    subscribeTracks: vi.fn().mockResolvedValue({
      offerSdp: 'v=0 sfu offer',
      tracks: [{ participantId: 'bob', source: 'camera', mid: '6' }],
    }),
    renegotiate: vi.fn().mockResolvedValue(undefined),
    unsubscribeTracks: vi.fn().mockResolvedValue(undefined),
    selectVideoLayer: vi.fn().mockResolvedValue(undefined),
  };
  const frames = { peerConnectionConfig: {}, attachSender: vi.fn(), attachReceiver: vi.fn() };
  const transport = new CloudflareTransport(
    config,
    frames as unknown as FrameCrypto,
    signaling as unknown as SignalingService,
    events,
    () => [],
  );
  return { transport, events, signaling, frames, pc: FakePeerConnection.last };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('CloudflareTransport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports its state from the start and keeps the server’s relay setting', () => {
    const { transport, events, pc } = setup();
    expect(events.state).toHaveBeenCalledWith('connected'); // 'new': nothing negotiated yet
    expect(transport.forceRelay).toBe(true);
    expect(pc.config.iceTransportPolicy).toBe('relay');
  });

  it('subscribes to what the room publishes, tags receivers, then reports the tracks as subscribed', async () => {
    const { transport, events, frames, pc } = setup();
    transport.follow([bob([{ source: 'camera', kind: 'video', muted: false }])]);
    await settle();

    expect([...transport.subscribedKeys()]).toEqual(['bob:camera']);
    expect(events.subscribed).toHaveBeenCalledWith(['bob:camera']);

    const track = { kind: 'video' } as MediaStreamTrack;
    const receiver = {} as RTCRtpReceiver;
    pc.ontrack!({ transceiver: { mid: '6' } as RTCRtpTransceiver, receiver, track });
    expect(frames.attachReceiver).toHaveBeenCalledWith(receiver, 'video', 'bob');
    expect(events.remoteTrack).toHaveBeenCalledWith('bob:camera', track);
  });

  it('reports dropped tracks and unsubscribes them', async () => {
    const { transport, events, signaling } = setup();
    transport.follow([bob([{ source: 'camera', kind: 'video', muted: false }])]);
    await settle();

    transport.follow([]);
    await settle();

    expect(events.dropped).toHaveBeenCalledWith(['bob:camera']);
    expect(signaling.unsubscribeTracks).toHaveBeenCalledWith(['6']);
    expect([...transport.subscribedKeys()]).toEqual([]);
  });

  it('asks for a layer only once subscribed, and only when it changes', async () => {
    const { transport, signaling } = setup();
    await transport.setLayer('bob:camera', 'q');
    expect(signaling.selectVideoLayer).not.toHaveBeenCalled();

    transport.follow([bob([{ source: 'camera', kind: 'video', muted: false }])]);
    await settle();
    await transport.setLayer('bob:camera', 'f'); // subscriptions start at the full layer
    await transport.setLayer('bob:camera', 'q');
    await transport.setLayer('bob:camera', 'q');
    expect(signaling.selectVideoLayer.mock.calls).toEqual([['6', 'q']]);
  });

  it('is unusable after close: no stats, no publishing, no more subscriptions', async () => {
    const { transport, signaling, pc } = setup();
    transport.close();

    expect(pc.closed).toBe(true);
    expect(await transport.stats()).toBeUndefined();
    await expect(transport.publish([], 'vp8')).rejects.toThrow('Not connected.');
    transport.follow([bob([{ source: 'camera', kind: 'video', muted: false }])]);
    await settle();
    expect(signaling.subscribeTracks).not.toHaveBeenCalled();
  });
});
