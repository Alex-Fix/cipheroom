import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CryptoService } from '../crypto/crypto.service';
import { LobbyEvent, SignalingService } from '../signaling/signaling.service';
import { AdmitterDto, AuthorityDto, LobbyResult } from '../signaling/signaling.types';
import { LobbyClosedError, LobbyService } from './lobby.service';

const identity = { ed25519Pub: 'me-pub', x25519Pub: 'x', sig: 's' };
const guestIdentity = { ed25519Pub: 'guest-pub', x25519Pub: 'x', sig: 's' };
const host: AdmitterDto = {
  id: 'host',
  identity: { ed25519Pub: 'host-pub', x25519Pub: 'x', sig: 's' },
};

const authority = (admitters: AdmitterDto[] = []): AuthorityDto => ({
  hostEd25519Pub: null,
  hostX25519Pub: null,
  hosts: [],
  coHosts: [],
  revoked: [],
  settings: null,
  admitters,
});

const result = (admitted: boolean, admitters: AdmitterDto[] = []): LobbyResult => ({
  selfId: 'me',
  admitted,
  participants: [],
  authority: authority(admitters),
  ticket: admitted ? { issuer: 'host-pub', sig: 'ticket' } : null,
});

function setup() {
  let emit: (event: LobbyEvent) => void = () => undefined;
  const signaling = {
    authority: signal<AuthorityDto | undefined>(undefined),
    participants: signal([{ id: 'bob', identity: { ed25519Pub: 'bob-pub' } }]),
    joinLobby: vi.fn(),
    knock: vi.fn().mockResolvedValue(undefined),
    admit: vi.fn().mockResolvedValue(undefined),
    deny: vi.fn().mockResolvedValue(undefined),
    grantCoHost: vi.fn().mockResolvedValue(undefined),
    removeParticipant: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    askToMute: vi.fn().mockResolvedValue(undefined),
    endCall: vi.fn().mockResolvedValue(undefined),
    onLobbyEvent: (listener: (event: LobbyEvent) => void) => {
      emit = listener;
      return () => (emit = () => undefined);
    },
  };
  const crypto = {
    canAdmit: signal(false),
    authority: signal({ autoAdmit: false }),
    identityBundle: vi.fn().mockResolvedValue(identity),
    hostProof: vi.fn().mockResolvedValue(null),
    sealKnocks: vi.fn(async (admitters: AdmitterDto[]) =>
      admitters.map((a) => ({ toId: a.id, blob: `for-${a.id}` })),
    ),
    openKnock: vi.fn().mockResolvedValue('Gina'),
    signTicket: vi.fn().mockResolvedValue('ticket-sig'),
    signCoHostGrant: vi.fn().mockResolvedValue('grant-sig'),
    signRemoval: vi.fn().mockResolvedValue('revoke-sig'),
    signSettings: vi.fn().mockResolvedValue({ seq: 1, sig: 'settings-sig' }),
    signMuteRequest: vi.fn().mockResolvedValue({ seq: 1, sig: 'mute-sig' }),
    signEnd: vi.fn().mockResolvedValue('end-sig'),
    verifyMuteRequest: vi.fn().mockResolvedValue(true),
    verifyEnd: vi.fn().mockResolvedValue(true),
  };
  TestBed.configureTestingModule({
    providers: [
      LobbyService,
      { provide: SignalingService, useValue: signaling },
      { provide: CryptoService, useValue: crypto },
    ],
  });
  const lobby = TestBed.inject(LobbyService);
  /** What the next JoinLobby returns (the real service also takes the authority from it). */
  const respond = (r: LobbyResult) =>
    signaling.joinLobby.mockImplementation(async () => {
      signaling.authority.set(r.authority);
      return r;
    });
  return { lobby, signaling, crypto, respond, emit: (e: LobbyEvent) => emit(e) };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('LobbyService', () => {
  it('goes straight in with a host proof', async () => {
    const { lobby, signaling, crypto, respond } = setup();
    crypto.hostProof.mockResolvedValue({
      hostEd25519Pub: 'h',
      hostX25519Pub: 'x',
      attestation: 'a',
    });
    respond(result(true));

    await expect(lobby.enter('room', 'Alex', ['vp8'])).resolves.toMatchObject({ selfId: 'me' });
    expect(signaling.joinLobby).toHaveBeenCalledWith(
      'room',
      identity,
      ['vp8'],
      { hostEd25519Pub: 'h', hostX25519Pub: 'x', attestation: 'a' },
      null,
    );
    expect(lobby.state()).toBe('admitted');
  });

  it('knocks on the admitters there, and on ones who arrive later, then gets in', async () => {
    const { lobby, signaling, crypto, respond, emit } = setup();
    respond(result(false, [host]));
    const entering = lobby.enter('room', 'Alex', ['vp8']);
    await flush();

    expect(lobby.state()).toBe('waiting');
    expect(crypto.sealKnocks).toHaveBeenCalledWith([host], 'Alex');
    expect(signaling.knock).toHaveBeenCalledWith([{ toId: 'host', blob: 'for-host' }]);

    const coHost = { ...host, id: 'cohost' };
    signaling.authority.set(authority([host, coHost]));
    await flush();
    expect(signaling.knock).toHaveBeenLastCalledWith([{ toId: 'cohost', blob: 'for-cohost' }]);

    emit({ type: 'admitted', result: result(true) });
    await expect(entering).resolves.toMatchObject({ admitted: true });
    expect(lobby.state()).toBe('admitted');
  });

  it('presents its ticket when rejoining the same call', async () => {
    const { lobby, signaling, respond, emit } = setup();
    respond(result(false, [host]));
    const entering = lobby.enter('room', 'Alex', ['vp8']);
    await flush();
    emit({ type: 'admitted', result: result(true) });
    await entering;

    respond(result(true));
    await lobby.enter('room', 'Alex', ['vp8']);
    expect(signaling.joinLobby).toHaveBeenLastCalledWith('room', identity, ['vp8'], null, {
      issuer: 'host-pub',
      sig: 'ticket',
    });
  });

  it.each([
    ['denied', { type: 'denied' }, 'denied'],
    ['ended', { type: 'callEnded', issuer: 'host-pub', sig: 'end' }, 'ended'],
  ] as const)('stops waiting when %s', async (_, event, state) => {
    const { lobby, respond, emit } = setup();
    respond(result(false, [host]));
    const entering = lobby.enter('room', 'Alex', ['vp8']);
    await flush();

    emit(event);
    await expect(entering).rejects.toBeInstanceOf(LobbyClosedError);
    expect(lobby.state()).toBe(state);
  });

  it('ignores an "ended" it can’t verify', async () => {
    const { lobby, crypto, respond, emit } = setup();
    crypto.verifyEnd.mockResolvedValue(false);
    respond(result(true));
    await lobby.enter('room', 'Alex', ['vp8']);

    emit({ type: 'callEnded', issuer: 'x', sig: 'forged' });
    await flush();
    expect(lobby.state()).toBe('admitted');
  });

  it('shows admitters who knocks, and admits with a signed ticket', async () => {
    const { lobby, signaling, crypto, emit } = setup();
    crypto.canAdmit.set(true);

    emit({ type: 'knock', guest: { id: 'g', identity: guestIdentity }, blob: 'knock' });
    await flush();
    expect(lobby.guests()).toEqual([{ id: 'g', identity: guestIdentity, name: 'Gina' }]);

    await lobby.admit('g');
    expect(crypto.signTicket).toHaveBeenCalledWith('guest-pub');
    expect(signaling.admit).toHaveBeenCalledWith('g', 'ticket-sig');
    expect(lobby.guests()).toEqual([]);
  });

  it('drops knocks it can’t open, and ignores knocks when not an admitter', async () => {
    const { lobby, crypto, emit } = setup();
    emit({ type: 'knock', guest: { id: 'g', identity: guestIdentity }, blob: 'knock' });
    await flush();
    expect(crypto.openKnock).not.toHaveBeenCalled();

    crypto.canAdmit.set(true);
    crypto.openKnock.mockResolvedValue(undefined);
    emit({ type: 'knock', guest: { id: 'g', identity: guestIdentity }, blob: 'forged' });
    await flush();
    expect(lobby.guests()).toEqual([]);
  });

  it('admits knocks at once while auto-admit is on', async () => {
    const { signaling, crypto, emit } = setup();
    crypto.canAdmit.set(true);
    crypto.authority.set({ autoAdmit: true });

    emit({ type: 'knock', guest: { id: 'g', identity: guestIdentity }, blob: 'knock' });
    await flush();
    expect(signaling.admit).toHaveBeenCalledWith('g', 'ticket-sig');
  });

  it('signs host controls for the right identity', async () => {
    const { lobby, signaling, crypto } = setup();
    await lobby.makeCoHost('bob');
    await lobby.remove('bob');
    await lobby.askToMute('bob');
    await lobby.setAutoAdmit(true);
    await lobby.endCall();

    expect(crypto.signCoHostGrant).toHaveBeenCalledWith('bob-pub');
    expect(signaling.grantCoHost).toHaveBeenCalledWith('bob', 'grant-sig');
    expect(signaling.removeParticipant).toHaveBeenCalledWith('bob', 'revoke-sig');
    expect(signaling.askToMute).toHaveBeenCalledWith('bob', 1, 'mute-sig');
    expect(signaling.updateSettings).toHaveBeenCalledWith(1, true, 'settings-sig');
    expect(signaling.endCall).toHaveBeenCalledWith('end-sig');
  });

  it('counts only verified mute requests, and notes removal', async () => {
    const { lobby, crypto, emit } = setup();
    emit({ type: 'muteRequested', fromId: 'host', seq: 1, sig: 'ok' });
    await flush();
    crypto.verifyMuteRequest.mockResolvedValue(false);
    emit({ type: 'muteRequested', fromId: 'host', seq: 1, sig: 'replayed' });
    await flush();
    expect(lobby.muteRequests()).toBe(1);

    emit({ type: 'removed' });
    expect(lobby.state()).toBe('removed');
  });
});
