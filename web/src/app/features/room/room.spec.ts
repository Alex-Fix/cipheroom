import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { CryptoService } from '../../core/crypto/crypto.service';
import {
  LobbyClosedError,
  LobbyService,
  LobbyState,
  PendingGuest,
} from '../../core/lobby/lobby.service';
import { SafetyCode } from '../../core/crypto/safety-code';
import { MediaService } from '../../core/media/media.service';
import { CallParticipant, MediaState } from '../../core/media/media.types';
import { SignalingService } from '../../core/signaling/signaling.service';
import { APP_ICONS } from '../../core/ui/icons';
import { DISPLAY_NAME_KEY } from '../../core/settings/display-name';
import { Room } from './room';

function fakeMedia() {
  const media = {
    // Like the real service right after connect(): a fresh peer connection counts as connected.
    state: signal<MediaState>('connected'),
    tiles: signal([]),
    participants: signal<CallParticipant[]>([]),
    micEnabled: signal(false),
    cameraEnabled: signal(false),
    screenShareEnabled: signal(false),
    canPlaybackAudio: signal(true),
    diagnostics: signal({ forceRelay: false }),
    cameras: signal<{ id: string; label: string }[]>([]),
    activeCameraId: signal<string | undefined>(undefined),
    canFlip: signal(false),
    availableQualities: signal(['auto', '720p']),
    videoQuality: signal('auto'),
    setVideoQuality: vi.fn().mockResolvedValue(undefined),
    availableCodecs: ['vp9', 'vp8'],
    decodableCodecs: ['vp8', 'vp9'],
    videoCodec: signal('vp9'),
    sendingCodec: signal<string | undefined>('vp9'),
    codecUnsupported: signal(false),
    setVideoCodec: vi.fn().mockReturnValue(false),
    setTileSize: vi.fn(),
    flipCamera: vi.fn().mockResolvedValue(undefined),
    selectCamera: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setMicrophone: vi.fn().mockResolvedValue(undefined),
    setCamera: vi.fn().mockResolvedValue(undefined),
    setScreenShare: vi.fn().mockResolvedValue(undefined),
    startAudio: vi.fn().mockResolvedValue(undefined),
    startReceiving: vi.fn(),
    reserveCamera: vi.fn().mockResolvedValue(undefined),
  };
  // Like the real service: a device that turned on reports enabled.
  media.setMicrophone.mockImplementation(async (on: boolean) => media.micEnabled.set(on));
  media.setCamera.mockImplementation(async (on: boolean) => media.cameraEnabled.set(on));
  // A new peer connection starts out connected (see MediaService.connect).
  media.connect.mockImplementation(() => media.state.set('connected'));
  return media;
}

/** CryptoService's frame transforms, handed from CryptoService.start to MediaService.connect. */
const frames = { peerConnectionConfig: {} };

function fakeCrypto() {
  return {
    start: vi.fn().mockResolvedValue(frames),
    stop: vi.fn(),
    safetyCode: signal<SafetyCode | undefined>(undefined),
    unverified: signal<ReadonlySet<string>>(new Set()),
    canAdmit: signal(false),
    isHost: signal(false),
    authority: signal({ autoAdmit: false }),
  };
}

/** LobbyService: straight in (as host) unless a test says otherwise. */
function fakeLobby() {
  const lobby = {
    state: signal<LobbyState>('idle'),
    guests: signal<PendingGuest[]>([]),
    muteRequests: signal(0),
    enter: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    admit: vi.fn().mockResolvedValue(undefined),
    deny: vi.fn().mockResolvedValue(undefined),
    admitAll: vi.fn().mockResolvedValue(undefined),
    makeCoHost: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    askToMute: vi.fn().mockResolvedValue(undefined),
    setAutoAdmit: vi.fn().mockResolvedValue(undefined),
    endCall: vi.fn().mockResolvedValue(undefined),
  };
  lobby.enter.mockImplementation(async () => {
    lobby.state.set('admitted');
    return { selfId: 'me', admitted: true, participants: [], authority: {}, ticket: null };
  });
  return lobby;
}

const safetyCode = (digits: string): SafetyCode => ({
  emoji: [
    { symbol: '🐙', name: 'octopus' },
    { symbol: '🌵', name: 'cactus' },
    { symbol: '🚲', name: 'bicycle' },
    { symbol: '🔑', name: 'key' },
  ],
  digits,
});

function fakeSignaling() {
  return {
    connected: signal(true),
    authority: signal<{ admitters: unknown[] } | undefined>(undefined),
    getRtcConfig: vi.fn().mockResolvedValue({ iceServers: [], forceRelay: false }),
    leave: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup(
  opts: {
    name?: string;
    tweak?: (lk: ReturnType<typeof fakeMedia>, sig: ReturnType<typeof fakeSignaling>) => void;
    crypto?: (crypto: ReturnType<typeof fakeCrypto>) => void;
    lobby?: (lobby: ReturnType<typeof fakeLobby>) => void;
  } = {},
) {
  if (opts.name === undefined) localStorage.setItem(DISPLAY_NAME_KEY, 'Alex');
  else localStorage.setItem(DISPLAY_NAME_KEY, opts.name);

  const media = fakeMedia();
  const signaling = fakeSignaling();
  opts.tweak?.(media, signaling);
  const message = { error: vi.fn(), success: vi.fn() };
  const crypto = fakeCrypto();
  opts.crypto?.(crypto);
  const lobby = fakeLobby();
  opts.lobby?.(lobby);

  TestBed.configureTestingModule({
    imports: [Room],
    providers: [
      provideRouter([]),
      provideNzIcons(APP_ICONS),
      { provide: SignalingService, useValue: signaling },
      { provide: NzMessageService, useValue: message },
    ],
  });
  TestBed.overrideComponent(Room, {
    set: {
      providers: [
        { provide: MediaService, useValue: media },
        { provide: CryptoService, useValue: crypto },
        { provide: LobbyService, useValue: lobby },
      ],
    },
  });

  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(Room);
  // The instance Room uses (NzModalModule provides it at component level). Confirmations aren't rendered here.
  const modal = {
    confirm: vi
      .spyOn(fixture.debugElement.injector.get(NzModalService), 'confirm')
      .mockReturnValue(undefined as never),
  };
  fixture.componentRef.setInput('roomId', 'abc-123');
  await fixture.whenStable();
  // The join runs as a promise chain from ngOnInit: let it finish.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  fixture.detectChanges();
  return {
    fixture,
    el: fixture.nativeElement as HTMLElement,
    media,
    signaling,
    message,
    navigate,
    crypto,
    lobby,
    modal,
  };
}

describe('Room', () => {
  it('enters through the lobby, then connects and turns on mic and camera', async () => {
    const { lobby, media, el, crypto } = await setup();
    expect(lobby.enter).toHaveBeenCalledWith('abc-123', 'Alex', ['vp8', 'vp9']);
    expect(crypto.start).toHaveBeenCalledWith('abc-123', 'me', 'Alex');
    expect(media.connect).toHaveBeenCalledWith(
      { iceServers: [], forceRelay: false },
      { id: 'me', displayName: 'Alex' },
      frames,
    );
    expect(media.setMicrophone).toHaveBeenCalledWith(true);
    expect(media.setCamera).toHaveBeenCalledWith(true);
    expect(media.reserveCamera).not.toHaveBeenCalled();
    expect(el.querySelector('app-call-controls')).not.toBeNull();
  });

  it('never joins when this browser can’t encrypt', async () => {
    const { media, el, crypto } = await setup({
      lobby: (l) =>
        l.enter.mockRejectedValue(new Error("This browser can't join encrypted calls.")),
    });
    expect(crypto.start).not.toHaveBeenCalled();
    expect(media.connect).not.toHaveBeenCalled();
    expect(el.textContent).toContain("This browser can't join encrypted calls.");
  });

  it('leaves at once when encryption can’t start after joining — never connects media', async () => {
    const { signaling, media, crypto, el } = await setup({
      crypto: (c) =>
        c.start.mockRejectedValue(new Error("This browser can't join encrypted calls.")),
    });
    expect(media.connect).not.toHaveBeenCalled();
    expect(crypto.stop).toHaveBeenCalled();
    expect(signaling.leave).toHaveBeenCalled();
    expect(el.textContent).toContain("This browser can't join encrypted calls.");
  });

  it("publishes its own tracks before receiving anyone else's (iOS Safari needs that order)", async () => {
    const order: string[] = [];
    await setup({
      tweak: (lk) => {
        lk.setMicrophone.mockImplementation(async () => void order.push('mic'));
        lk.setCamera.mockImplementation(async () => void order.push('camera'));
        lk.startReceiving.mockImplementation(() => order.push('receive'));
      },
    });
    expect(order).toEqual(['mic', 'camera', 'receive']);
  });

  it('reserves the camera when it could not be turned on, then starts receiving', async () => {
    const { media } = await setup({
      tweak: (lk) => lk.setCamera.mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
    });
    expect(media.reserveCamera).toHaveBeenCalledOnce();
    expect(media.startReceiving).toHaveBeenCalledOnce();
  });

  it('sends people without a name to the home screen, keeping the room', async () => {
    const { navigate, lobby } = await setup({ name: '' });
    expect(navigate).toHaveBeenCalledWith(['/'], { queryParams: { room: 'abc-123' } });
    expect(lobby.enter).not.toHaveBeenCalled();
  });

  it('turns a denied camera into a toast and stays in the call', async () => {
    const { message, el } = await setup({
      tweak: (lk) => lk.setCamera.mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
    });
    expect(message.error).toHaveBeenCalledWith(
      "Camera blocked — allow it in your browser's site settings.",
    );
    expect(el.querySelector('.join-error')).toBeNull();
  });

  it('shows the join error and retries from scratch', async () => {
    const { el, fixture, media, signaling } = await setup({
      tweak: (_, sig) =>
        sig.getRtcConfig.mockRejectedValueOnce(new Error('Media server unavailable.')),
    });
    expect(el.querySelector('.join-error')?.textContent).toContain('Media server unavailable.');
    expect(el.querySelector('app-call-controls')).toBeNull();

    el.querySelector<HTMLButtonElement>('.join-error .retry')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(media.disconnect).toHaveBeenCalled();
    expect(signaling.leave).toHaveBeenCalled();
    expect(media.connect).toHaveBeenCalledOnce();
    expect(el.querySelector('.join-error')).toBeNull();
  });

  it('offers to enable audio when autoplay is blocked', async () => {
    const { el, fixture, media } = await setup();
    media.canPlaybackAudio.set(false);
    fixture.detectChanges();

    el.querySelector<HTMLButtonElement>('.audio-blocked button')!.click();
    expect(media.startAudio).toHaveBeenCalledOnce();
  });

  it('announces people joining and leaving after you are in, not those already there', async () => {
    const person = (identity: string, isLocal = false): CallParticipant => ({
      identity,
      name: identity,
      role: 'guest',
      isLocal,
      isSpeaking: false,
      micMuted: false,
      cameraOn: false,
      sharingScreen: false,
    });
    const { el, fixture, media } = await setup({
      tweak: (lk) =>
        lk.connect.mockImplementation(async () =>
          lk.participants.set([person('Alex', true), person('Bob')]),
        ),
    });
    const notices = () => [...el.querySelectorAll('.notice')].map((n) => n.textContent!.trim());
    expect(notices()).toEqual([]);

    media.participants.set([person('Alex', true), person('Bob'), person('<b>Eve</b>')]);
    fixture.detectChanges();
    expect(notices()).toEqual(['<b>Eve</b> joined']);
    expect(el.querySelector('.notice b')).toBeNull();

    media.participants.set([person('Alex', true), person('<b>Eve</b>')]);
    fixture.detectChanges();
    expect(notices()).toContain('Bob left');
  });

  it('shows the encryption state and announces a changed safety code', async () => {
    const { el, fixture, crypto } = await setup();
    const notices = () => [...el.querySelectorAll('.notice')].map((n) => n.textContent!.trim());
    expect(el.querySelector('.e2ee')?.textContent).toContain('Securing…');

    crypto.safetyCode.set(safetyCode('1111 2222'));
    fixture.detectChanges();
    expect(el.querySelector('.e2ee.secure')?.textContent).toContain('Encrypted');
    expect(notices()).toEqual([]);

    crypto.safetyCode.set(safetyCode('3333 4444'));
    fixture.detectChanges();
    expect(notices()).toEqual(['Safety code changed — compare it again']);
  });

  it('flips the camera and reports a busy camera as a toast', async () => {
    const { el, fixture, media, message } = await setup({
      tweak: (lk) => {
        lk.canFlip.set(true);
        lk.cameraEnabled.set(true);
        lk.flipCamera.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
      },
    });
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('button.flip')!.click();
    await fixture.whenStable();

    expect(media.flipCamera).toHaveBeenCalledOnce();
    expect(message.error).toHaveBeenCalledWith('Camera is in use by another app.');
  });

  it('changes the camera quality from the controls', async () => {
    const { el, fixture, media } = await setup();
    fixture.debugElement
      .query((d) => d.name === 'app-call-controls')
      .triggerEventHandler('selectQuality', '1080p');
    await fixture.whenStable();

    expect(media.setVideoQuality).toHaveBeenCalledWith('1080p');
    expect(el.querySelector('app-call-controls')).not.toBeNull();
  });

  describe('lobby', () => {
    it('shows the lobby while waiting, and Cancel goes home', async () => {
      const { el, fixture, lobby, navigate, media } = await setup({
        lobby: (l) =>
          l.enter.mockImplementation(() => {
            l.state.set('waiting');
            return new Promise(() => undefined);
          }),
      });
      fixture.detectChanges();
      expect(el.querySelector('app-lobby-screen')?.textContent).toContain(
        'The host isn’t here yet',
      );
      expect(el.querySelector('app-call-controls')).toBeNull();
      expect(media.connect).not.toHaveBeenCalled();

      el.querySelector<HTMLButtonElement>('app-lobby-screen .cancel')!.click();
      expect(lobby.cancel).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/']);
    });

    it('stays connected when turned away, and asks again on the same connection', async () => {
      const { el, fixture, lobby, signaling } = await setup({
        lobby: (l) =>
          l.enter.mockImplementationOnce(async () => {
            l.state.set('denied');
            throw new LobbyClosedError('denied');
          }),
      });
      fixture.detectChanges();
      expect(el.querySelector('app-lobby-screen')?.textContent).toContain(
        'The host didn’t let you in',
      );
      expect(signaling.leave).not.toHaveBeenCalled();
      expect(el.querySelector('.join-error')).toBeNull();
    });

    it('leaves for good when removed — no automatic rejoin', async () => {
      const { el, fixture, lobby, media, signaling } = await setup();
      lobby.state.set('removed');
      signaling.connected.set(false);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(media.disconnect).toHaveBeenCalled();
      expect(signaling.leave).toHaveBeenCalled();
      expect(lobby.enter).toHaveBeenCalledOnce();
      expect(el.querySelector('app-lobby-screen')?.textContent).toContain('You were removed');
    });

    it('mutes when a host asks, and says so', async () => {
      const { el, fixture, lobby, media } = await setup();
      media.micEnabled.set(true);
      lobby.muteRequests.set(1);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(media.setMicrophone).toHaveBeenLastCalledWith(false);
      expect(el.textContent).toContain('The host muted you');
    });

    it('announces knocks to admitters by name, as text', async () => {
      const { el, fixture, lobby } = await setup({ crypto: (c) => c.canAdmit.set(true) });
      lobby.guests.set([
        { id: 'g', name: '<b>Gina</b>', identity: { ed25519Pub: 'a', x25519Pub: 'b', sig: 'c' } },
      ]);
      fixture.detectChanges();

      expect([...el.querySelectorAll('.notice')].map((n) => n.textContent!.trim())).toContain(
        '<b>Gina</b> wants to join',
      );
      expect(el.querySelector('.notice b')).toBeNull();
    });

    it('asks before removing someone or ending the call', async () => {
      const { fixture, modal, lobby } = await setup({ crypto: (c) => c.canAdmit.set(true) });
      fixture.debugElement
        .query((d) => d.name === 'app-participants-panel')
        .triggerEventHandler('act', { action: 'remove', participantId: 'bob' });
      fixture.debugElement
        .query((d) => d.name === 'app-call-header')
        .triggerEventHandler('endCall');

      expect(modal.confirm).toHaveBeenCalledTimes(2);
      expect(lobby.remove).not.toHaveBeenCalled();
      await (modal.confirm.mock.calls[0][0]!.nzOnOk as () => Promise<void>)();
      await (modal.confirm.mock.calls[1][0]!.nzOnOk as () => Promise<void>)();
      expect(lobby.remove).toHaveBeenCalledWith('bob');
      expect(lobby.endCall).toHaveBeenCalled();
    });
  });

  describe('automatic rejoin', () => {
    // Fake timers only after setup(): whenStable() needs real ones.
    afterEach(() => vi.useRealTimers());

    it('rejoins with the same devices when the media connection is lost', async () => {
      const { fixture, media, lobby } = await setup();
      vi.useFakeTimers();
      media.micEnabled.set(false);
      media.cameraEnabled.set(true);
      media.setMicrophone.mockClear();
      media.setCamera.mockClear();

      media.state.set('disconnected');
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(1000);

      expect(media.disconnect).toHaveBeenCalled();
      expect(lobby.enter).toHaveBeenCalledTimes(2);
      // The muted microphone is published again, then muted: unmuting later needs no new negotiation.
      expect(media.setMicrophone.mock.calls).toEqual([[true], [false]]);
      expect(media.setCamera).toHaveBeenCalledWith(true);
    });

    it('rejoins to apply a codec change that needs it, and only then', async () => {
      const { fixture, media, lobby } = await setup();
      vi.useFakeTimers();
      const controls = fixture.debugElement.query((d) => d.name === 'app-call-controls');

      controls.triggerEventHandler('selectCodec', 'vp9');
      await vi.advanceTimersByTimeAsync(1000);
      expect(media.setVideoCodec).toHaveBeenCalledWith('vp9');
      expect(lobby.enter).toHaveBeenCalledTimes(1);

      media.setVideoCodec.mockReturnValueOnce(true);
      controls.triggerEventHandler('selectCodec', 'vp8');
      await vi.advanceTimersByTimeAsync(1000);
      expect(media.disconnect).toHaveBeenCalled();
      expect(lobby.enter).toHaveBeenCalledTimes(2);
    });

    it('rejoins when someone joined who can’t decode the codec we send', async () => {
      const { fixture, media, lobby } = await setup();
      vi.useFakeTimers();

      media.codecUnsupported.set(true);
      fixture.detectChanges();
      media.codecUnsupported.set(false); // the new connection picked a codec everyone can play
      await vi.advanceTimersByTimeAsync(1000);

      expect(lobby.enter).toHaveBeenCalledTimes(2);
    });

    it('rejoins when the signaling connection drops', async () => {
      const { fixture, signaling, lobby } = await setup();
      vi.useFakeTimers();

      signaling.connected.set(false);
      fixture.detectChanges();
      signaling.connected.set(true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(lobby.enter).toHaveBeenCalledTimes(2);
    });

    it('gives up after repeated losses and offers Try Again', async () => {
      const { el, fixture, media, lobby } = await setup();
      vi.useFakeTimers();

      for (let i = 0; i < 4; i++) {
        media.state.set('connecting');
        fixture.detectChanges();
        media.state.set('disconnected');
        fixture.detectChanges();
        await vi.advanceTimersByTimeAsync(1000);
      }
      fixture.detectChanges();

      expect(lobby.enter).toHaveBeenCalledTimes(4);
      expect(el.querySelector('.join-error')?.textContent).toContain('Connection lost.');
    });
  });
});
