import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PendingGuest } from '../../../core/lobby/lobby.service';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { CallParticipant } from '../../../core/media/media.types';
import { APP_ICONS } from '../../../core/ui/icons';
import { ParticipantsPanel } from './participants-panel';

const person = (overrides: Partial<CallParticipant>): CallParticipant => ({
  identity: overrides.name ?? 'x',
  name: 'x',
  role: 'guest',
  isLocal: false,
  isSpeaking: false,
  micMuted: false,
  cameraOn: true,
  sharingScreen: false,
  ...overrides,
});

let fixture: ComponentFixture<ParticipantsPanel>;

function render(
  participants: CallParticipant[],
  inputs: { guests?: PendingGuest[]; canAdmit?: boolean; isHost?: boolean } = {},
): HTMLElement {
  TestBed.configureTestingModule({
    imports: [ParticipantsPanel],
    providers: [provideNzIcons(APP_ICONS)],
  });
  fixture = TestBed.createComponent(ParticipantsPanel);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('participants', participants);
  fixture.componentRef.setInput('guests', inputs.guests ?? []);
  fixture.componentRef.setInput('canAdmit', inputs.canAdmit ?? false);
  fixture.componentRef.setInput('isHost', inputs.isHost ?? false);
  fixture.detectChanges();
  // nz-drawer renders into a CDK overlay attached to document.body.
  return document.body.querySelector<HTMLElement>('.ant-drawer')!;
}

describe('ParticipantsPanel', () => {
  afterEach(() =>
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
  );

  it('lists you first, then everyone alphabetically, with a count', () => {
    const drawer = render([
      person({ name: 'Zoe' }),
      person({ name: 'Alex', isLocal: true }),
      person({ name: 'Bob' }),
    ]);
    const names = [...drawer.querySelectorAll('.person .name')].map((n) => n.textContent!.trim());
    expect(names).toEqual(['Alex (You)', 'Bob', 'Zoe']);
    expect(drawer.textContent).toContain('People (3)');
  });

  it('shows mic, camera and screen-share state', () => {
    const drawer = render([
      person({ name: 'Bob', micMuted: true, cameraOn: false, sharingScreen: true }),
    ]);
    expect(drawer.querySelector('[aria-label="Microphone off"]')).not.toBeNull();
    expect(drawer.querySelector('[aria-label="Camera off"]')).not.toBeNull();
    expect(drawer.querySelector('[aria-label="Sharing screen"]')).not.toBeNull();
  });

  it('labels hosts and co-hosts', () => {
    const drawer = render([
      person({ name: 'Ann', role: 'host' }),
      person({ name: 'Bob', role: 'cohost' }),
    ]);
    expect([...drawer.querySelectorAll('.role')].map((r) => r.textContent)).toEqual([
      'Host',
      'Co-host',
    ]);
  });

  it('shows the lobby to admitters only, with admit and deny', () => {
    const guests: PendingGuest[] = [
      { id: 'g1', name: 'Gina', identity: { ed25519Pub: 'a', x25519Pub: 'b', sig: 'c' } },
      { id: 'g2', name: 'Gus', identity: { ed25519Pub: 'd', x25519Pub: 'e', sig: 'f' } },
    ];
    expect(render([person({ name: 'Ann' })], { guests }).querySelector('.lobby')).toBeNull();
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
    TestBed.resetTestingModule();

    const drawer = render([person({ name: 'Ann' })], { guests, canAdmit: true });
    const admitted = vi.fn();
    const denied = vi.fn();
    fixture.componentInstance.admit.subscribe(admitted);
    fixture.componentInstance.deny.subscribe(denied);
    expect([...drawer.querySelectorAll('.guest .name')].map((n) => n.textContent)).toEqual([
      'Gina',
      'Gus',
    ]);
    drawer.querySelector<HTMLButtonElement>('.guest .admit')!.click();
    drawer.querySelectorAll<HTMLButtonElement>('.guest .deny')[1].click();
    expect(admitted).toHaveBeenCalledWith('g1');
    expect(denied).toHaveBeenCalledWith('g2');
    expect(drawer.querySelector('.admit-all')).not.toBeNull();
  });

  it('offers controls only where our role allows them', () => {
    const people = [
      person({ name: 'Me', isLocal: true, role: 'cohost' }),
      person({ name: 'Ann', role: 'host' }),
      person({ name: 'Bob', role: 'guest' }),
    ];
    expect(render(people).querySelectorAll('.more')).toHaveLength(0);
    document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
    TestBed.resetTestingModule();

    // A co-host manages guests, never the host or themselves.
    const manage = [...render(people, { canAdmit: true }).querySelectorAll('.more')];
    expect(manage.map((b) => b.getAttribute('aria-label'))).toEqual(['Manage Bob']);
  });

  it('renders names as text, never as HTML', () => {
    const drawer = render([person({ name: '<img src=x onerror=alert(1)>' })]);
    expect(drawer.querySelector('.person img')).toBeNull();
    expect(drawer.querySelector('.person .name')!.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});
