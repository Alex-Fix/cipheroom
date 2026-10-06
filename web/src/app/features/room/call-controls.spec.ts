import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../core/ui/icons';
import { CallControls } from './call-controls';

interface State {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  canShareScreen?: boolean;
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

const allOn: State = { micEnabled: true, cameraEnabled: true, screenShareEnabled: false };

describe('CallControls', () => {
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
      leave: vi.fn(),
    };
    c.toggleMic.subscribe(spies.mic);
    c.toggleCamera.subscribe(spies.camera);
    c.toggleScreenShare.subscribe(spies.screen);
    c.leave.subscribe(spies.leave);

    for (const cls of ['mic', 'camera', 'screen', 'leave']) button(cls)!.click();

    for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(1);
  });
});
