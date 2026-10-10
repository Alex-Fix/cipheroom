import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SignalingService } from '../signaling/signaling.service';
import {
  AuthorityDto,
  IdentityDto,
  KeyEnvelopeDto,
  ParticipantDto,
  TicketDto,
} from '../signaling/signaling.types';
import {
  CryptoService,
  MAX_ENVELOPES_PER_CALL,
  ROTATION_DEBOUNCE_MS,
  SWITCH_DELAY_MS,
} from './crypto.service';
import { ReceivedChatEvent, chatKeyIndex, newChatId } from './chat-crypto';
import { fromBase64Url, toBase64Url, utf8 } from './encoding';
import { FRAME_CRYPTO_FACTORY } from './frame-transforms';
import { HostKey, createHostKey } from './host-key';
import { HOST_KEY_STORE, MemoryHostKeyStore } from './host-key-store';
import { DEVICE_KEY_STORE, MemoryDeviceKeyStore } from './device-key-store';
import { createDeviceKey } from './device-key';
import { verifyIdentity } from './identity';

/** Records what the service hands the frame worker. */
class FakeFrames {
  readonly sendKeys: { keyIndex: number; key: Uint8Array }[] = [];
  readonly receiveKeys: { participantId: string; keyIndex: number; key: Uint8Array }[] = [];
  readonly removed: string[] = [];
  terminated = false;
  setSendKey(keyIndex: number, key: ArrayBuffer) {
    this.sendKeys.push({ keyIndex, key: new Uint8Array(key) });
  }
  setReceiveKey(participantId: string, keyIndex: number, key: ArrayBuffer) {
    this.receiveKeys.push({ participantId, keyIndex, key: new Uint8Array(key) });
  }
  removeParticipant(id: string) {
    this.removed.push(id);
  }
  terminate() {
    this.terminated = true;
  }
}

/** A participant's browser: its own CryptoService and signaling, connected to the shared fake server. */
interface Client {
  id: string;
  crypto: CryptoService;
  frames: FakeFrames;
  hostKeys: MemoryHostKeyStore;
  deviceKeys: MemoryDeviceKeyStore;
  participants: ReturnType<typeof signal<ParticipantDto[]>>;
  authority: ReturnType<typeof signal<AuthorityDto | undefined>>;
  sent: KeyEnvelopeDto[][];
  inbox: (fromId: string, blob: string) => void;
  chatInbox: (fromId: string, blob: string) => void;
  /** Chat blobs this client sent (the server relays them to everyone else in the room). */
  chats: string[];
  /** Envelopes to this client wait here while set (to make chat arrive before a key). */
  heldEnvelopes?: [string, string][];
  failSends: boolean;
}

/**
 * The api, as far as keys and admission go: the first one in hosts (with the meeting's host key), everyone after is
 * admitted with the host's ticket; envelopes are relayed to their recipient, with the sender's id.
 */
class FakeServer {
  readonly clients = new Map<string, Client>();
  private host?: Client;
  private authorityDto?: AuthorityDto;

  private constructor(private readonly hostKey: HostKey) {}

  static async create(): Promise<FakeServer> {
    return new FakeServer((await createHostKey()).hostKey);
  }

  /** The meeting's id: derived from its host key. */
  get room(): string {
    return this.hostKey.roomId;
  }

  client(id: string): Client {
    const frames = new FakeFrames();
    const hostKeys = new MemoryHostKeyStore();
    const deviceKeys = new MemoryDeviceKeyStore();
    const participants = signal<ParticipantDto[]>([]);
    const authority = signal<AuthorityDto | undefined>(this.authorityDto);
    const client = {
      id,
      frames,
      hostKeys,
      deviceKeys,
      participants,
      authority,
      sent: [],
      chats: [],
      failSends: false,
    } as unknown as Client;
    const signaling = {
      participants,
      authority,
      sendKeyEnvelopes: vi.fn(async (envelopes: KeyEnvelopeDto[]) => {
        if (client.failSends) throw new Error('Media server unavailable.');
        client.sent.push(envelopes);
        for (const e of envelopes)
          queueMicrotask(() => {
            const to = this.clients.get(e.toId);
            if (to?.heldEnvelopes) to.heldEnvelopes.push([id, e.blob]);
            else to?.inbox(id, e.blob);
          });
      }),
      onKeyEnvelope: (listener: (fromId: string, blob: string) => void) => {
        client.inbox = listener;
        return () => (client.inbox = () => undefined);
      },
      sendChat: vi.fn(async (blob: string) => {
        client.chats.push(blob);
        for (const c of this.clients.values())
          if (c !== client && this.inRoom.has(c.id)) queueMicrotask(() => c.chatInbox(id, blob));
      }),
      onChat: (listener: (fromId: string, blob: string) => void) => {
        client.chatInbox = listener;
        return () => (client.chatInbox = () => undefined);
      },
    };
    const injector = createEnvironmentInjector(
      [
        CryptoService,
        { provide: SignalingService, useValue: signaling },
        { provide: FRAME_CRYPTO_FACTORY, useValue: () => frames },
        { provide: HOST_KEY_STORE, useValue: hostKeys },
        { provide: DEVICE_KEY_STORE, useValue: deviceKeys },
      ],
      TestBed.inject(EnvironmentInjector),
    );
    client.crypto = injector.get(CryptoService);
    client.inbox = () => undefined;
    client.chatInbox = () => undefined;
    this.clients.set(id, client);
    return client;
  }

  /**
   * Joins `client` to the room (as host if it's the first, else with the host's ticket): others learn about it, it
   * learns about them; then it starts encryption.
   */
  async join(client: Client): Promise<void> {
    const identity = await client.crypto.identityBundle(this.room);
    let ticket: TicketDto | null = null;
    if (!this.host) {
      await client.hostKeys.put(this.hostKey);
      const proof = (await client.crypto.hostProof(this.room))!;
      this.host = client;
      this.setAuthority({
        hostEd25519Pub: proof.hostEd25519Pub,
        hostX25519Pub: proof.hostX25519Pub,
        hosts: [{ identity: identity.ed25519Pub, sig: proof.attestation }],
        coHosts: [],
        revoked: [],
        settings: null,
        admitters: [{ id: client.id, identity }],
      });
    } else {
      ticket = await this.ticketFor(identity);
    }
    const me: ParticipantDto = {
      id: client.id,
      ticket,
      tracks: [],
      identity,
      videoCodecs: ['vp8'],
    };
    const others = [...this.clients.values()].filter((c) => c !== client && this.inRoom.has(c.id));
    client.participants.set(others.map((c) => this.dto(c)));
    this.inRoom.set(client.id, me);
    others.forEach((c) => c.participants.update((list) => [...list, me]));
    await client.crypto.start(this.room, client.id, client.id.toUpperCase());
  }

  /** What the host signs to let `identity` in. */
  async ticketFor(identity: IdentityDto): Promise<TicketDto> {
    const issuer = this.inRoom.get(this.host!.id)!.identity.ed25519Pub;
    return { issuer, sig: await this.host!.crypto.signTicket(identity.ed25519Pub) };
  }

  /** The host removes `client`: a signed revocation everyone gets — but the server "forgets" to drop them. */
  async revokeButKeep(client: Client): Promise<void> {
    const pub = this.inRoom.get(client.id)!.identity.ed25519Pub;
    const issuer = this.inRoom.get(this.host!.id)!.identity.ed25519Pub;
    const sig = await this.host!.crypto.signRemoval(pub);
    this.setAuthority({ ...this.authorityDto!, revoked: [{ subject: pub, issuer, sig }] });
  }

  identityOf(client: Client): string {
    return this.inRoom.get(client.id)!.identity.ed25519Pub;
  }

  /** The server's authority loses every removal (an api restart, or a server that lies by omission). */
  forgetRemovals(): void {
    this.setAuthority({ ...this.authorityDto!, revoked: [] });
  }

  leave(client: Client): void {
    this.inRoom.delete(client.id);
    client.crypto.stop();
    for (const c of this.clients.values()) {
      c.participants.update((list) => list.filter((p) => p.id !== client.id));
    }
  }

  private readonly inRoom = new Map<string, ParticipantDto>();

  private setAuthority(dto: AuthorityDto): void {
    this.authorityDto = dto;
    for (const c of this.clients.values()) c.authority.set(dto);
  }

  private dto(client: Client): ParticipantDto {
    return this.inRoom.get(client.id)!;
  }
}

/** One real event-loop turn (setTimeout is faked): lets WebCrypto, which runs off-thread, finish. */
const realTick = () =>
  new Promise<void>((resolve) =>
    (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(resolve),
  );

/** Runs effects, timers and the async crypto until everything settled. */
async function settle(ms = 0) {
  // Small steps: timers scheduled after async crypto (e.g. the key switch) must still fire within `ms`.
  for (let elapsed = 0, i = 0; elapsed < ms || i < 20; i++) {
    TestBed.tick();
    const step = Math.min(25, Math.max(ms - elapsed, 0));
    await vi.advanceTimersByTimeAsync(step);
    elapsed += step;
    for (let t = 0; t < 10; t++) await realTick();
  }
}

/** Waits past the rotation debounce and the switch-over delay. */
const afterRotation = async () => {
  await settle(ROTATION_DEBOUNCE_MS + 10);
  await settle(SWITCH_DELAY_MS + 10);
};

const lastSendKey = (c: Client) => c.frames.sendKeys.at(-1)!;

/** Everything `c` heard in chat, as CryptoService hands it on. */
function chatLog(c: Client): ReceivedChatEvent[] {
  const log: ReceivedChatEvent[] = [];
  c.crypto.onChatEvent((e) => log.push(e));
  return log;
}

/** Seals a message from `c` and has the server relay it. */
async function say(c: Client, text: string): Promise<string> {
  const blob = await c.crypto.sealChat({ type: 'message', id: newChatId(), text });
  await c.crypto['signaling'].sendChat(blob);
  return blob;
}
const receiveKeys = (c: Client, from: string) =>
  c.frames.receiveKeys.filter((k) => k.participantId === from);

describe('CryptoService', () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await FakeServer.create();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('RTCRtpScriptTransform', class {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('creates a verifiable identity and keeps it for the call (rejoins keep the safety code)', async () => {
      const { crypto } = server.client('alice');
      const bundle = await crypto.identityBundle(server.room);
      expect(await verifyIdentity(bundle, server.room)).toBeDefined();
      expect(await crypto.identityBundle(server.room)).toBe(bundle);
      expect((await crypto.identityBundle('other-room')).ed25519Pub).not.toBe(bundle.ed25519Pub);
    });

    it('refuses without Ed25519/X25519 — no unencrypted calls', async () => {
      const { crypto } = server.client('alice');
      vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockRejectedValue(
        new DOMException('', 'NotSupportedError'),
      );
      await expect(crypto.identityBundle(server.room)).rejects.toThrow(
        "This browser can't join encrypted calls.",
      );
    });

    it('refuses without encoded transforms', async () => {
      const alice = server.client('alice');
      vi.stubGlobal('RTCRtpScriptTransform', undefined);
      vi.stubGlobal('RTCRtpSender', class {});
      await expect(server.join(alice)).rejects.toThrow("This browser can't join encrypted calls.");
    });
  });

  describe('keys', () => {
    it('encrypts with its first key from the start, even alone', async () => {
      const alice = server.client('alice');
      await server.join(alice);

      expect(alice.frames.sendKeys).toEqual([{ keyIndex: 0, key: expect.any(Uint8Array) }]);
      expect(lastSendKey(alice).key.byteLength).toBe(32);
      expect(alice.sent).toEqual([]);
    });

    it('a newcomer gets everyone’s key and everyone gets the newcomer’s', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      await server.join(bob);
      await afterRotation();

      // Bob's first key reached Alice; Alice rotated for Bob and he got the new key.
      expect(receiveKeys(alice, 'bob').map((k) => k.key)).toEqual([bob.frames.sendKeys[0].key]);
      expect(lastSendKey(alice).keyIndex).toBe(1);
      expect(receiveKeys(bob, 'alice')).toEqual([
        { participantId: 'alice', keyIndex: 1, key: lastSendKey(alice).key },
      ]);
      expect(alice.crypto.secured()).toEqual(new Set(['bob']));
      expect(bob.crypto.secured()).toEqual(new Set(['alice']));
      // Names arrive inside the envelopes, signed by whoever chose them.
      expect(alice.crypto.names()).toEqual(
        new Map([
          ['alice', 'ALICE'],
          ['bob', 'BOB'],
        ]),
      );
      expect(bob.crypto.names().get('alice')).toBe('ALICE');
    });

    it('never gives a newcomer a key used before they joined', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      const before = lastSendKey(alice).key;
      await server.join(bob);
      await afterRotation();

      expect(receiveKeys(bob, 'alice').map((k) => k.key)).not.toContainEqual(before);
    });

    it('switches to a new key only after receivers had time to install it', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      await server.join(bob);
      await settle(ROTATION_DEBOUNCE_MS + 10);
      expect(alice.frames.sendKeys).toHaveLength(1);

      await settle(SWITCH_DELAY_MS);
      expect(alice.frames.sendKeys).toHaveLength(2);
    });

    it('rotates on leave and leaves the leaver out — they can’t read what comes next', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();
      const sendsBefore = alice.sent.length;

      server.leave(carol);
      await afterRotation();

      expect(alice.frames.removed).toContain('carol');
      const rotation = alice.sent.slice(sendsBefore);
      expect(rotation).toHaveLength(1);
      expect(rotation[0].map((e) => e.toId)).toEqual(['bob']);
      expect(lastSendKey(alice).key).toEqual(receiveKeys(bob, 'alice').at(-1)!.key);
      expect(receiveKeys(carol, 'alice').map((k) => k.key)).not.toContainEqual(
        lastSendKey(alice).key,
      );
      expect(alice.crypto.secured()).toEqual(new Set(['bob']));
    });

    it('debounces a burst of joins into one rotation', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      await server.join(alice);
      await server.join(bob);
      await server.join(carol);
      await afterRotation();

      expect(alice.sent).toHaveLength(1);
      expect(alice.sent[0].map((e) => e.toId).sort()).toEqual(['bob', 'carol']);
    });

    it('splits a rotation for a big room into calls the server accepts', async () => {
      const alice = server.client('alice');
      await server.join(alice);
      const crowd = await Promise.all(
        Array.from({ length: MAX_ENVELOPES_PER_CALL + 6 }, async (_, i) => {
          const identity = await server.client(`p${i}`).crypto.identityBundle(server.room);
          return {
            id: `p${i}`,
            ticket: await server.ticketFor(identity),
            tracks: [],
            identity,
            videoCodecs: ['vp8'],
          };
        }),
      );
      alice.participants.set(crowd);
      await afterRotation();

      expect(alice.sent.map((call) => call.length).sort((a, b) => b - a)).toEqual([
        MAX_ENVELOPES_PER_CALL,
        6,
      ]);
    });

    it('switches at once when the envelopes couldn’t be sent (never keeps a key a leaver may hold)', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();
      const keysBefore = alice.frames.sendKeys.length;

      alice.failSends = true;
      server.leave(carol);
      await settle(ROTATION_DEBOUNCE_MS + 10);

      expect(alice.frames.sendKeys).toHaveLength(keysBefore + 1);
    });
  });

  describe('untrusted server', () => {
    it('exchanges no keys with a participant whose identity doesn’t verify', async () => {
      const alice = server.client('alice');
      await server.join(alice);
      const realMallory = await server.client('mallory').crypto.identityBundle(server.room);
      // The server swaps Mallory's agreement key: the self-signature no longer matches.
      const forged = {
        ...realMallory,
        x25519Pub: (await alice.crypto.identityBundle(server.room)).x25519Pub,
      };
      alice.participants.update((list) => [
        ...list,
        {
          id: 'mallory',
          ticket: null,
          tracks: [],
          identity: forged,
          videoCodecs: ['vp8'],
        },
      ]);
      await afterRotation();

      expect(alice.crypto.unverified()).toEqual(new Set(['mallory']));
      expect(alice.sent.flat().map((e) => e.toId)).not.toContain('mallory');

      alice.inbox('mallory', 'AAAA');
      await settle();
      expect(alice.crypto.droppedEnvelopes()).toEqual({ 'unknown-sender': 1 });
      expect(receiveKeys(alice, 'mallory')).toEqual([]);
    });

    it('exchanges no keys with someone the server slips in without a valid ticket', async () => {
      const alice = server.client('alice');
      await server.join(alice);
      const mallory = await server.client('mallory').crypto.identityBundle(server.room);
      const forgedTicket = {
        issuer: mallory.ed25519Pub,
        sig: (await server.ticketFor(mallory)).sig,
      };
      for (const ticket of [null, forgedTicket]) {
        alice.participants.set([
          { id: 'mallory', ticket, tracks: [], identity: mallory, videoCodecs: ['vp8'] },
        ]);
        await afterRotation();
        expect(alice.crypto.unverified()).toEqual(new Set(['mallory']));
        alice.participants.set([]);
        await settle();
      }
      expect(alice.sent.flat().map((e) => e.toId)).not.toContain('mallory');
    });

    it('cuts a removed participant off even if the server keeps them in the call', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();

      await server.revokeButKeep(carol);
      await afterRotation();
      // The revocation is verified before the rotation is scheduled: let the switch-over happen too.
      await settle(SWITCH_DELAY_MS + 10);

      expect(alice.frames.removed).toContain('carol');
      expect(alice.crypto.unverified()).toEqual(new Set(['carol']));
      expect(alice.sent.at(-1)!.map((e) => e.toId)).toEqual(['bob']);
      expect(receiveKeys(carol, 'alice').map((k) => k.key)).not.toContainEqual(
        lastSendKey(alice).key,
      );
    });

    it('never forgets a verified removal, even when the server does', async () => {
      const [alice, bob, carol, dan] = ['alice', 'bob', 'carol', 'dan'].map((id) =>
        server.client(id),
      );
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();
      await server.revokeButKeep(carol);
      await afterRotation();
      await settle(SWITCH_DELAY_MS + 10);
      const keyAfterRemoval = lastSendKey(alice).key;
      const sendsAfterRemoval = alice.sent.length;

      // The api restarts (or lies): its authority no longer lists Carol's removal. Carol, still holding her
      // identity and ticket, is in the call again; Dan joins, so everyone rotates.
      server.forgetRemovals();
      await settle();
      await server.join(dan);
      await afterRotation();
      await settle(SWITCH_DELAY_MS + 10);

      expect(alice.crypto.unverified()).toContain('carol');
      const later = alice.sent
        .slice(sendsAfterRemoval)
        .flat()
        .map((e) => e.toId);
      expect(later).toContain('dan');
      expect(later).not.toContain('carol');
      expect(lastSendKey(alice).key).not.toEqual(keyAfterRemoval);
      expect(receiveKeys(carol, 'alice').map((k) => k.key)).not.toContainEqual(
        lastSendKey(alice).key,
      );
      expect(alice.crypto.authority().revoked.has(server.identityOf(carol))).toBe(true);
    });

    it('rejects replayed and tampered envelopes', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      await server.join(bob);
      await afterRotation();
      const fromAlice = alice.sent.flat().find((e) => e.toId === 'bob')!.blob;
      const installed = receiveKeys(bob, 'alice').length;

      bob.inbox('alice', fromAlice);
      const wire = JSON.parse(new TextDecoder().decode(fromBase64Url(fromAlice)));
      wire.ct = toBase64Url(fromBase64Url(wire.ct).map((b, i) => (i === 0 ? b ^ 1 : b)));
      bob.inbox('alice', toBase64Url(utf8(JSON.stringify(wire))));
      bob.inbox('carol', fromAlice);
      await settle();

      expect(receiveKeys(bob, 'alice')).toHaveLength(installed);
      expect(bob.crypto.droppedEnvelopes()).toEqual({
        'stale-epoch': 1,
        'bad-signature': 1,
        'unknown-sender': 1,
      });
    });
  });

  describe('safety code', () => {
    it('is the same for everyone in the call and changes when someone joins', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      await settle();
      const alone = alice.crypto.safetyCode();
      expect(alone).toBeDefined();

      await server.join(bob);
      await settle();
      expect(alice.crypto.safetyCode()).not.toEqual(alone);
      expect(alice.crypto.safetyCode()).toEqual(bob.crypto.safetyCode());
    });

    it('differs when the server shows someone a different participant set', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      await server.join(bob);
      const ghost = await server.client('ghost').crypto.identityBundle(server.room);
      bob.participants.update((list) => [
        ...list,
        { id: 'ghost', ticket: null, tracks: [], identity: ghost, videoCodecs: ['vp8'] },
      ]);
      await settle();

      expect(alice.crypto.safetyCode()).not.toEqual(bob.crypto.safetyCode());
    });
  });

  it('reports E2EE health: time spent waiting for keys and dropped envelopes', async () => {
    const alice = server.client('alice');
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await server.join(alice);
    expect(alice.crypto.telemetry(now).securingSeconds).toBe(0);

    // Carol is listed but never sends her key: Alice keeps waiting ("Securing…").
    const carol = await server.client('carol').crypto.identityBundle(server.room);
    const ticket = await server.ticketFor(carol);
    alice.participants.update((list) => [
      ...list,
      { id: 'carol', ticket, tracks: [], identity: carol, videoCodecs: ['vp8'] },
    ]);
    await settle();
    now += 2_000;
    expect(alice.crypto.telemetry(now).securingSeconds).toBe(2);

    // She leaves: the clock stops.
    alice.participants.set([]);
    await settle();
    now += 60_000;
    expect(alice.crypto.telemetry(now).securingSeconds).toBe(2);

    alice.inbox('mallory', 'AAAA');
    await settle();
    expect(alice.crypto.telemetry(now).envelopesDropped).toBe(1);
  });

  describe('device keys', () => {
    it('tells everyone our device key, only from statements that verify, and forgets leavers', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      const { deviceKey } = await createDeviceKey();
      await alice.deviceKeys.put(deviceKey);
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();

      expect(bob.crypto.devices()).toEqual(new Map([['alice', deviceKey.pub]]));
      expect(carol.crypto.devices().get('alice')).toBe(deviceKey.pub);
      // Bob has none set up: nothing to tell.
      expect(alice.crypto.devices().has('bob')).toBe(false);

      server.leave(alice);
      await settle();
      expect(bob.crypto.devices().size).toBe(0);
    });

    it('a broken key store just means no device key', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      vi.spyOn(alice.deviceKeys, 'get').mockRejectedValue(new Error('IndexedDB timed out.'));
      await server.join(alice);
      await server.join(bob);
      await afterRotation();
      expect(bob.crypto.devices().size).toBe(0);
      expect(bob.crypto.secured()).toEqual(new Set(['alice']));
    });
  });

  describe('chat', () => {
    it('cannot send before the first key — no unencrypted chat', async () => {
      const alice = server.client('alice');
      expect(alice.crypto.chatReady()).toBe(false);
      await expect(
        alice.crypto.sealChat({ type: 'message', id: newChatId(), text: 'hi' }),
      ).rejects.toThrow('Chat is not ready.');
      await server.join(alice);
      expect(alice.crypto.chatReady()).toBe(true);
    });

    it('delivers signed messages, with the author’s identity, to everyone else', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();
      const [bobLog, carolLog] = [chatLog(bob), chatLog(carol)];

      await say(alice, 'hello');
      await settle();

      for (const log of [bobLog, carolLog]) {
        expect(log).toEqual([
          {
            fromId: 'alice',
            authorPub: alice.crypto.identityPub(),
            event: { v: 1, seq: 1, type: 'message', id: expect.any(String), text: 'hello' },
          },
        ]);
      }
    });

    it('chat switches keys together with media', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      expect(chatKeyIndex(await say(alice, 'alone'))).toBe(0);
      await server.join(bob);
      await afterRotation();
      expect(chatKeyIndex(await say(alice, 'together'))).toBe(lastSendKey(alice).keyIndex);
      expect(lastSendKey(alice).keyIndex).toBe(1);
    });

    it('a newcomer can’t read what was said before they joined', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      const early = await say(alice, 'before bob');
      await server.join(bob);
      await afterRotation();
      const bobLog = chatLog(bob);

      bob.chatInbox('alice', early);
      await settle(11_000);
      expect(bobLog).toEqual([]);
    });

    it('holds a message that beats its sender’s key, then delivers it in order', async () => {
      const alice = server.client('alice');
      const bob = server.client('bob');
      await server.join(alice);
      const aliceLog = chatLog(alice);
      alice.heldEnvelopes = [];
      await server.join(bob);
      await say(bob, 'first');
      await say(bob, 'second');
      await settle();
      expect(aliceLog).toEqual([]);

      const held = alice.heldEnvelopes;
      alice.heldEnvelopes = undefined;
      held.forEach(([from, blob]) => alice.inbox(from, blob));
      await settle();

      expect(aliceLog.map((e) => e.event)).toMatchObject([{ text: 'first' }, { text: 'second' }]);
    });

    it('drops replays and events the server re-attributes', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();
      const bobLog = chatLog(bob);

      const blob = await say(alice, 'once');
      await settle();
      bob.chatInbox('alice', blob);
      // Carol's message, relayed as if Alice sent it.
      const carols = await carol.crypto.sealChat({ type: 'message', id: newChatId(), text: 'x' });
      bob.chatInbox('alice', carols);
      await settle();

      expect(bobLog.map((e) => e.event)).toMatchObject([{ text: 'once' }]);
    });

    it('forgets a leaver at once: nothing more from them is read', async () => {
      const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.client(id));
      for (const c of [alice, bob, carol]) await server.join(c);
      await afterRotation();
      const aliceLog = chatLog(alice);
      const late = await carol.crypto.sealChat({ type: 'message', id: newChatId(), text: 'bye' });

      server.leave(carol);
      await settle();
      alice.chatInbox('carol', late);
      await settle();

      expect(aliceLog).toEqual([]);
    });

    it('stop drops the chat key', async () => {
      const alice = server.client('alice');
      await server.join(alice);
      alice.crypto.stop();
      expect(alice.crypto.chatReady()).toBe(false);
      await expect(
        alice.crypto.sealChat({ type: 'message', id: newChatId(), text: 'hi' }),
      ).rejects.toThrow('Chat is not ready.');
    });
  });

  it('stop ends the call’s encryption: worker gone, later envelopes ignored', async () => {
    const alice = server.client('alice');
    const bob = server.client('bob');
    await server.join(alice);
    await server.join(bob);
    await afterRotation();
    const fromBob = bob.sent.flat().find((e) => e.toId === 'alice')!.blob;

    alice.crypto.stop();
    alice.inbox('bob', fromBob);
    await afterRotation();

    expect(alice.frames.terminated).toBe(true);
    expect(alice.crypto.safetyCode()).toBeUndefined();
    expect(alice.crypto.secured()).toEqual(new Set());
    expect(alice.frames.sendKeys).toHaveLength(2);
  });
});
