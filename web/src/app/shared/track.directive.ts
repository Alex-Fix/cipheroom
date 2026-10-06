import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { Track } from 'livekit-client';

/** Attaches a LiveKit track to the host <video>/<audio> element for as long as both exist. */
@Directive({ selector: 'video[appTrack], audio[appTrack]' })
export class TrackDirective {
  readonly track = input<Track | undefined>(undefined, { alias: 'appTrack' });

  private readonly element = inject<ElementRef<HTMLMediaElement>>(ElementRef).nativeElement;

  constructor() {
    effect((onCleanup) => {
      const track = this.track();
      if (!track) return;
      track.attach(this.element);
      onCleanup(() => track.detach(this.element));
    });
  }
}
