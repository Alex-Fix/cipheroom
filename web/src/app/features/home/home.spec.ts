import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../core/ui/icons';
import { DISPLAY_NAME_KEY } from '../../core/settings/display-name';
import { Home } from './home';

async function setup() {
  localStorage.removeItem(DISPLAY_NAME_KEY);
  TestBed.configureTestingModule({
    imports: [Home],
    providers: [provideRouter([]), provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(Home);
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  await fixture.whenStable();
  const el: HTMLElement = fixture.nativeElement;
  const type = async (id: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
  return { fixture, el, navigate, type, submit };
}

describe('Home', () => {
  // A browser that can do encrypted calls (jsdom has WebCrypto Ed25519/X25519 but no encoded transforms).
  beforeEach(() => vi.stubGlobal('RTCRtpScriptTransform', class {}));
  afterEach(() => vi.unstubAllGlobals());

  it('tells browsers that can’t encrypt calls they can’t join, and disables Join', async () => {
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    vi.stubGlobal('RTCRtpSender', class {});
    const { el, type, submit, fixture } = await setup();
    await type('name', 'Alex');
    await fixture.whenStable();

    expect(el.textContent).toContain("This browser can't join encrypted calls.");
    expect(submit.disabled).toBe(true);
  });

  it('shows a validation message for an invalid room id and disables Join', async () => {
    const { el, type, submit } = await setup();
    await type('name', 'Alex');
    await type('room', 'Bad Room!');

    expect(el.textContent).toContain('lowercase letters, digits and dashes');
    expect(submit.disabled).toBe(true);
  });

  it('stores the name and navigates to the room on Join', async () => {
    const { navigate, type, submit } = await setup();
    await type('name', '  Alex  ');
    await type('room', 'abc-123');

    submit.click();

    expect(localStorage.getItem(DISPLAY_NAME_KEY)).toBe('Alex');
    expect(navigate).toHaveBeenCalledWith(['/r', 'abc-123']);
  });

  it('replaces the room id with a new random one', async () => {
    const { el, fixture, type } = await setup();
    const room = el.querySelector<HTMLInputElement>('#room')!;
    await type('room', 'abc-123');

    el.querySelector<HTMLButtonElement>('.regenerate')!.click();
    await fixture.whenStable();

    expect(room.value).not.toBe('abc-123');
    expect(room.value).toMatch(/^[0-9a-f-]{14}$/);
  });
});
