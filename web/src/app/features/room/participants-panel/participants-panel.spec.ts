import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { CallParticipant } from '../../../core/livekit/livekit.service';
import { APP_ICONS } from '../../../core/ui/icons';
import { ParticipantsPanel } from './participants-panel';

const person = (overrides: Partial<CallParticipant>): CallParticipant => ({
  identity: overrides.name ?? 'x',
  name: 'x',
  isLocal: false,
  isSpeaking: false,
  micMuted: false,
  cameraOn: true,
  sharingScreen: false,
  ...overrides,
});

function render(participants: CallParticipant[]): HTMLElement {
  TestBed.configureTestingModule({
    imports: [ParticipantsPanel],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(ParticipantsPanel);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('participants', participants);
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

  it('is honest that names are not verified yet', () => {
    expect(render([person({ name: 'Bob' })]).textContent).toContain("Names aren't verified yet");
  });

  it('renders names as text, never as HTML', () => {
    const drawer = render([person({ name: '<img src=x onerror=alert(1)>' })]);
    expect(drawer.querySelector('.person img')).toBeNull();
    expect(drawer.querySelector('.person .name')!.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});
