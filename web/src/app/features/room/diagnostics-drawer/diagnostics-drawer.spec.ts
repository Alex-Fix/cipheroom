import { TestBed } from '@angular/core/testing';
import { Diagnostics } from '../../../core/media/media.types';
import { DiagnosticsDrawer } from './diagnostics-drawer';

function render(diagnostics: Diagnostics) {
  TestBed.configureTestingModule({ imports: [DiagnosticsDrawer] });
  const fixture = TestBed.createComponent(DiagnosticsDrawer);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('diagnostics', diagnostics);
  fixture.detectChanges();
  // nz-drawer renders into a CDK overlay attached to document.body.
  return document.body.querySelector<HTMLElement>('.rows')!;
}

describe('DiagnosticsDrawer', () => {
  it('shows the selected ICE path per direction', () => {
    const rows = render({
      forceRelay: true,
      publisher: {
        localType: 'relay',
        remoteType: 'host',
        protocol: 'udp',
        relayProtocol: 'tls',
        rttMs: 42,
      },
    });
    expect(rows.textContent).toContain('Relay forced');
    expect(rows.textContent).toContain('yes');
    expect(rows.textContent).toContain('via TURN/tls');
    expect(rows.textContent).toContain('42 ms');
    expect(rows.textContent).toContain('—'); // no subscriber path yet
  });
});
