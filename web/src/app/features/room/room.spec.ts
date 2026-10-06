import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ConnectionState } from 'livekit-client';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { CallParticipant, LiveKitService } from '../../core/livekit/livekit.service';
import { SignalingService } from '../../core/signaling/signaling.service';
import { APP_ICONS } from '../../core/ui/icons';
import { DISPLAY_NAME_KEY } from '../home/home';
import { Room } from './room';

function fakeLiveKit() {
  return {
    state: signal(ConnectionState.Disconnected),
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
    flipCamera: vi.fn().mockResolvedValue(undefined),
    selectCamera: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setMicrophone: vi.fn().mockResolvedValue(undefined),
    setCamera: vi.fn().mockResolvedValue(undefined),
    setScreenShare: vi.fn().mockResolvedValue(undefined),
    startAudio: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeSignaling() {
  return {
    joinRoom: vi.fn().mockResolvedValue({ participants: [] }),
    getRtcConfig: vi
      .fn()
      .mockResolvedValue({ livekitUrl: 'ws://x', token: 't', iceServers: [], forceRelay: false }),
    leave: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup(
  opts: {
    name?: string;
    tweak?: (lk: ReturnType<typeof fakeLiveKit>, sig: ReturnType<typeof fakeSignaling>) => void;
  } = {},
) {
  if (opts.name === undefined) localStorage.setItem(DISPLAY_NAME_KEY, 'Alex');
  else localStorage.setItem(DISPLAY_NAME_KEY, opts.name);

  const livekit = fakeLiveKit();
  const signaling = fakeSignaling();
  opts.tweak?.(livekit, signaling);
  const message = { error: vi.fn(), success: vi.fn() };

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
    set: { providers: [{ provide: LiveKitService, useValue: livekit }] },
  });

  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(Room);
  fixture.componentRef.setInput('roomId', 'abc-123');
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    el: fixture.nativeElement as HTMLElement,
    livekit,
    signaling,
    message,
    navigate,
  };
}

describe('Room', () => {
  it('joins, connects and turns on mic and camera', async () => {
    const { signaling, livekit, el } = await setup();
    expect(signaling.joinRoom).toHaveBeenCalledWith('abc-123', 'Alex');
    expect(livekit.connect).toHaveBeenCalledOnce();
    expect(livekit.setMicrophone).toHaveBeenCalledWith(true);
    expect(livekit.setCamera).toHaveBeenCalledWith(true);
    expect(el.querySelector('app-call-controls')).not.toBeNull();
  });

  it('sends people without a name to the home screen, keeping the room', async () => {
    const { navigate, signaling } = await setup({ name: '' });
    expect(navigate).toHaveBeenCalledWith(['/'], { queryParams: { room: 'abc-123' } });
    expect(signaling.joinRoom).not.toHaveBeenCalled();
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
    const { el, fixture, livekit, signaling } = await setup({
      tweak: (lk) => lk.connect.mockRejectedValueOnce(new Error('token rejected')),
    });
    expect(el.querySelector('.join-error')?.textContent).toContain('token rejected');
    expect(el.querySelector('app-call-controls')).toBeNull();

    el.querySelector<HTMLButtonElement>('.join-error .retry')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(livekit.disconnect).toHaveBeenCalled();
    expect(signaling.leave).toHaveBeenCalled();
    expect(livekit.connect).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.join-error')).toBeNull();
  });

  it('offers to enable audio when autoplay is blocked', async () => {
    const { el, fixture, livekit } = await setup();
    livekit.canPlaybackAudio.set(false);
    fixture.detectChanges();

    el.querySelector<HTMLButtonElement>('.audio-blocked button')!.click();
    expect(livekit.startAudio).toHaveBeenCalledOnce();
  });

  it('announces people joining and leaving after you are in, not those already there', async () => {
    const person = (identity: string, isLocal = false): CallParticipant => ({
      identity,
      name: identity,
      isLocal,
      isSpeaking: false,
      micMuted: false,
      cameraOn: false,
      sharingScreen: false,
    });
    const { el, fixture, livekit } = await setup({
      tweak: (lk) =>
        lk.connect.mockImplementation(async () =>
          lk.participants.set([person('Alex', true), person('Bob')]),
        ),
    });
    const notices = () => [...el.querySelectorAll('.notice')].map((n) => n.textContent!.trim());
    expect(notices()).toEqual([]);

    livekit.participants.set([person('Alex', true), person('Bob'), person('<b>Eve</b>')]);
    fixture.detectChanges();
    expect(notices()).toEqual(['<b>Eve</b> joined']);
    expect(el.querySelector('.notice b')).toBeNull();

    livekit.participants.set([person('Alex', true), person('<b>Eve</b>')]);
    fixture.detectChanges();
    expect(notices()).toContain('Bob left');
  });

  it('flips the camera and reports a busy camera as a toast', async () => {
    const { el, fixture, livekit, message } = await setup({
      tweak: (lk) => {
        lk.canFlip.set(true);
        lk.cameraEnabled.set(true);
        lk.flipCamera.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
      },
    });
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('button.flip')!.click();
    await fixture.whenStable();

    expect(livekit.flipCamera).toHaveBeenCalledOnce();
    expect(message.error).toHaveBeenCalledWith('Camera is in use by another app.');
  });
});
