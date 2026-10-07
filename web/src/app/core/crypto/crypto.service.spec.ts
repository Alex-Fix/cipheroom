import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SignalingService } from '../signaling/signaling.service';
import { KeyEnvelopeDto, ParticipantDto } from '../signaling/signaling.types';
import {
  CryptoService,
  MAX_ENVELOPES_PER_CALL,
  ROTATION_DEBOUNCE_MS,
  SWITCH_DELAY_MS,
} from './crypto.service';
import { fromBase64Url, toBase64Url, utf8 } from './encoding';
import { FRAME_CRYPTO_FACTORY } from './frame-transforms';
import { verifyIdentity } from './identity';

const ROOM = 'team-sync';

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
  participants: ReturnType<typeof signal<ParticipantDto[]>>;
  sent: KeyEnvelopeDto[][];
  inbox: (fromId: string, blob: string) => void;
  failSends: boolean;
}

/** The api, as far as keys go: relays envelopes to their recipient, with the sender's id. */
class FakeServer {
  readonly clients = new Map<string, Client>();

  client(id: string): Client {
    const frames = new FakeFrames();
    const participants = signal<ParticipantDto[]>([]);
    const client = { id, frames, participants, sent: [], failSends: false } as unknown as Client;
    const signaling = {
      participants,
      sendKeyEnvelopes: vi.fn(async (envelopes: KeyEnvelopeDto[]) => {
        if (client.failSends) throw new Error('Media server unavailable.');
        client.sent.push(envelopes);
        for (const e of envelopes)
          queueMicrotask(() => this.clients.get(e.toId)?.inbox(id, e.blob));
      }),
      onKeyEnvelope: (listener: (fromId: string, blob: string) => void) => {
        client.inbox = listener;
        return () => (client.inbox = () => undefined);
      },
    };
    const injector = createEnvironmentInjector(
      [
        CryptoService,
        { provide: SignalingService, useValue: signaling },
        { provide: FRAME_CRYPTO_FACTORY, useValue: () => frames },
      ],
      TestBed.inject(EnvironmentInjector),
    );
    client.crypto = injector.get(CryptoService);
    client.inbox = () => undefined;
    this.clients.set(id, client);
    return client;
  }

  /** Joins `client` to the room: others learn about it, it learns about them; then it starts encryption. */
  async join(client: Client): Promise<void> {
    const identity = await client.crypto.identityBundle(ROOM);
    const me: ParticipantDto = { id: client.id, displayName: client.id, tracks: [], identity };
    const others = [...this.clients.values()].filter((c) => c !== client && this.inRoom.has(c.id));
    client.participants.set(others.map((c) => this.dto(c)));
    this.inRoom.set(client.id, me);
    others.forEach((c) => c.participants.update((list) => [...list, me]));
    await client.crypto.start(ROOM, client.id);
  }

  leave(client: Client): void {
    this.inRoom.delete(client.id);
    client.crypto.stop();
    for (const c of this.clients.values()) {
      c.participants.update((list) => list.filter((p) => p.id !== client.id));
    }
  }

  private readonly inRoom = new Map<string, ParticipantDto>();

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
const receiveKeys = (c: Client, from: string) =>
  c.frames.receiveKeys.filter((k) => k.participantId === from);

describe('CryptoService', () => {
  let server: FakeServer;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('RTCRtpScriptTransform', class {});
    server = new FakeServer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('creates a verifiable identity and keeps it for the call (rejoins keep the safety code)', async () => {
      const { crypto } = server.client('alice');
      const bundle = await crypto.identityBundle(ROOM);
      expect(await verifyIdentity(bundle, ROOM)).toBeDefined();
      expect(await crypto.identityBundle(ROOM)).toBe(bundle);
      expect((await crypto.identityBundle('other-room')).ed25519Pub).not.toBe(bundle.ed25519Pub);
    });

    it('refuses without Ed25519/X25519 — no unencrypted calls', async () => {
      const { crypto } = server.client('alice');
      vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockRejectedValue(
        new DOMException('', 'NotSupportedError'),
      );
      await expect(crypto.identityBundle(ROOM)).rejects.toThrow(
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
        Array.from({ length: MAX_ENVELOPES_PER_CALL + 6 }, async (_, i) => ({
          id: `p${i}`,
          displayName: `P${i}`,
          tracks: [],
          identity: await server.client(`p${i}`).crypto.identityBundle(ROOM),
        })),
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
      const realMallory = await server.client('mallory').crypto.identityBundle(ROOM);
      // The server swaps Mallory's agreement key: the self-signature no longer matches.
      const forged = {
        ...realMallory,
        x25519Pub: (await alice.crypto.identityBundle(ROOM)).x25519Pub,
      };
      alice.participants.update((list) => [
        ...list,
        { id: 'mallory', displayName: 'Mallory', tracks: [], identity: forged },
      ]);
      await afterRotation();

      expect(alice.crypto.unverified()).toEqual(new Set(['mallory']));
      expect(alice.sent.flat().map((e) => e.toId)).not.toContain('mallory');

      alice.inbox('mallory', 'AAAA');
      await settle();
      expect(alice.crypto.droppedEnvelopes()).toEqual({ 'unknown-sender': 1 });
      expect(receiveKeys(alice, 'mallory')).toEqual([]);
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
      const ghost = await server.client('ghost').crypto.identityBundle(ROOM);
      bob.participants.update((list) => [
        ...list,
        { id: 'ghost', displayName: 'Alice', tracks: [], identity: ghost },
      ]);
      await settle();

      expect(alice.crypto.safetyCode()).not.toEqual(bob.crypto.safetyCode());
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
