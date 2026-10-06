import { TestBed } from '@angular/core/testing';
import { Track } from 'livekit-client';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { Tile } from '../../core/livekit/livekit.service';
import { APP_ICONS } from '../../core/ui/icons';
import { CallTile } from './call-tile';

function tile(overrides: Partial<Tile> = {}): Tile {
  return {
    key: 'alex:camera',
    name: 'Alex Papish',
    displayName: 'Alex Papish',
    isLocal: false,
    isScreen: false,
    isSpeaking: false,
    micMuted: false,
    ...overrides,
  };
}

function render(t: Tile): HTMLElement {
  TestBed.configureTestingModule({ imports: [CallTile], providers: [provideNzIcons(APP_ICONS)] });
  const fixture = TestBed.createComponent(CallTile);
  fixture.componentRef.setInput('tile', t);
  fixture.detectChanges();
  return fixture.nativeElement;
}

const fakeTrack = () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as Track;

describe('CallTile', () => {
  it('shows an initials monogram when there is no video', () => {
    const el = render(tile());
    expect(el.querySelector('.monogram')?.textContent).toContain('AP');
    expect(el.querySelector('video')).toBeNull();
  });

  it('shows video instead of avatar and mirrors only the local camera', () => {
    const local = render(tile({ video: fakeTrack(), isLocal: true }));
    expect(local.querySelector('.monogram')).toBeNull();
    expect(local.querySelector('video')?.classList).toContain('mirror');
  });

  it('marks a muted microphone', () => {
    expect(render(tile({ micMuted: true })).querySelector('.mic-off')).not.toBeNull();
  });

  it('highlights the active speaker', () => {
    expect(render(tile({ isSpeaking: true })).classList).toContain('speaking');
  });

  it('tags screen shares and does not mirror them', () => {
    const el = render(tile({ isScreen: true, isLocal: true, video: fakeTrack(), micMuted: true }));
    expect(el.querySelector('.screen-tag')?.textContent).toContain('Screen');
    expect(el.querySelector('.mic-off')).toBeNull();
    expect(el.querySelector('video')?.classList).not.toContain('mirror');
  });

  it('renders names as text, never as HTML', () => {
    const el = render(tile({ name: '<img src=x onerror=alert(1)>' }));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.name')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
