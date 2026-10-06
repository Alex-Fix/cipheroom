import { TestBed } from '@angular/core/testing';
import { ConnectionState } from 'livekit-client';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../core/ui/icons';
import { CallHeader, CallStatus, callStatus } from './call-header';

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

describe('callStatus', () => {
  it('treats the initial disconnected state as connecting', () => {
    expect(callStatus(ConnectionState.Disconnected, false)).toBe('connecting');
    expect(callStatus(ConnectionState.Disconnected, true)).toBe('disconnected');
  });

  it('maps both reconnect states to reconnecting', () => {
    expect(callStatus(ConnectionState.Reconnecting, true)).toBe('reconnecting');
    expect(callStatus(ConnectionState.SignalReconnecting, true)).toBe('reconnecting');
    expect(callStatus(ConnectionState.Connected, true)).toBe('connected');
  });

  it('reports a failed join regardless of LiveKit state', () => {
    expect(callStatus(ConnectionState.Disconnected, false, true)).toBe('failed');
  });
});

describe('CallHeader', () => {
  it('shows room id, state and participant count', () => {
    const { el } = render('connected');
    expect(el.querySelector('.room-id')?.textContent).toBe('abc-123');
    expect(el.querySelector('.state')?.textContent).toContain('Connected');
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('2');
  });

  it('is honest about encryption', () => {
    expect(render('connected').el.querySelector('.e2ee')?.textContent).toContain(
      'Not encrypted yet',
    );
    TestBed.resetTestingModule();
    expect(
      render('connected', { encrypted: true }).el.querySelector('.e2ee')?.textContent,
    ).toContain('Encrypted');
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
});
