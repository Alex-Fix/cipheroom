import { FrameCrypto } from '../crypto/frame-transforms';
import { SignalingService } from '../signaling/signaling.service';
import { IdentityDto, LiveKitRtcConfig, ParticipantDto } from '../signaling/signaling.types';
import { LiveKitFileChannel, LiveKitTransport, PeerConnectionHost, loadLiveKit, setLiveKitLoader } from './livekit-transport';
import { TransportEvents } from './media-transport';
import { RELAY_TOKEN, RELAY_URL, WebSocketHost } from './relay-websocket';

const identity: IdentityDto = { ed25519Pub: 'ed', x25519Pub: 'x', sig: 'sig' };
const config: LiveKitRtcConfig = { provider: 'livekit', iceServers: [], forceRelay: false };

class Emitter {
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }
}

class FakeLocalTrack {
  sender?: object;
  isMuted = false;
  readonly replaceTrack = vi.fn().mockResolvedValue(this);
  readonly mute = vi.fn(async () => ((this.isMuted = true), this));
  readonly unmute = vi.fn(async () => ((this.isMuted = false), this));
  constructor(
    readonly kind: 'audio' | 'video',
    readonly mediaStreamTrack: MediaStreamTrack,
  ) {}
}

class FakeLocalParticipant extends Emitter {
  /** Order of what happened, to prove the transform comes before negotiation finishes. */
  readonly log: string[] = [];
  readonly publishTrack = vi.fn(async (track: FakeLocalTrack, options: object) => {
    track.sender = { kind: track.kind };
    this.emit('localSenderCreated', track.sender, track);
    this.log.push(`negotiated ${track.kind}`);
    return { track, options };
  });
  readonly unpublishTrack = vi.fn().mockResolvedValue(undefined);
  readonly publishData = vi.fn().mockResolvedValue(undefined);
}

class FakePublication {
  isDesired = false;
  isSubscribed = false;
  readonly setSubscribed = vi.fn((v: boolean) => (this.isDesired = v));
  readonly setVideoQuality = vi.fn();
  constructor(readonly source: string) {}
}

class FakeRoom extends Emitter {
  static last: FakeRoom;
  readonly localParticipant = new FakeLocalParticipant();
  readonly remoteParticipants = new Map<string, { identity: string; trackPublications: Map<string, FakePublication> }>();
  readonly connect = vi.fn().mockResolvedValue(undefined);
  readonly disconnect = vi.fn().mockResolvedValue(undefined);
  readonly engine = {
    pcManager: {
      publisher: { getStats: vi.fn(async () => new Map([['out', { type: 'outbound-rtp' }]])), getTransceivers: () => [] },
      subscriber: { getStats: vi.fn(async () => new Map([['in', { type: 'inbound-rtp' }]])) },
    },
  };
  constructor(readonly options: object) {
    super();
    FakeRoom.last = this;
  }
  addRemote(identity: string, ...sources: string[]) {
    const pubs = new Map(sources.map((s) => [s, new FakePublication(s)]));
    this.remoteParticipants.set(identity, { identity, trackPublications: pubs });
    return pubs;
  }
}

const fakeLib = {
  Room: FakeRoom,
  LocalAudioTrack: class extends FakeLocalTrack {
    constructor(track: MediaStreamTrack) {
      super('audio', track);
    }
  },
  LocalVideoTrack: class extends FakeLocalTrack {
    constructor(track: MediaStreamTrack) {
      super('video', track);
    }
  },
};

class FakePeerConnection {
  readonly configurations: RTCConfiguration[] = [];
  constructor(readonly config?: RTCConfiguration) {}
  setConfiguration(config?: RTCConfiguration) {
    this.configurations.push(config!);
  }
}

const track = (kind: 'audio' | 'video') => ({ kind, stop: vi.fn() }) as unknown as MediaStreamTrack;

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup({ api = 'encoded-streams' as 'encoded-streams' | 'script-transform' } = {}) {
  const original = loadLiveKit;
  setLiveKitLoader(async () => fakeLib as unknown as typeof import('livekit-client'));
  const events = { state: vi.fn(), remoteTrack: vi.fn(), subscribed: vi.fn(), dropped: vi.fn(), negotiationFailure: vi.fn() } satisfies TransportEvents;
  const frames = {
    transformApi: api,
    preferEncodedStreams: vi.fn(),
    attachSender: vi.fn(),
    attachReceiver: vi.fn(),
  };
  const signaling = { onMediaRelay: vi.fn(() => vi.fn()), announceTracks: vi.fn().mockResolvedValue(undefined) };
  const NativeSocket = class {};
  const host = { RTCPeerConnection: FakePeerConnection, WebSocket: NativeSocket } as unknown as PeerConnectionHost & WebSocketHost;
  const transport = new LiveKitTransport(config, frames as unknown as FrameCrypto, signaling as unknown as SignalingService, events, host);
  frames.attachSender.mockImplementation((sender: { kind: string }) => FakeRoom.last.localParticipant.log.push(`encrypted ${sender.kind}`));
  return { transport, events, frames, signaling, host, NativeSocket, restoreLoader: () => setLiveKitLoader(original) };
}

describe('LiveKitTransport', () => {
  let ctx: ReturnType<typeof setup>;
  afterEach(() => ctx?.restoreLoader());

  it('connects through the relay with a placeholder token, subscribing only to what the room wants', async () => {
    ctx = setup();
    await settle();

    expect(FakeRoom.last.connect).toHaveBeenCalledWith(RELAY_URL, RELAY_TOKEN, { autoSubscribe: false });
    expect(FakeRoom.last.options).toMatchObject({ adaptiveStream: false, dynacast: false });
    expect(ctx.events.state.mock.calls).toEqual([['connecting'], ['connected']]);
    expect(ctx.host.WebSocket).not.toBe(ctx.NativeSocket); // the stand-in is installed
  });

  it('on Chromium every peer connection livekit-client makes gets encoded streams, until the call ends', async () => {
    ctx = setup({ api: 'encoded-streams' });
    expect(ctx.frames.preferEncodedStreams).toHaveBeenCalled();
    const pc = new ctx.host.RTCPeerConnection({ iceServers: [] }) as unknown as FakePeerConnection;
    pc.setConfiguration({ iceServers: [{ urls: 'turn:x' }] });

    expect(pc.config).toMatchObject({ encodedInsertableStreams: true });
    expect(pc.configurations[0]).toMatchObject({ encodedInsertableStreams: true });

    await settle();
    ctx.transport.close();
    await settle();
    expect(ctx.host.RTCPeerConnection).toBe(FakePeerConnection);
  });

  it('script transforms (WebKit) leave the peer connection alone', () => {
    ctx = setup({ api: 'script-transform' });
    expect(ctx.host.RTCPeerConnection).toBe(FakePeerConnection);
  });

  it('encrypts every sender before its negotiation finishes, then announces the tracks', async () => {
    ctx = setup();
    await ctx.transport.publish(
      [
        { source: 'microphone', track: track('audio') },
        { source: 'camera', track: track('video') },
      ],
      'vp9',
    );

    const lp = FakeRoom.last.localParticipant;
    expect(lp.log).toEqual(['encrypted audio', 'negotiated audio', 'encrypted video', 'negotiated video']);
    expect(ctx.frames.attachSender.mock.calls.map((c) => c.slice(1))).toEqual([['audio', undefined], ['video', 'vp9']]);
    expect(lp.publishTrack.mock.calls.map((c) => c[1])).toEqual([
      { source: 'microphone', videoCodec: 'vp9', backupCodec: false, simulcast: false },
      { source: 'camera', videoCodec: 'vp9', backupCodec: false, simulcast: true },
    ]);
    expect(ctx.signaling.announceTracks).toHaveBeenCalledWith(['microphone', 'camera']);
    expect(ctx.transport.hasSender('camera')).toBe(true);
  });

  it('a failed announcement unpublishes what it published', async () => {
    ctx = setup();
    ctx.signaling.announceTracks.mockRejectedValueOnce(new Error('Track already published.'));

    await expect(ctx.transport.publish([{ source: 'camera', track: track('video') }], 'vp8')).rejects.toThrow();

    expect(FakeRoom.last.localParticipant.unpublishTrack).toHaveBeenCalled();
    expect(ctx.transport.hasSender('camera')).toBe(false);
  });

  it('swaps tracks in place; nothing to send = muted', async () => {
    ctx = setup();
    await ctx.transport.publish([{ source: 'camera', track: track('video') }], 'vp8');
    const local = (FakeRoom.last.localParticipant.publishTrack.mock.results[0].value as Promise<{ track: FakeLocalTrack }>);
    const published = (await local).track;
    const next = track('video');

    expect(await ctx.transport.replaceTrack('camera', null)).toBe(true);
    expect(published.mute).toHaveBeenCalled();
    expect(await ctx.transport.replaceTrack('camera', next)).toBe(true);
    expect(published.replaceTrack).toHaveBeenCalledWith(next, true);
    expect(published.unmute).toHaveBeenCalled();
    expect(await ctx.transport.replaceTrack('screen', next)).toBe(false);
  });

  it('subscribes to exactly the tracks the room wants, including ones published later', async () => {
    ctx = setup();
    await settle();
    const bob = FakeRoom.last.addRemote('bob', 'microphone', 'camera');
    const room: ParticipantDto[] = [{ id: 'bob', ticket: null, identity, videoCodecs: ['vp8'], tracks: [{ source: 'microphone', kind: 'audio', muted: false }] }];

    ctx.transport.follow(room); // audio only
    expect(bob.get('microphone')!.setSubscribed).toHaveBeenCalledWith(true);
    expect(bob.get('camera')!.setSubscribed).not.toHaveBeenCalled();
    expect([...ctx.transport.subscribedKeys()]).toEqual(['bob:microphone']);

    FakeRoom.last.addRemote('carol', 'screen_share');
    ctx.transport.follow([...room, { id: 'carol', ticket: null, identity, videoCodecs: ['vp8'], tracks: [{ source: 'screen', kind: 'video', muted: false }] }]);
    FakeRoom.last.emit('trackPublished');
    expect(FakeRoom.last.remoteParticipants.get('carol')!.trackPublications.get('screen_share')!.isDesired).toBe(true);

    ctx.transport.follow([]);
    expect(bob.get('microphone')!.setSubscribed).toHaveBeenLastCalledWith(false);
  });

  it('decrypts every received track with its participant’s keys, then shows it', async () => {
    ctx = setup();
    await settle();
    const publication = FakeRoom.last.addRemote('bob', 'camera').get('camera')!;
    const receiver = {} as RTCRtpReceiver;
    const media = track('video');

    FakeRoom.last.emit('trackSubscribed', { kind: 'video', receiver, mediaStreamTrack: media }, publication, { identity: 'bob' });

    expect(ctx.frames.attachReceiver).toHaveBeenCalledWith(receiver, 'video', 'bob');
    expect(ctx.events.remoteTrack).toHaveBeenCalledWith('bob:camera', media);
    expect(ctx.events.subscribed).toHaveBeenCalledWith(['bob:camera']);

    FakeRoom.last.emit('trackUnsubscribed', {}, publication, { identity: 'bob' });
    expect(ctx.events.dropped).toHaveBeenCalledWith(['bob:camera']);
  });

  it('tile sizes pick LiveKit’s video quality, only when it changes', async () => {
    ctx = setup();
    await settle();
    const publication = FakeRoom.last.addRemote('bob', 'camera').get('camera')!;
    publication.isSubscribed = true;

    await ctx.transport.setLayer('bob:camera', 'f');
    await ctx.transport.setLayer('bob:camera', 'q');
    await ctx.transport.setLayer('bob:camera', 'q');
    await ctx.transport.setLayer('bob:camera', 'h');

    expect(publication.setVideoQuality.mock.calls).toEqual([[0], [1]]);
  });

  it('maps livekit-client’s connection states', async () => {
    ctx = setup();
    await settle();
    for (const s of ['reconnecting', 'signalReconnecting', 'connected', 'disconnected']) FakeRoom.last.emit('connectionStateChanged', s);
    expect(ctx.events.state.mock.calls.slice(2)).toEqual([['reconnecting'], ['reconnecting'], ['connected'], ['disconnected']]);
  });

  it('files go to the recipients only, under the channel’s name, and come back by sender and name', async () => {
    ctx = setup();
    const out = await ctx.transport.publishChannel('AAAA', ['bob']);
    out.send(new Uint8Array([1, 2]));
    expect(FakeRoom.last.localParticipant.publishData).toHaveBeenCalledWith(new Uint8Array([1, 2]), { reliable: true, topic: 'AAAA', destinationIdentities: ['bob'] });

    const incoming = await ctx.transport.subscribeChannel('bob', 'BBBB');
    const got: number[][] = [];
    incoming.onmessage = (e) => got.push([...new Uint8Array(e.data)]);
    FakeRoom.last.emit('dataReceived', new Uint8Array([7]), { identity: 'bob' }, 0, 'BBBB');
    FakeRoom.last.emit('dataReceived', new Uint8Array([8]), { identity: 'carol' }, 0, 'BBBB'); // someone else
    FakeRoom.last.emit('dataReceived', new Uint8Array([9]), { identity: 'bob' }, 0, 'CCCC'); // another transfer
    expect(got).toEqual([[7]]);

    await ctx.transport.closeChannel('BBBB', 'bob');
    FakeRoom.last.emit('dataReceived', new Uint8Array([7]), { identity: 'bob' }, 0, 'BBBB');
    expect(got).toEqual([[7]]);
    expect(incoming.readyState).toBe('closed');
  });

  it('merges both peer connections’ stats', async () => {
    ctx = setup();
    await settle();
    const stats = await ctx.transport.stats();
    const types: string[] = [];
    stats!.forEach((s: { type: string }) => types.push(s.type));
    expect(types).toEqual(['outbound-rtp', 'inbound-rtp']);
  });

  it('closing disconnects, removes the stand-in and refuses further use', async () => {
    ctx = setup();
    await settle();
    ctx.transport.close();
    await settle();

    expect(FakeRoom.last.disconnect).toHaveBeenCalled();
    expect(ctx.host.WebSocket).toBe(ctx.NativeSocket);
    await expect(ctx.transport.publish([], 'vp8')).rejects.toThrow('Not connected.');
  });

  it('a failed connect leaves the call disconnected (the room rejoins)', async () => {
    const original = loadLiveKit;
    setLiveKitLoader(async () => {
      throw new Error('blocked');
    });
    try {
      const events = { state: vi.fn(), remoteTrack: vi.fn(), subscribed: vi.fn(), dropped: vi.fn(), negotiationFailure: vi.fn() };
      const frames = { transformApi: 'script-transform', preferEncodedStreams: vi.fn(), attachSender: vi.fn(), attachReceiver: vi.fn() };
      const host = { RTCPeerConnection: FakePeerConnection, WebSocket: class {} } as unknown as PeerConnectionHost & WebSocketHost;
      new LiveKitTransport(config, frames as unknown as FrameCrypto, { onMediaRelay: () => vi.fn() } as unknown as SignalingService, events, host);
      await settle();
      expect(events.state.mock.calls).toEqual([['connecting'], ['disconnected']]);
    } finally {
      setLiveKitLoader(original);
    }
  });
});

describe('LiveKitFileChannel', () => {
  it('counts what LiveKit hasn’t taken yet and signals when it drains below the threshold', async () => {
    const pending: (() => void)[] = [];
    const channel = LiveKitFileChannel.sending(() => new Promise<void>((r) => pending.push(r)));
    channel.bufferedAmountLowThreshold = 10;
    const low = vi.fn();
    channel.addEventListener('bufferedamountlow', low);

    channel.send(new Uint8Array(8));
    channel.send(new Uint8Array(8));
    expect(channel.bufferedAmount).toBe(16);

    pending.shift()!();
    await settle();
    expect(channel.bufferedAmount).toBe(8);
    expect(low).toHaveBeenCalledTimes(1);
    expect(channel.binaryType).toBe('arraybuffer');
  });

  it('a failed send closes the channel', async () => {
    const channel = LiveKitFileChannel.sending(() => Promise.reject(new Error('gone')));
    const closed = vi.fn();
    channel.onclose = closed;
    channel.send(new Uint8Array(1));
    await settle();
    expect(closed).toHaveBeenCalled();
    expect(() => channel.send(new Uint8Array(1))).toThrow();
  });
});
