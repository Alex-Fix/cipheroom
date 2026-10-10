import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { SignalingService } from '../signaling/signaling.service';
import {
  AdmitterDto,
  AuthorityDto,
  HostProofDto,
  KeyEnvelopeDto,
  KnockDto,
  LobbyGuestDto,
  ParticipantDto,
} from '../signaling/signaling.types';
import {
  DeviceProof,
  EnvelopeError,
  EnvelopeRejection,
  keyIndexOf,
  openEnvelope,
  sealEnvelope,
} from './envelopes';
import {
  ChatError,
  ChatEvent,
  ReceivedChatEvent,
  chatKey,
  chatKeyIndex,
  openChat,
  sealChat,
} from './chat-crypto';
import { FRAME_CRYPTO_FACTORY, FrameCrypto, frameTransformApi } from './frame-transforms';
import {
  Identity,
  IdentityBundle,
  VerifiedIdentity,
  createIdentity,
  verifyIdentity,
} from './identity';
import { signHostAttestation } from './host-key';
import { HOST_KEY_STORE } from './host-key-store';
import { DEVICE_KEY_STORE } from './device-key-store';
import { signDeviceStatement } from './device-key';
import { fromBase64Url } from './encoding';
import { PREVIOUS_KEY_GRACE_MS, SENDER_KEY_BYTES } from './keyring';
import { openKnock, sealKnock } from './knock';
import { cleanName } from './names';
import { SafetyCode, safetyCode } from './safety-code';
import {
  Authority,
  NO_AUTHORITY,
  coHostMessage,
  endMessage,
  isAdmitted,
  isAdmitter,
  isHost,
  muteMessage,
  revokeMessage,
  settingsMessage,
  sign,
  ticketMessage,
  verify,
  verifyAuthority,
} from './statements';
import { E2EE_UNSUPPORTED } from './support';
import type { E2eeStatsDto } from '../signaling/signaling.types';

/** Bursts of joins/leaves within this window cause one rotation. */
export const ROTATION_DEBOUNCE_MS = 300;
/** Receivers get this long to install a new key before we encrypt with it. */
export const SWITCH_DELAY_MS = 500;
/** The server accepts this many envelopes per SendKeyEnvelopes call (KeyRules.MaxEnvelopesPerRequest). */
export const MAX_ENVELOPES_PER_CALL = 64;
/** Chat events that arrive before their sender's key (a newcomer's first key races their first message). */
export const MAX_PENDING_CHAT = 64;
export const PENDING_CHAT_MS = 10_000;

/** A chat event to send; CryptoService adds the version and our sequence number. */
export type ChatEventBody =
  | { type: 'message'; id: string; text: string }
  | { type: 'reaction'; target: string; emoji: string; on: boolean };

export type ChatEventListener = (received: ReceivedChatEvent) => void;

/** Why an incoming envelope was dropped: counted locally, never sent anywhere. */
export type EnvelopeDrop = EnvelopeRejection | 'unknown-sender';

/** What someone may do in the call, as far as our own checks of the signed authority go. */
export type Role = 'host' | 'cohost' | 'guest';

/** A signed request with its sequence number (settings, ask-to-mute). */
export interface SignedSeq {
  seq: number;
  sig: string;
}

interface Peer {
  /** Their Ed25519 identity key (base64url). */
  pub: string;
  /**
   * `undefined` once resolved: the bundle didn't verify, or nobody with authority admitted them (no valid ticket),
   * or they were removed — no envelopes to or from them.
   */
  identity: Promise<VerifiedIdentity | undefined>;
  /** Newest epoch accepted from them (replays and older keys are rejected). */
  lastEpoch?: number;
}

interface ChatReceiveKey {
  key: CryptoKey;
  /** Set once a newer key from the same sender arrived. */
  expiresAt?: number;
}

interface PendingChat {
  fromId: string;
  blob: string;
  until: number;
}

interface Session {
  roomId: string;
  selfId: string;
  /** Ours, sent to everyone inside our key envelopes (never to the server in plaintext). */
  name: string;
  identity: Identity;
  /** Our device key's statement for this call's identity, in every envelope (none until the user sets one up). */
  device?: DeviceProof;
  frames: FrameCrypto;
  peers: Map<string, Peer>;
  /** Our current rotation counter (-1 before the first key). */
  epoch: number;
  stopped: boolean;
  rotationTimer?: ReturnType<typeof setTimeout>;
  switchTimers: Set<ReturnType<typeof setTimeout>>;
  /** Rotations run one at a time, in order; so do incoming envelopes and chat events. */
  rotations: Promise<void>;
  envelopes: Promise<void>;
  chats: Promise<void>;
  /** Our chat key: switches together with our media key. */
  chatSend?: { keyIndex: number; key: CryptoKey };
  /** Others' chat keys by participant and key index. */
  chatReceive: Map<string, Map<number, ChatReceiveKey>>;
  pendingChat: PendingChat[];
  unsubscribe: () => void;
}

/**
 * End-to-end encryption for one call (design: docs/plans/2026-10-07-e2ee-media-design.md): our per-call identity,
 * our sender keys and their rotation, others' keys and names from envelopes, the frame worker's keyring, the safety
 * code — and the room's signed authority (docs/plans/2026-10-08-lobby-admission-design.md): host proofs, tickets,
 * co-host grants, removals, settings, mute and end requests, knocks. Provided per room route like MediaService.
 * Components only ever get public data from it; MediaService gets the frame transforms (`start`).
 *
 * - Our first key is used at once; after that we rotate on every join and leave (debounced), send the new key to
 *   every verified participant in one SendKeyEnvelopes call, and switch to it SWITCH_DELAY_MS later.
 * - Envelopes are only sent to, and accepted from, participants whose identity bundle verifies for this room AND who
 *   were admitted by someone the host key vouches for (host attestation or ticket), and weren't removed. Someone a
 *   malicious server slips into the call gets no keys.
 */
@Injectable()
export class CryptoService implements OnDestroy {
  private readonly signaling = inject(SignalingService);
  private readonly createFrames = inject(FRAME_CRYPTO_FACTORY);
  private readonly hostKeys = inject(HOST_KEY_STORE);
  private readonly deviceKeys = inject(DEVICE_KEY_STORE);

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
  /**
   * Participants' long-term device keys (base64url), from statements that verified over their per-call identity
   * inside their key envelopes. Who has none isn't listed. docs/plans/2026-10-10-contacts-tofu-design.md
   */
  readonly devices = signal<ReadonlyMap<string, string>>(new Map());
  /** Display names by participant id, as each participant signed them in their key envelopes (ours included). */
  readonly names = signal<ReadonlyMap<string, string>>(new Map());
  /** The room's authority after our own verification (hosts, co-hosts, removals, auto-admit). */
  readonly authority = signal<Authority>(NO_AUTHORITY);
  /** Our identity key for this call (base64url), once created. */
  private readonly selfPub = signal<string | undefined>(undefined);
  /** Our identity key for this call: how chat tells our own reactions apart (stable across rejoins). */
  readonly identityPub = this.selfPub.asReadonly();
  /** We hold a chat key: messages can be sent. */
  readonly chatReady = signal(false);
  /** We may admit, deny, remove, ask to mute and end the call. */
  readonly canAdmit = computed(() => {
    const pub = this.selfPub();
    return !!pub && isAdmitter(this.authority(), pub);
  });
  /** We are the host (may also make co-hosts and change settings). */
  readonly isHost = computed(() => {
    const pub = this.selfPub();
    return !!pub && isHost(this.authority(), pub);
  });

  private authorityDto?: AuthorityDto;
  private authorityCheck: Promise<Authority> = Promise.resolve(NO_AUTHORITY);
  /**
   * Every removal we have verified in this call (identity keys). A removal is for good: an authority from the server
   * that no longer lists one (an api restart, or a server lying by omission) never lets that person back in.
   */
  private readonly removed = new Set<string>();
  private muteSeq = 0;
  private readonly lastMuteSeq = new Map<string, number>();
  /** Our chat sequence number and the newest one seen from each author's identity (replays are dropped). */
  private chatSeq = 0;
  private readonly lastChatSeq = new Map<string, number>();
  private readonly chatListeners = new Set<ChatEventListener>();

  /** When we started waiting for each participant's first key (time spent "Securing…", for call-quality reports). */
  private readonly securingSince = new Map<string, number>();
  private securingMs = 0;

  constructor() {
    // Authority first: a newcomer's ticket may rely on a grant that arrived just before them.
    effect(() => {
      const dto = this.signaling.authority();
      untracked(() => void this.updateAuthority(dto));
    });
    effect(() => {
      const participants = this.signaling.participants();
      untracked(() => {
        if (this.session && !this.session.stopped) this.syncPeers(this.session, participants, true);
      });
    });
  }

  /** What our checks say someone with this identity may do (for labels and menus). */
  roleOf(identityPub: string): Role {
    const authority = this.authority();
    if (isHost(authority, identityPub)) return 'host';
    return isAdmitter(authority, identityPub) ? 'cohost' : 'guest';
  }

  /**
   * Proof that we are this room's host, if this browser holds its host key: the host key's signature over our
   * per-call identity. Null otherwise (we'll wait in the lobby like everyone else).
   */
  async hostProof(roomId: string): Promise<HostProofDto | null> {
    const hostKey = await this.hostKeys.get(roomId).catch(() => undefined);
    if (!hostKey) return null;
    const identity = await this.ensureIdentity(roomId);
    return {
      hostEd25519Pub: hostKey.ed25519Pub,
      hostX25519Pub: hostKey.x25519Pub,
      attestation: await signHostAttestation(hostKey, identity.bundle.ed25519Pub),
    };
  }

  /** Our name encrypted to each admitter whose identity and authority check out (the server sees ciphertext only). */
  async sealKnocks(admitters: readonly AdmitterDto[], name: string): Promise<KnockDto[]> {
    const { roomId, identity } = await this.current();
    const authority = await this.latestAuthority();
    const knocks: KnockDto[] = [];
    for (const admitter of admitters) {
      if (!isAdmitter(authority, admitter.identity.ed25519Pub)) continue;
      const verified = await verifyIdentity(admitter.identity, roomId);
      if (verified)
        knocks.push({
          toId: admitter.id,
          blob: await sealKnock(roomId, cleanName(name), identity, verified),
        });
    }
    return knocks;
  }

  /** A guest's name from their knock to us; undefined if it doesn't verify (then we ignore the knock). */
  async openKnock(guest: LobbyGuestDto, blob: string): Promise<string | undefined> {
    const { roomId, identity } = await this.current();
    const verified = await verifyIdentity(guest.identity, roomId);
    return verified ? openKnock(roomId, blob, identity, verified) : undefined;
  }

  /** Our admission ticket for a guest (their identity key). */
  signTicket(guestPub: string): Promise<string> {
    return this.signWith((roomId, self) => ticketMessage(roomId, self, guestPub));
  }

  signCoHostGrant(pub: string): Promise<string> {
    return this.signWith((roomId, self) => coHostMessage(roomId, self, pub));
  }

  signRemoval(pub: string): Promise<string> {
    return this.signWith((roomId, self) => revokeMessage(roomId, self, pub));
  }

  async signSettings(autoAdmit: boolean): Promise<SignedSeq> {
    const seq = this.authority().settingsSeq + 1;
    return {
      seq,
      sig: await this.signWith((roomId, self) => settingsMessage(roomId, self, seq, autoAdmit)),
    };
  }

  async signMuteRequest(pub: string): Promise<SignedSeq> {
    const seq = ++this.muteSeq;
    return { seq, sig: await this.signWith((roomId, self) => muteMessage(roomId, self, pub, seq)) };
  }

  signEnd(): Promise<string> {
    return this.signWith((roomId, self) => endMessage(roomId, self));
  }

  /** Whether "call ended" really comes from a host or co-host of this room. */
  async verifyEnd(issuer: string, sig: string): Promise<boolean> {
    const roomId = this.identityRoom;
    const authority = await this.latestAuthority();
    return (
      !!roomId && isAdmitter(authority, issuer) && verify(issuer, endMessage(roomId, issuer), sig)
    );
  }

  /** Whether "please mute" really comes from an admitter in the call, and is newer than the last one from them. */
  async verifyMuteRequest(fromId: string, seq: number, sig: string): Promise<boolean> {
    const roomId = this.identityRoom;
    const self = this.selfPub();
    const issuer = this.signaling.participants().find((p) => p.id === fromId)?.identity.ed25519Pub;
    const authority = await this.latestAuthority();
    if (!roomId || !self || !issuer || !isAdmitter(authority, issuer)) return false;
    if (!Number.isInteger(seq) || seq <= (this.lastMuteSeq.get(issuer) ?? 0)) return false;
    if (!(await verify(issuer, muteMessage(roomId, issuer, self, seq), sig))) return false;
    this.lastMuteSeq.set(issuer, seq);
    return true;
  }

  /**
   * Our public identity for this room, created on first use and kept for the call: a rejoin reuses it, so the
   * safety code doesn't change. Rejects when this browser can't do encrypted calls (no encoded transforms or no
   * Ed25519/X25519) — call it before joining; there are no unencrypted calls.
   */
  async identityBundle(roomId: string): Promise<IdentityBundle> {
    return (await this.ensureIdentity(roomId)).bundle;
  }

  /**
   * Starts end-to-end encryption for the call we just joined as `selfId`: the frame worker with our first sender
   * key, and keys for everyone already there. Returns the frame transforms for MediaService. Rejects when this
   * browser can't encrypt — never fall back to plaintext.
   */
  async start(roomId: string, selfId: string, name: string): Promise<FrameCrypto> {
    this.stop();
    const identity = await this.ensureIdentity(roomId);
    const api = frameTransformApi();
    if (!api) throw new Error(E2EE_UNSUPPORTED);

    const device = await this.deviceProof(roomId, identity);
    const session: Session = {
      roomId,
      selfId,
      name: cleanName(name),
      identity,
      device,
      frames: this.createFrames(api),
      peers: new Map(),
      epoch: -1,
      stopped: false,
      switchTimers: new Set(),
      rotations: Promise.resolve(),
      envelopes: Promise.resolve(),
      chats: Promise.resolve(),
      chatReceive: new Map(),
      pendingChat: [],
      unsubscribe: () => undefined,
    };
    const unsubscribeEnvelopes = this.signaling.onKeyEnvelope((fromId, blob) =>
      this.onEnvelope(session, fromId, blob),
    );
    const unsubscribeChat = this.signaling.onChat((fromId, blob) =>
      this.onChat(session, fromId, blob),
    );
    session.unsubscribe = () => {
      unsubscribeEnvelopes();
      unsubscribeChat();
    };
    this.session = session;
    this.names.set(new Map([[selfId, session.name]]));
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
    session.chatSend = undefined;
    session.chatReceive.clear();
    session.pendingChat = [];
    [...this.securingSince.keys()].forEach((id) => this.stopWaiting(id));
    this.session = undefined;
    this.chatReady.set(false);
    this.safetyCodeRun++;
    this.safetyCode.set(undefined);
    this.secured.set(new Set());
    this.unverified.set(new Set());
    this.names.set(new Map());
    this.devices.set(new Map());
  }

  ngOnDestroy(): void {
    this.stop();
  }

  /**
   * One chat event, signed by our identity and encrypted with our current chat key, as the blob for SendChat.
   * Rejects before our first key (chatReady) — there is no unencrypted chat.
   */
  async sealChat(body: ChatEventBody): Promise<string> {
    const session = this.session;
    const send = session?.chatSend;
    if (!session || session.stopped || !send) throw new Error('Chat is not ready.');
    const event = { v: 1, seq: ++this.chatSeq, ...body } as ChatEvent;
    return sealChat(
      { roomId: session.roomId, fromId: session.selfId, keyIndex: send.keyIndex, key: send.key },
      event,
      session.identity,
    );
  }

  /** Chat events from others that decrypted and whose author's signature checked out. Returns an unsubscribe. */
  onChatEvent(listener: ChatEventListener): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  /**
   * End-to-end encryption health since this call's encryption started, for call-quality reports: frame counters from
   * the worker, dropped envelopes, and the total time participants spent "Securing…". Counts and seconds only.
   */
  telemetry(now = Date.now()): E2eeStatsDto {
    const frames = this.session?.frames.latestStats;
    let waiting = 0;
    this.securingSince.forEach((since) => (waiting += now - since));
    return {
      framesEncrypted: frames?.encrypted ?? 0,
      framesDecrypted: frames?.decrypted ?? 0,
      framesFailed: frames?.failed ?? 0,
      framesMissingKey: frames?.missingKey ?? 0,
      envelopesDropped: Object.values(this.droppedEnvelopes()).reduce((a, b) => a + (b ?? 0), 0),
      securingSeconds: (this.securingMs + waiting) / 1000,
    };
  }

  /** Our device key vouching for this call's identity, if this browser has one (a broken store just means none). */
  private async deviceProof(roomId: string, identity: Identity): Promise<DeviceProof | undefined> {
    const deviceKey = await this.deviceKeys.get().catch(() => undefined);
    if (!deviceKey) return undefined;
    return {
      pub: fromBase64Url(deviceKey.pub),
      sig: await signDeviceStatement(deviceKey, roomId, identity.bundle.ed25519Pub),
    };
  }

  private stopWaiting(id: string): void {
    const since = this.securingSince.get(id);
    if (since === undefined) return;
    this.securingMs += Date.now() - since;
    this.securingSince.delete(id);
  }

  private async ensureIdentity(roomId: string): Promise<Identity> {
    if (!frameTransformApi()) throw new Error(E2EE_UNSUPPORTED);
    if (!this.identity || this.identityRoom !== roomId) {
      this.identityRoom = roomId;
      this.identity = createIdentity(roomId);
      this.muteSeq = 0;
      this.lastMuteSeq.clear();
      this.chatSeq = 0;
      this.lastChatSeq.clear();
      this.removed.clear();
      void this.updateAuthority(this.signaling.authority());
    }
    try {
      const identity = await this.identity;
      this.selfPub.set(identity.bundle.ed25519Pub);
      return identity;
    } catch {
      this.identity = undefined;
      throw new Error(E2EE_UNSUPPORTED);
    }
  }

  /** The room and identity statements are made with (after identityBundle). */
  private async current(): Promise<{ roomId: string; identity: Identity }> {
    const roomId = this.identityRoom;
    if (!roomId) throw new Error('No identity yet.');
    return { roomId, identity: await this.ensureIdentity(roomId) };
  }

  private async signWith(
    message: (roomId: string, selfPub: string) => Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    const { roomId, identity } = await this.current();
    return sign(identity, message(roomId, identity.bundle.ed25519Pub));
  }

  /**
   * Our verification of the newest authority the server relayed — not just the last one an effect handled, so a
   * newcomer is never checked against an authority from before the statement that admitted them.
   */
  private latestAuthority(): Promise<Authority> {
    return this.updateAuthority(this.signaling.authority());
  }

  /** Verifies a new authority from the server, then re-checks everyone in the call against it. */
  private updateAuthority(dto: AuthorityDto | undefined): Promise<Authority> {
    const roomId = this.identityRoom;
    if (!dto || !roomId) {
      this.authorityDto = undefined;
      this.authority.set(NO_AUTHORITY);
      return (this.authorityCheck = Promise.resolve(NO_AUTHORITY));
    }
    if (dto === this.authorityDto) return this.authorityCheck;
    this.authorityDto = dto;
    const check = verifyAuthority(roomId, dto)
      .catch(() => NO_AUTHORITY)
      .then((verified) => this.withRemovals(verified));
    this.authorityCheck = check;
    void check.then((authority) => {
      if (this.authorityCheck !== check) return;
      this.authority.set(authority);
      if (this.session && !this.session.stopped) void this.recheckPeers(this.session, authority);
    });
    return check;
  }

  /** Adds this authority's removals to the ones we keep, and returns it with all of them. */
  private withRemovals(authority: Authority): Authority {
    authority.revoked.forEach((identity) => this.removed.add(identity));
    if (this.removed.size === authority.revoked.size) return authority;
    return { ...authority, revoked: new Set(this.removed) };
  }

  /**
   * After the authority changed: peers who were removed lose their keys at once; peers we couldn't verify before
   * (their admitter's grant arrived late) get another chance. Either way we rotate.
   */
  private async recheckPeers(session: Session, authority: Authority): Promise<void> {
    let changed = false;
    for (const [id, peer] of session.peers) {
      if (authority.revoked.has(peer.pub)) {
        if ((await peer.identity) === undefined && this.unverified().has(id)) continue;
        peer.identity = Promise.resolve(undefined);
        session.frames.removeParticipant(id);
        this.forgetChat(session, id);
        this.stopWaiting(id);
        this.secured.update((ids) => without(ids, id));
        this.unverified.update((ids) => new Set(ids).add(id));
        changed = true;
      } else if ((await peer.identity) === undefined) {
        const participant = this.signaling.participants().find((p) => p.id === id);
        if (!participant) continue;
        const retry = this.verifyPeer(session, participant);
        peer.identity = retry;
        if (await retry) {
          this.unverified.update((ids) => without(ids, id));
          changed = true;
        }
      }
    }
    if (changed && !session.stopped) this.scheduleRotation(session);
  }

  /** Their bundle verifies for this room, and someone the host key vouches for admitted them. */
  private async verifyPeer(
    session: Session,
    p: ParticipantDto,
  ): Promise<VerifiedIdentity | undefined> {
    const [verified, authority] = await Promise.all([
      verifyIdentity(p.identity, session.roomId),
      this.latestAuthority(),
    ]);
    if (!verified) return undefined;
    return (await isAdmitted(session.roomId, authority, p.identity, p.ticket))
      ? verified
      : undefined;
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
      const identity = this.verifyPeer(session, p).then((verified) => {
        if (!verified && session.peers.get(p.id)?.identity === identity) {
          this.unverified.update((ids) => new Set(ids).add(p.id));
          this.stopWaiting(p.id); // no key will come unless the authority changes
        }
        return verified;
      });
      session.peers.set(p.id, { pub: p.identity.ed25519Pub, identity });
      this.securingSince.set(p.id, Date.now());
      changed = true;
    }
    for (const id of [...session.peers.keys()]) {
      if (present.has(id)) continue;
      session.peers.delete(id);
      session.frames.removeParticipant(id);
      this.forgetChat(session, id);
      this.stopWaiting(id);
      this.secured.update((ids) => without(ids, id));
      this.unverified.update((ids) => without(ids, id));
      this.names.update((names) => withoutKey(names, id));
      this.devices.update((devices) => withoutKey(devices, id));
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
          session.name,
          session.identity,
          identity,
          session.device,
        ),
      })),
    );
    // Before the buffer goes to the worker, which detaches it.
    const chat = await chatKey(senderKey);
    if (session.stopped) return;
    session.epoch = epoch;

    // The buffer is transferred to the worker: no copy of the key stays here. Chat switches at the same moment.
    const useKey = () => {
      if (session.stopped) return;
      session.frames.setSendKey(keyIndex, senderKey.buffer);
      session.chatSend = { keyIndex, key: chat };
      this.chatReady.set(true);
    };
    if (first) useKey();

    const sent = await this.send(envelopes);
    if (first) return;
    if (!sent) return useKey();
    const timer = setTimeout(() => {
      session.switchTimers.delete(timer);
      useKey();
    }, SWITCH_DELAY_MS);
    session.switchTimers.add(timer);
  }

  /** One call per MAX_ENVELOPES_PER_CALL recipients (the server's limit). False if any batch failed. */
  private async send(envelopes: KeyEnvelopeDto[]): Promise<boolean> {
    const batches: KeyEnvelopeDto[][] = [];
    for (let i = 0; i < envelopes.length; i += MAX_ENVELOPES_PER_CALL) {
      batches.push(envelopes.slice(i, i + MAX_ENVELOPES_PER_CALL));
    }
    const results = await Promise.all(
      batches.map((batch) =>
        this.signaling.sendKeyEnvelopes(batch).then(
          () => true,
          () => false,
        ),
      ),
    );
    return results.every(Boolean);
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
      // Before the sender key goes to the worker, which detaches it.
      const chat = await chatKey(opened.senderKey);
      // They may have left (or we stopped) while we were opening it.
      if (session.stopped || session.peers.get(fromId) !== peer) return;
      peer.lastEpoch = opened.epoch;
      session.frames.setReceiveKey(fromId, opened.keyIndex, opened.senderKey);
      this.setChatReceiveKey(session, fromId, opened.keyIndex, chat);
      if (this.names().get(fromId) !== opened.name) {
        this.names.update((names) => new Map(names).set(fromId, opened.name));
      }
      if (opened.device && this.devices().get(fromId) !== opened.device) {
        this.devices.update((devices) => new Map(devices).set(fromId, opened.device!));
      }
      this.stopWaiting(fromId);
      this.secured.update((ids) => (ids.has(fromId) ? ids : new Set(ids).add(fromId)));
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e;
      this.drop(e.reason);
    }
  }

  private setChatReceiveKey(
    session: Session,
    fromId: string,
    keyIndex: number,
    key: CryptoKey,
  ): void {
    const keys = session.chatReceive.get(fromId) ?? new Map<number, ChatReceiveKey>();
    const expiresAt = Date.now() + PREVIOUS_KEY_GRACE_MS;
    for (const [index, entry] of keys) if (index !== keyIndex) entry.expiresAt ??= expiresAt;
    keys.set(keyIndex, { key });
    session.chatReceive.set(fromId, keys);
    // Events that came before this key get another go, in the order they arrived.
    if (session.pendingChat.some((p) => p.fromId === fromId)) {
      this.enqueueChat(session, () => this.flushPendingChat(session, fromId));
    }
  }

  private chatReceiveKey(
    session: Session,
    fromId: string,
    keyIndex: number,
  ): CryptoKey | undefined {
    const keys = session.chatReceive.get(fromId);
    const entry = keys?.get(keyIndex);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      keys!.delete(keyIndex);
      return undefined;
    }
    return entry.key;
  }

  /** A leaver's or removed participant's chat keys and waiting events are gone at once. */
  private forgetChat(session: Session, id: string): void {
    session.chatReceive.delete(id);
    session.pendingChat = session.pendingChat.filter((p) => p.fromId !== id);
  }

  private onChat(session: Session, fromId: string, blob: string): void {
    if (!session.peers.has(fromId)) this.syncPeers(session, this.signaling.participants(), true);
    this.enqueueChat(session, () => this.receiveChat(session, fromId, blob));
  }

  /** Chat events are handled one at a time, in order (sequence numbers must only grow). */
  private enqueueChat(session: Session, work: () => Promise<void>): void {
    session.chats = session.chats.then(work).catch(() => undefined);
  }

  private async receiveChat(session: Session, fromId: string, blob: string): Promise<void> {
    if (session.stopped) return;
    let keyIndex: number;
    try {
      keyIndex = chatKeyIndex(blob);
    } catch {
      return;
    }
    // Keep the sender's order: behind anything of theirs that is still waiting for a key.
    const waiting = session.pendingChat.some((p) => p.fromId === fromId);
    if (waiting || !this.chatReceiveKey(session, fromId, keyIndex)) {
      const now = Date.now();
      session.pendingChat = session.pendingChat.filter((p) => p.until > now);
      if (session.pendingChat.length < MAX_PENDING_CHAT && session.peers.has(fromId)) {
        session.pendingChat.push({ fromId, blob, until: now + PENDING_CHAT_MS });
      }
      return;
    }
    await this.openChatEvent(session, fromId, blob, keyIndex);
  }

  private async flushPendingChat(session: Session, fromId: string): Promise<void> {
    const now = Date.now();
    const mine = session.pendingChat.filter((p) => p.fromId === fromId && p.until > now);
    session.pendingChat = session.pendingChat.filter((p) => p.fromId !== fromId && p.until > now);
    for (const [i, pending] of mine.entries()) {
      const keyIndex = chatKeyIndex(pending.blob);
      if (!this.chatReceiveKey(session, fromId, keyIndex)) {
        // Still no key for this one (a later rotation): it and everything after it keep waiting.
        session.pendingChat.push(...mine.slice(i));
        return;
      }
      await this.openChatEvent(session, fromId, pending.blob, keyIndex);
    }
  }

  private async openChatEvent(
    session: Session,
    fromId: string,
    blob: string,
    keyIndex: number,
  ): Promise<void> {
    const key = this.chatReceiveKey(session, fromId, keyIndex);
    const peer = session.peers.get(fromId);
    const author = await peer?.identity;
    if (!key || !peer || !author) return;
    let event: ChatEvent;
    try {
      event = await openChat(
        blob,
        { roomId: session.roomId, fromId, key },
        author.bundle.ed25519Pub,
      );
    } catch (e) {
      if (e instanceof ChatError) return;
      throw e;
    }
    if (session.stopped || session.peers.get(fromId) !== peer) return;
    const authorPub = author.bundle.ed25519Pub;
    if (event.seq <= (this.lastChatSeq.get(authorPub) ?? 0)) return; // replayed
    this.lastChatSeq.set(authorPub, event.seq);
    this.chatListeners.forEach((listener) => listener({ fromId, authorPub, event }));
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

function withoutKey<T>(map: ReadonlyMap<string, T>, id: string): ReadonlyMap<string, T> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

function without(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}
