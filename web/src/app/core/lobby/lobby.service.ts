import { Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { SignalingService, LobbyEvent } from '../signaling/signaling.service';
import { AdmitterDto, IdentityDto, LobbyResult, TicketDto } from '../signaling/signaling.types';

/**
 * Where we are on the way into a call. `waiting`: in the lobby; `denied` / `removed` / `ended`: out, and staying out
 * (no automatic rejoin).
 */
export type LobbyState =
  'idle' | 'joining' | 'waiting' | 'admitted' | 'denied' | 'removed' | 'ended';

/** Someone asking us (an admitter) to let them in. `name` came encrypted to us; the server never saw it. */
export interface PendingGuest {
  id: string;
  identity: IdentityDto;
  name: string;
}

/** Waiting ended without getting in. */
export class LobbyClosedError extends Error {
  constructor(readonly reason: 'denied' | 'ended' | 'cancelled') {
    super(LOBBY_CLOSED_MESSAGES[reason]);
  }
}

export const LOBBY_CLOSED_MESSAGES = {
  denied: "The host didn't let you in.",
  ended: 'The host ended the call.',
  cancelled: 'You stopped waiting.',
} as const;

/**
 * The lobby and host controls (design: docs/plans/2026-10-08-lobby-admission-design.md), provided per room route.
 * Guests: join, knock (our name encrypted to each admitter), wait. Admitters: see knocks, admit with a signed ticket,
 * deny; hosts and co-hosts: make co-host, remove, ask to mute, auto-admit, end the call. Every statement is signed
 * by CryptoService with our per-call identity, and every one we receive is verified there before we act on it.
 */
@Injectable()
export class LobbyService implements OnDestroy {
  private readonly signaling = inject(SignalingService);
  private readonly crypto = inject(CryptoService);

  readonly state = signal<LobbyState>('idle');
  /** Knocks waiting for our decision (admitters only). */
  readonly guests = signal<PendingGuest[]>([]);
  /** Bumped for every verified "please mute" from an admitter; the room turns the microphone off. */
  readonly muteRequests = signal(0);

  private roomId?: string;
  private name = '';
  /** Ours from the last admission: a rejoin in this tab presents it instead of knocking again. */
  private ticket?: { roomId: string; ticket: TicketDto };
  /** Admitters we've already knocked on while waiting. */
  private readonly knocked = new Set<string>();
  private waiter?: {
    resolve: (result: LobbyResult) => void;
    reject: (error: LobbyClosedError) => void;
  };
  private readonly unsubscribe = this.signaling.onLobbyEvent((event) => void this.onEvent(event));

  constructor() {
    // While waiting, knock on admitters as they arrive (the host may come after us).
    effect(() => {
      const admitters = this.signaling.authority()?.admitters ?? [];
      if (this.state() !== 'waiting') return;
      untracked(() => void this.knock(admitters));
    });
  }

  /**
   * Gets us into the call: straight in as host (this browser holds the host key) or with our ticket from earlier in
   * this call; otherwise knocks and waits until an admitter lets us in. Rejects with LobbyClosedError if turned away
   * or the call ends; other errors (server, unsupported browser) as they come.
   */
  async enter(roomId: string, name: string, videoCodecs: readonly string[]): Promise<LobbyResult> {
    this.roomId = roomId;
    this.name = name;
    this.knocked.clear();
    this.guests.set([]);
    this.state.set('joining');
    const identity = await this.crypto.identityBundle(roomId);
    const hostProof = await this.crypto.hostProof(roomId);
    const ticket = this.ticket?.roomId === roomId ? this.ticket.ticket : null;
    const waiting = new Promise<LobbyResult>(
      (resolve, reject) => (this.waiter = { resolve, reject }),
    );
    waiting.catch(() => undefined);

    const result = await this.signaling.joinLobby(roomId, identity, videoCodecs, hostProof, ticket);
    if (result.admitted) {
      this.waiter = undefined;
      return this.admitted(result);
    }
    this.state.set('waiting');
    await this.knock(result.authority.admitters);
    return waiting;
  }

  /** Stop waiting in the lobby (the caller leaves the server-side lobby by disconnecting). */
  cancel(): void {
    this.close('cancelled', 'idle');
  }

  /** Back to the start, e.g. before a rejoin. Our ticket is kept. */
  reset(): void {
    this.waiter = undefined;
    this.guests.set([]);
    this.knocked.clear();
    if (this.state() !== 'removed' && this.state() !== 'ended' && this.state() !== 'denied')
      this.state.set('idle');
  }

  /** Lets a knocking guest in with our signed ticket for their identity. */
  async admit(guestId: string): Promise<void> {
    const guest = this.guests().find((g) => g.id === guestId);
    if (!guest) return;
    this.dropGuest(guestId);
    await this.signaling.admit(guestId, await this.crypto.signTicket(guest.identity.ed25519Pub));
  }

  async admitAll(): Promise<void> {
    await Promise.all(this.guests().map((g) => this.admit(g.id).catch(() => undefined)));
  }

  async deny(guestId: string): Promise<void> {
    this.dropGuest(guestId);
    await this.signaling.deny(guestId);
  }

  async makeCoHost(participantId: string): Promise<void> {
    const pub = this.identityOf(participantId);
    if (pub)
      await this.signaling.grantCoHost(participantId, await this.crypto.signCoHostGrant(pub));
  }

  async remove(participantId: string): Promise<void> {
    const pub = this.identityOf(participantId);
    if (pub)
      await this.signaling.removeParticipant(participantId, await this.crypto.signRemoval(pub));
  }

  async askToMute(participantId: string): Promise<void> {
    const pub = this.identityOf(participantId);
    if (!pub) return;
    const { seq, sig } = await this.crypto.signMuteRequest(pub);
    await this.signaling.askToMute(participantId, seq, sig);
  }

  /** Auto-admit on: our browser (and other admitters') signs a ticket for everyone who knocks. */
  async setAutoAdmit(autoAdmit: boolean): Promise<void> {
    const { seq, sig } = await this.crypto.signSettings(autoAdmit);
    await this.signaling.updateSettings(seq, autoAdmit, sig);
    if (autoAdmit) await this.admitAll();
  }

  async endCall(): Promise<void> {
    await this.signaling.endCall(await this.crypto.signEnd());
  }

  ngOnDestroy(): void {
    this.unsubscribe();
    this.close('cancelled', 'idle');
  }

  private admitted(result: LobbyResult): LobbyResult {
    if (result.ticket && this.roomId) this.ticket = { roomId: this.roomId, ticket: result.ticket };
    this.state.set('admitted');
    return result;
  }

  private async knock(admitters: readonly AdmitterDto[]): Promise<void> {
    const fresh = admitters.filter((a) => !this.knocked.has(a.id));
    if (!fresh.length) return;
    fresh.forEach((a) => this.knocked.add(a.id));
    const knocks = await this.crypto.sealKnocks(fresh, this.name);
    if (knocks.length && this.state() === 'waiting')
      await this.signaling.knock(knocks).catch(() => undefined);
  }

  private async onEvent(event: LobbyEvent): Promise<void> {
    switch (event.type) {
      case 'knock': {
        if (!this.crypto.canAdmit()) return;
        const name = await this.crypto.openKnock(event.guest, event.blob);
        if (!name) return;
        const guest: PendingGuest = { id: event.guest.id, identity: event.guest.identity, name };
        this.guests.update((list) => [...list.filter((g) => g.id !== guest.id), guest]);
        if (this.crypto.authority().autoAdmit) await this.admit(guest.id).catch(() => undefined);
        return;
      }
      case 'lobbyLeft':
        return this.dropGuest(event.guestId);
      case 'admitted': {
        const waiter = this.waiter;
        this.waiter = undefined;
        if (this.state() === 'waiting' && waiter) waiter.resolve(this.admitted(event.result));
        return;
      }
      case 'denied':
        return this.close('denied', 'denied');
      case 'removed':
        this.state.set('removed');
        return;
      case 'muteRequested':
        if (await this.crypto.verifyMuteRequest(event.fromId, event.seq, event.sig))
          this.muteRequests.update((n) => n + 1);
        return;
      case 'callEnded':
        // Unverified "ended" messages are ignored: the server can drop us anyway, but not put words in the host's mouth.
        if (await this.crypto.verifyEnd(event.issuer, event.sig)) this.close('ended', 'ended');
        return;
    }
  }

  private close(reason: LobbyClosedError['reason'], state: LobbyState): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    this.guests.set([]);
    if (state !== 'idle' || this.state() === 'waiting' || this.state() === 'joining')
      this.state.set(state);
    waiter?.reject(new LobbyClosedError(reason));
  }

  private dropGuest(guestId: string): void {
    this.guests.update((list) => list.filter((g) => g.id !== guestId));
  }

  private identityOf(participantId: string): string | undefined {
    return this.signaling.participants().find((p) => p.id === participantId)?.identity.ed25519Pub;
  }
}
