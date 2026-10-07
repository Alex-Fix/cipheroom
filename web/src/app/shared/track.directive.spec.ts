import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AudioPlayback } from '../core/media/audio-playback';
import { TrackDirective } from './track.directive';

@Component({
  imports: [TrackDirective],
  template: `<audio [appTrack]="audio()"></audio><video [appTrack]="video()" muted></video>`,
})
class Host {
  readonly audio = signal<MediaStreamTrack | undefined>(undefined);
  readonly video = signal<MediaStreamTrack | undefined>(undefined);
}

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
}

describe('TrackDirective', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('plays audio through AudioPlayback and video directly, and detaches on removal', () => {
    const playback = { play: vi.fn(), forget: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: AudioPlayback, useValue: playback }] });
    const fixture = TestBed.createComponent(Host);
    const audio = { kind: 'audio' } as MediaStreamTrack;
    const video = { kind: 'video' } as MediaStreamTrack;
    const [audioEl, videoEl] = fixture.nativeElement.querySelectorAll('audio, video');

    fixture.componentInstance.audio.set(audio);
    fixture.componentInstance.video.set(video);
    fixture.detectChanges();

    expect((audioEl.srcObject as FakeMediaStream).tracks).toEqual([audio]);
    expect(playback.play).toHaveBeenCalledWith(audioEl);
    expect((videoEl.srcObject as FakeMediaStream).tracks).toEqual([video]);
    expect(videoEl.play).toHaveBeenCalled();

    fixture.componentInstance.audio.set(undefined);
    fixture.detectChanges();
    expect(audioEl.srcObject).toBeNull();
    expect(playback.forget).toHaveBeenCalledWith(audioEl);
  });
});
