import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { AudioPlayback } from '../core/media/audio-playback';

/** Plays a media track in the host <video>/<audio> element for as long as both exist. */
@Directive({ selector: 'video[appTrack], audio[appTrack]' })
export class TrackDirective {
  readonly track = input<MediaStreamTrack | undefined>(undefined, { alias: 'appTrack' });

  private readonly element = inject<ElementRef<HTMLMediaElement>>(ElementRef).nativeElement;
  private readonly audio = inject(AudioPlayback);

  constructor() {
    effect((onCleanup) => {
      const track = this.track();
      if (!track) return;
      this.element.srcObject = new MediaStream([track]);
      if (track.kind === 'audio') {
        // Sound may need a user gesture first (autoplay policy): AudioPlayback tracks that.
        this.audio.play(this.element);
      } else {
        // Muted video always autoplays; a rejection here only means the element went away.
        void this.element.play().catch(() => undefined);
      }
      onCleanup(() => {
        this.audio.forget(this.element);
        this.element.srcObject = null;
      });
    });
  }
}
