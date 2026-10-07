import { Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { SignalingService } from '../signaling/signaling.service';
import { KeyEnvelopeDto, ParticipantDto } from '../signaling/signaling.types';
import {
  EnvelopeError,
  EnvelopeRejection,
  keyIndexOf,
  openEnvelope,
  sealEnvelope,
} from './envelopes';
import { FRAME_CRYPTO_FACTORY, FrameCrypto, frameTransformApi } from './frame-transforms';
import {
  Identity,
  IdentityBundle,
  VerifiedIdentity,
  createIdentity,
  verifyIdentity,
} from './identity';
import { SENDER_KEY_BYTES } from './keyring';
import { SafetyCode, safetyCode } from './safety-code';

/** Bursts of joins/leaves within this window cause one rotation. */
export const ROTATION_DEBOUNCE_MS = 300;
/** Receivers get this long to install a new key before we encrypt with it. */
export const SWITCH_DELAY_MS = 500;

/** Why an incoming envelope was dropped: counted locally, never sent anywhere. */
export type EnvelopeDrop = EnvelopeRejection | 'unknown-sender';

interface Peer {
  /** `undefined` once resolved: the bundle didn't verify — no envelopes to or from them. */
  identity: Promise<VerifiedIdentity | undefined>;
  /** Newest epoch accepted from them (replays and older keys are rejected). */
  lastEpoch?: number;
}

interface Session {
  roomId: string;
  selfId: string;
  identity: Identity;
  frames: FrameCrypto;
  peers: Map<string, Peer>;
  /** Our current rotation counter (-1 before the first key). */
  epoch: number;
  stopped: boolean;
  rotationTimer?: ReturnType<typeof setTimeout>;
  switchTimers: Set<ReturnType<typeof setTimeout>>;
  /** Rotations run one at a time, in order; so do incoming envelopes. */
  rotations: Promise<void>;
  envelopes: Promise<void>;
  unsubscribe: () => void;
}

/**
 * End-to-end encryption for one call (design: docs/plans/2026-10-07-e2ee-media-design.md): our per-call identity,
 * our sender keys and their rotation, others' keys from envelopes, the frame worker's keyring, and the safety code.
 * Provided per room route like MediaService. Components only ever get public data from it; MediaService gets the
 * frame transforms (`start`).
 *
 * - Our first key is used at once; after that we rotate on every join and leave (debounced), send the new key to
 *   every verified participant in one SendKeyEnvelopes call, and switch to it SWITCH_DELAY_MS later.
 * - Envelopes are only sent to, and accepted from, participants whose identity bundle verifies for this room.
 */
@Injectable()
export class CryptoService implements OnDestroy {
  private readonly signaling = inject(SignalingService);
  private readonly createFrames = inject(FRAME_CRYPTO_FACTORY);

  private identity?: Promise<Identity>;
  private identityRoom?: string;
  private session?: Session;
  private safetyCodeRun = 0;

  /** Everyone's code for this call (ours included); recomputed whenever the participant set changes. */
  readonly safetyCode = signal<SafetyCode | undefined>(undefined);
  /** Participants whose media key we have (their frames can be decrypted). */
  readonly secured = signal<ReadonlySet<string>>(new Set());
  /** Participants whose identity didn't verify: we exchange no keys with them. */
  readonly unverified = signal<ReadonlySet<string>>(new Set());
  /** Dropped envelopes by reason (diagnostics only). */
  readonly droppedEnvelopes = signal<Partial<Record<EnvelopeDrop, number>>>({});

  constructor() {
    effect(() => {
      const participants = this.signaling.participants();
      untracked(() => {
        if (this.session && !this.session.stopped) this.syncPeers(this.session, participants, true);
      });
    });
  }

  /**
   * Our public identity for this room, created on first use and kept for the call: a rejoin reuses it, so the
   * safety code doesn't change. Rejects when this browser lacks Ed25519/X25519 — there are no unencrypted calls.
   */
  async identityBundle(roomId: string): Promise<IdentityBundle> {
    return (await this.ensureIdentity(roomId)).bundle;
  }

  /**
   * Starts end-to-end encryption for the call we just joined as `selfId`: the frame worker with our first sender
   * key, and keys for everyone already there. Returns the frame transforms for MediaService. Rejects when this
   * browser can't encrypt — never fall back to plaintext.
   */
  async start(roomId: string, selfId: string): Promise<FrameCrypto> {
    this.stop();
    const identity = await this.ensureIdentity(roomId);
    const api = frameTransformApi();
    if (!api) throw new Error(UNSUPPORTED);

    const session: Session = {
      roomId,
      selfId,
      identity,
      frames: this.createFrames(api),
      peers: new Map(),
      epoch: -1,
      stopped: false,
      switchTimers: new Set(),
      rotations: Promise.resolve(),
      envelopes: Promise.resolve(),
      unsubscribe: this.signaling.onKeyEnvelope((fromId, blob) =>
        this.onEnvelope(session, fromId, blob),
      ),
    };
    this.session = session;
    this.syncPeers(session, this.signaling.participants(), false);
    void this.updateSafetyCode(session, this.signaling.participants());
    await this.enqueueRotation(session, true);
    return session.frames;
  }

  /** Ends the call's encryption: the worker and every key in it are gone. The identity stays for a rejoin. */
  stop(): void {
    const session = this.session;
    if (!session) return;
    session.stopped = true;
    session.unsubscribe();
    clearTimeout(session.rotationTimer);
    session.switchTimers.forEach((t) => clearTimeout(t));
    session.frames.terminate();
    this.session = undefined;
    this.safetyCodeRun++;
    this.safetyCode.set(undefined);
    this.secured.set(new Set());
    this.unverified.set(new Set());
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private async ensureIdentity(roomId: string): Promise<Identity> {
    if (!this.identity || this.identityRoom !== roomId) {
      this.identityRoom = roomId;
      this.identity = createIdentity(roomId);
    }
    try {
      return await this.identity;
    } catch {
      this.identity = undefined;
      throw new Error(UNSUPPORTED);
    }
  }

  /** Follows the room: verifies newcomers, forgets leavers (and their keys), rotates when anything changed. */
  private syncPeers(
    session: Session,
    participants: readonly ParticipantDto[],
    rotate: boolean,
  ): void {
    const present = new Set(participants.map((p) => p.id));
    let changed = false;

    for (const p of participants) {
      if (session.peers.has(p.id) || p.id === session.selfId) continue;
      const identity = verifyIdentity(p.identity, session.roomId).then((verified) => {
        if (!verified && session.peers.get(p.id)?.identity === identity) {
          this.unverified.update((ids) => new Set(ids).add(p.id));
        }
        return verified;
      });
      session.peers.set(p.id, { identity });
      changed = true;
    }
    for (const id of [...session.peers.keys()]) {
      if (present.has(id)) continue;
      session.peers.delete(id);
      session.frames.removeParticipant(id);
      this.secured.update((ids) => without(ids, id));
      this.unverified.update((ids) => without(ids, id));
      changed = true;
    }

    if (!changed) return;
    void this.updateSafetyCode(session, participants);
    if (rotate) this.scheduleRotation(session);
  }

  private scheduleRotation(session: Session): void {
    clearTimeout(session.rotationTimer);
    session.rotationTimer = setTimeout(() => {
      session.rotationTimer = undefined;
      void this.enqueueRotation(session, false);
    }, ROTATION_DEBOUNCE_MS);
  }

  private enqueueRotation(session: Session, first: boolean): Promise<void> {
    const run = session.rotations.then(() => this.rotate(session, first));
    // A failed rotation must not block the next one.
    session.rotations = run.catch(() => undefined);
    return run;
  }

  /**
   * New sender key → envelopes for every verified participant → SendKeyEnvelopes → switch. The first key is used at
   * once (nobody can have an older one); later keys after SWITCH_DELAY_MS, or at once if sending failed — we never
   * keep encrypting with a key someone who left may hold.
   */
  private async rotate(session: Session, first: boolean): Promise<void> {
    if (session.stopped) return;
    const epoch = session.epoch + 1;
    const keyIndex = keyIndexOf(epoch);
    const senderKey = crypto.getRandomValues(new Uint8Array(SENDER_KEY_BYTES));

    const recipients = await this.verifiedPeers(session);
    const envelopes: KeyEnvelopeDto[] = await Promise.all(
      recipients.map(async ([toId, identity]) => ({
        toId,
        blob: await sealEnvelope(
          { roomId: session.roomId, epoch, keyIndex, fromId: session.selfId, toId },
          senderKey,
          session.identity,
          identity,
        ),
      })),
    );
    if (session.stopped) return;
    session.epoch = epoch;

    // The buffer is transferred to the worker: no copy of the key stays here.
    const useKey = () => {
      if (!session.stopped) session.frames.setSendKey(keyIndex, senderKey.buffer);
    };
    if (first) useKey();

    const sent =
      envelopes.length === 0 ||
      (await this.signaling.sendKeyEnvelopes(envelopes).then(
        () => true,
        () => false,
      ));
    if (first) return;
    if (!sent) return useKey();
    const timer = setTimeout(() => {
      session.switchTimers.delete(timer);
      useKey();
    }, SWITCH_DELAY_MS);
    session.switchTimers.add(timer);
  }

  private async verifiedPeers(session: Session): Promise<[string, VerifiedIdentity][]> {
    const peers = await Promise.all(
      [...session.peers].map(async ([id, peer]) => [id, await peer.identity] as const),
    );
    return peers.filter((p): p is [string, VerifiedIdentity] => p[1] !== undefined);
  }

  private onEnvelope(session: Session, fromId: string, blob: string): void {
    // ParticipantJoined always arrives first, but the effect that follows it may not have run yet.
    if (!session.peers.has(fromId)) this.syncPeers(session, this.signaling.participants(), true);
    session.envelopes = session.envelopes
      .then(() => this.receive(session, fromId, blob))
      .catch(() => undefined);
  }

  private async receive(session: Session, fromId: string, blob: string): Promise<void> {
    const peer = session.peers.get(fromId);
    const sender = await peer?.identity;
    if (!peer || !sender) return this.drop('unknown-sender');
    try {
      const opened = await openEnvelope(
        blob,
        { roomId: session.roomId, selfId: session.selfId, fromId, lastEpoch: peer.lastEpoch },
        session.identity,
        sender,
      );
      // They may have left (or we stopped) while we were opening it.
      if (session.stopped || session.peers.get(fromId) !== peer) return;
      peer.lastEpoch = opened.epoch;
      session.frames.setReceiveKey(fromId, opened.keyIndex, opened.senderKey);
      this.secured.update((ids) => (ids.has(fromId) ? ids : new Set(ids).add(fromId)));
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e;
      this.drop(e.reason);
    }
  }

  private drop(reason: EnvelopeDrop): void {
    this.droppedEnvelopes.update((counts) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }));
  }

  private async updateSafetyCode(
    session: Session,
    participants: readonly ParticipantDto[],
  ): Promise<void> {
    const run = ++this.safetyCodeRun;
    const keys = [
      session.identity.bundle.ed25519Pub,
      ...participants.filter((p) => p.id !== session.selfId).map((p) => p.identity.ed25519Pub),
    ];
    const code = await safetyCode(session.roomId, keys).catch(() => undefined);
    if (run === this.safetyCodeRun) this.safetyCode.set(code);
  }
}

const UNSUPPORTED = "This browser can't encrypt calls.";

function without(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}
