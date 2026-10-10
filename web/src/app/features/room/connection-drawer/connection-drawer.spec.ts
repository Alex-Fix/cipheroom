import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { ConnectionReport } from '../../../core/media/connection-health';
import { APP_ICONS } from '../../../core/ui/icons';
import { ConnectionDrawer } from './connection-drawer';

const report = (overrides: Partial<ConnectionReport> = {}): ConnectionReport => ({
  verdict: 'good',
  reasons: [],
  state: 'connected',
  forceRelay: false,
  route: { relay: false, protocol: 'udp', remoteAddress: '198.51.100.1', rttMs: 42 },
  network: {
    uploadKbps: 2600,
    downloadKbps: 4000,
    uploadLossPercent: 0,
    downloadLossPercent: 0.5,
    jitterMs: 12,
  },
  sending: [
    { source: 'microphone', status: 'on', codec: 'Opus', kbps: 32 },
    {
      source: 'camera',
      status: 'on',
      codec: 'VP9',
      height: 1080,
      fps: 30,
      kbps: 2500,
      layers: ['f', 'h', 'q'],
    },
  ],
  encryption: {
    secured: 1,
    participants: 2,
    epoch: 4,
    totals: {
      framesEncrypted: 900,
      framesDecrypted: 1800,
      framesFailed: 0,
      framesMissingKey: 3,
      envelopesDropped: 2,
      securingSeconds: 1,
    },
    dropped: { 'bad-signature': 2 },
  },
  ...overrides,
});

let fixture: ComponentFixture<ConnectionDrawer>;

function render(r: ConnectionReport | undefined, manualText?: string): HTMLElement {
  TestBed.configureTestingModule({
    imports: [ConnectionDrawer],
    providers: [provideNzIcons(APP_ICONS)],
  });
  fixture = TestBed.createComponent(ConnectionDrawer);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('report', r);
  fixture.componentRef.setInput('manualText', manualText);
  fixture.detectChanges();
  // nz-drawer renders into a CDK overlay attached to document.body.
  return document.body.querySelector<HTMLElement>('.ant-drawer')!;
}

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('ConnectionDrawer', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  it('shows the verdict, route, network, what we send and encryption counts', () => {
    const drawer = render(report());

    expect(text(drawer.querySelector('.verdict h3'))).toBe('Good connection');
    const all = text(drawer)!;
    expect(all).toContain('Direct to the media server (UDP)');
    expect(all).toContain('198.51.100.1');
    expect(all).toContain('42 ms');
    expect(all).toContain('2600 kbps');
    expect(all).toContain('loss 0.5%');
    expect(all).toContain('VP9 · 1080p @ 30 fps · 2500 kbps · layers f h q');
    expect(all).toContain('Limited by —');
    expect(all).toContain('from 1 of 2 people');
    expect(all).toContain('3 missing key');
    expect(all).toContain('2 (bad signature)');
  });

  it('lists why a connection is poor', () => {
    const drawer = render(
      report({
        verdict: 'poor',
        reasons: ['8% packet loss receiving', 'Slow round trip (420 ms)'],
      }),
    );

    expect(drawer.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('poor');
    expect([...drawer.querySelectorAll('.reason')].map(text)).toEqual([
      '8% packet loss receiving',
      'Slow round trip (420 ms)',
    ]);
  });

  it('names the relay transport', () => {
    const drawer = render(
      report({
        verdict: 'relay',
        route: { relay: true, protocol: 'udp', relayProtocol: 'tls', rttMs: 60 },
        forceRelay: true,
      }),
    );

    expect(text(drawer.querySelector('.verdict h3'))).toBe('Connected through a relay (TLS)');
    expect(text(drawer)).toContain('Via TURN relay (TLS)');
    expect(text(drawer)).toContain('Yes, by the server');
  });

  it('shows dashes for numbers the browser has not reported', () => {
    const drawer = render(
      report({ verdict: 'unknown', state: 'connecting', route: undefined, network: {} }),
    );

    expect(text(drawer.querySelector('.verdict h3'))).toBe('Connecting…');
    expect(text(drawer)).toContain('Upload — loss —');
  });

  it('says so when not connected', () => {
    const drawer = render(undefined);

    expect(text(drawer.querySelector('.verdict h3'))).toBe('Not connected');
    expect(drawer.querySelector('.copy')).toBeNull();
  });

  it('asks to copy the report', () => {
    const drawer = render(report());
    let copied = 0;
    fixture.componentInstance.copy.subscribe(() => copied++);

    drawer.querySelector<HTMLButtonElement>('.copy')!.click();

    expect(copied).toBe(1);
  });

  it('shows the text selected when the clipboard is blocked', () => {
    const drawer = render(report(), 'Cipheroom connection report');
    const box = drawer.querySelector<HTMLTextAreaElement>('.manual textarea')!;

    expect(box.value).toBe('Cipheroom connection report');
    expect(box.readOnly).toBe(true);
  });
});
