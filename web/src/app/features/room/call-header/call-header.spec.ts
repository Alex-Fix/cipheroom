import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { CallHeader } from './call-header';
import { SafetyCode } from '../../../core/crypto/safety-code';
import { CallStatus } from '../call-status';

const code: SafetyCode = {
  emoji: [
    { symbol: '🐙', name: 'octopus' },
    { symbol: '🌵', name: 'cactus' },
    { symbol: '🚲', name: 'bicycle' },
    { symbol: '🔑', name: 'key' },
  ],
  digits: '4821 9037',
};

function render(status: CallStatus, extra: Record<string, unknown> = {}) {
  TestBed.configureTestingModule({ imports: [CallHeader], providers: [provideNzIcons(APP_ICONS)] });
  const fixture = TestBed.createComponent(CallHeader);
  const inputs = {
    roomId: 'abc-123',
    link: 'https://x/r/abc-123',
    status,
    participants: 2,
    ...extra,
  };
  for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('CallHeader', () => {
  it('shows room id, state and participant count', () => {
    const { el } = render('connected');
    expect(el.querySelector('.room-id')?.textContent).toBe('abc-123');
    expect(el.querySelector('.state')?.textContent).toContain('Connected');
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('2');
  });

  it('shows no lock until encryption is running', () => {
    const e2ee = render('connected').el.querySelector('.e2ee');
    expect(e2ee?.textContent).toContain('Securing…');
    expect(e2ee?.classList).not.toContain('secure');
  });

  it('opens the safety code from the Encrypted badge', async () => {
    const { el, fixture } = render('connected', { safetyCode: code });
    const badge = el.querySelector<HTMLButtonElement>('button.e2ee.secure')!;
    expect(badge.textContent).toContain('Encrypted');

    badge.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.querySelector('app-safety-code .digits')?.textContent).toBe('4821 9037');
  });

  it('flags unverified participants on the badge', () => {
    const badge = render('connected', { safetyCode: code, unverified: 1 }).el.querySelector(
      '.e2ee',
    );
    expect(badge?.classList).toContain('warn');
  });

  it('offers Rejoin only when disconnected', () => {
    expect(render('reconnecting').el.querySelector('.rejoin')).toBeNull();
    TestBed.resetTestingModule();
    expect(render('failed').el.querySelector('.rejoin')).toBeNull();
    TestBed.resetTestingModule();
    const { fixture, el } = render('disconnected');
    const rejoin = vi.fn();
    fixture.componentInstance.rejoin.subscribe(rejoin);
    el.querySelector<HTMLButtonElement>('.rejoin')!.click();
    expect(rejoin).toHaveBeenCalledOnce();
  });

  it('emits copyLink from the copy button', () => {
    const { fixture, el } = render('connected');
    const copy = vi.fn();
    fixture.componentInstance.copyLink.subscribe(copy);
    el.querySelector<HTMLButtonElement>('.copy')!.click();
    expect(copy).toHaveBeenCalledOnce();
  });

  it('opens the people list from the count', () => {
    const { fixture, el } = render('connected');
    const show = vi.fn();
    fixture.componentInstance.showParticipants.subscribe(show);
    el.querySelector<HTMLButtonElement>('button.count')!.click();
    expect(show).toHaveBeenCalledOnce();
  });
});
