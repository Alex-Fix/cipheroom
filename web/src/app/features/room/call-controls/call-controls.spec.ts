import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { CallControls } from './call-controls';

interface State {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  canShareScreen?: boolean;
  canFlip?: boolean;
  cameras?: { id: string; label: string }[];
  activeCameraId?: string;
  qualities?: string[];
  quality?: string;
  codecs?: string[];
  codec?: string;
  sendingCodec?: string;
  videoBlockedReason?: string;
  view?: string;
  selfView?: string;
}

function render(state: State) {
  TestBed.configureTestingModule({
    imports: [CallControls],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(CallControls);
  for (const [key, value] of Object.entries(state)) fixture.componentRef.setInput(key, value);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return {
    fixture,
    el,
    button: (cls: string) => el.querySelector<HTMLButtonElement>(`button.${cls}`),
  };
}

/** nz-dropdown opens after a short debounce and renders into a CDK overlay on document.body. */
async function openMore(
  fixture: { detectChanges(): void; whenStable(): Promise<unknown> },
  more: HTMLElement,
) {
  more.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fixture.detectChanges();
  await fixture.whenStable();
}

const allOn: State = { micEnabled: true, cameraEnabled: true, screenShareEnabled: false };

describe('CallControls', () => {
  it('disables camera and screen share while video is paused, keeping the microphone', () => {
    const { button } = render({
      ...allOn,
      canShareScreen: true,
      videoBlockedReason: 'Video is paused until 1 November.',
    });
    expect(button('camera')!.disabled).toBe(true);
    expect(button('screen')!.disabled).toBe(true);
    expect(button('mic')!.disabled).toBe(false);
  });

  it('shows devices as on with their action labels', () => {
    const { button } = render(allOn);
    expect(button('mic')!.classList).not.toContain('off');
    expect(button('mic')!.getAttribute('aria-label')).toBe('Mute');
    expect(button('camera')!.getAttribute('aria-label')).toBe('Turn camera off');
    expect(button('camera')!.querySelector('.slashed')).toBeNull();
  });

  it('marks muted mic and stopped camera as off', () => {
    const { button } = render({ ...allOn, micEnabled: false, cameraEnabled: false });
    expect(button('mic')!.classList).toContain('off');
    expect(button('mic')!.getAttribute('aria-label')).toBe('Unmute');
    expect(button('camera')!.classList).toContain('off');
    expect(button('camera')!.querySelector('.slashed')).not.toBeNull();
  });

  it('highlights an active screen share', () => {
    const { button } = render({ ...allOn, screenShareEnabled: true });
    expect(button('screen')!.classList).toContain('active');
    expect(button('screen')!.getAttribute('aria-label')).toBe('Stop sharing');
  });

  it('hides screen share where the browser cannot share', () => {
    expect(render({ ...allOn, canShareScreen: false }).button('screen')).toBeNull();
  });

  it('emits one intent per button', () => {
    const { fixture, button } = render(allOn);
    const c = fixture.componentInstance;
    const spies = {
      mic: vi.fn(),
      camera: vi.fn(),
      screen: vi.fn(),
      chat: vi.fn(),
      leave: vi.fn(),
    };
    c.toggleMic.subscribe(spies.mic);
    c.toggleCamera.subscribe(spies.camera);
    c.toggleScreenShare.subscribe(spies.screen);
    c.openChat.subscribe(spies.chat);
    c.leave.subscribe(spies.leave);

    for (const cls of ['mic', 'camera', 'screen', 'chat', 'leave']) button(cls)!.click();

    for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows unread chat messages on the chat button', () => {
    const { fixture, el, button } = render(allOn);
    expect(el.querySelector('.badge')).toBeNull();
    expect(button('chat')!.getAttribute('aria-label')).toBe('Chat');

    fixture.componentRef.setInput('unreadChats', 3);
    fixture.detectChanges();
    expect(el.querySelector('.badge')!.textContent!.trim()).toBe('3');
    expect(button('chat')!.getAttribute('aria-label')).toBe('Chat, 3 unread');

    fixture.componentRef.setInput('unreadChats', 120);
    fixture.detectChanges();
    expect(el.querySelector('.badge')!.textContent!.trim()).toBe('99+');
  });

  it('offers front/rear flip only on devices with a rear camera, while the camera is on', () => {
    expect(render({ ...allOn, canFlip: true }).button('flip')).not.toBeNull();
    TestBed.resetTestingModule();
    expect(render({ ...allOn, canFlip: true, cameraEnabled: false }).button('flip')).toBeNull();
    TestBed.resetTestingModule();
    expect(render({ ...allOn, canFlip: false }).button('flip')).toBeNull();
  });

  it('emits flipCamera', () => {
    const { fixture, button } = render({ ...allOn, canFlip: true });
    const flip = vi.fn();
    fixture.componentInstance.flipCamera.subscribe(flip);
    button('flip')!.click();
    expect(flip).toHaveBeenCalledOnce();
  });

  it('lists cameras in the more menu, checks the active one and emits the picked id', async () => {
    const { fixture, button } = render({
      ...allOn,
      cameras: [
        { id: 'a', label: 'FaceTime HD Camera' },
        { id: 'b', label: 'Logitech BRIO' },
      ],
      activeCameraId: 'a',
    });
    const select = vi.fn();
    fixture.componentInstance.selectCamera.subscribe(select);

    await openMore(fixture, button('more')!);
    const items = [...document.body.querySelectorAll<HTMLElement>('.camera-item')];

    expect(items.map((i) => i.textContent!.trim())).toEqual([
      'FaceTime HD Camera',
      'Logitech BRIO',
    ]);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    items[1].click();
    expect(select).toHaveBeenCalledWith('b');
  });

  it('offers the views and self-view modes, checks the current ones and emits choices', async () => {
    const { fixture, button } = render({ ...allOn, view: 'speaker', selfView: 'float' });
    const views: string[] = [];
    const selfViews: string[] = [];
    fixture.componentInstance.selectView.subscribe((v) => views.push(v));
    fixture.componentInstance.selectSelfView.subscribe((v) => selfViews.push(v));

    await openMore(fixture, button('more')!);
    const viewItems = [...document.body.querySelectorAll<HTMLElement>('.view-item')];
    const selfItems = [...document.body.querySelectorAll<HTMLElement>('.self-view-item')];
    expect(viewItems.map((i) => i.textContent!.trim())).toEqual(['Grid', 'Speaker']);
    expect(viewItems.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(selfItems.map((i) => i.textContent!.trim())).toEqual([
      'In layout',
      'Floating',
      'Hidden',
    ]);
    expect(selfItems.map((i) => i.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);

    viewItems[0].click();
    selfItems[2].click();
    expect(views).toEqual(['grid']);
    expect(selfViews).toEqual(['hidden']);
  });

  it('hides the camera picker with a single camera', async () => {
    const { fixture, button } = render({ ...allOn, cameras: [{ id: 'a', label: 'Only' }] });
    await openMore(fixture, button('more')!);
    expect(document.body.querySelector('.ant-dropdown-menu')).not.toBeNull(); // menu did open
    expect(document.body.querySelector('.camera-item')).toBeNull();
  });

  it('offers the camera qualities, checks the chosen one and emits a new choice', async () => {
    const { fixture, button } = render({
      ...allOn,
      qualities: ['2160p', '1080p', '720p'],
      quality: '1080p',
    });
    const select = vi.fn();
    fixture.componentInstance.selectQuality.subscribe(select);

    await openMore(fixture, button('more')!);
    const items = [...document.body.querySelectorAll<HTMLElement>('.quality-item')];

    expect(items.map((i) => i.textContent!.trim())).toEqual(['4K', '1080p', '720p']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    items[0].click();
    expect(select).toHaveBeenCalledWith('2160p');
  });

  it('offers the video codecs, checks the chosen one and emits a new choice', async () => {
    const { fixture, button } = render({
      ...allOn,
      codecs: ['vp9', 'vp8'],
      codec: 'vp9',
      sendingCodec: 'vp9',
    });
    const select = vi.fn();
    fixture.componentInstance.selectCodec.subscribe(select);

    await openMore(fixture, button('more')!);
    const items = [...document.body.querySelectorAll<HTMLElement>('.codec-item')];

    expect(items.map((i) => i.textContent!.trim())).toEqual(['VP9', 'VP8']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(document.body.querySelector('.codec-note')).toBeNull();
    items[1].click();
    expect(select).toHaveBeenCalledWith('vp8');
  });

  it('says so when it sends a fallback codec', async () => {
    const { fixture, button } = render({
      ...allOn,
      codecs: ['vp9', 'vp8'],
      codec: 'vp9',
      sendingCodec: 'vp8',
    });

    await openMore(fixture, button('more')!);
    expect(document.body.querySelector('.codec-note')?.textContent?.trim()).toBe(
      'Sending VP8: not everyone here can play VP9',
    );
  });

  it('hides the codec picker when there’s nothing to choose', async () => {
    const { fixture, button } = render({ ...allOn, codecs: ['vp8'] });
    await openMore(fixture, button('more')!);
    expect(document.body.querySelector('.codec-item')).toBeNull();
  });
});
