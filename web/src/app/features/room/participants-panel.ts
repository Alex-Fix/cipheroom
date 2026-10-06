import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { CallParticipant } from '../../core/livekit/livekit.service';
import { initials } from '../../shared/initials';

/**
 * Everyone in the media room. Part of the ghost-participant defence (docs/architecture.md): people must always be
 * able to see who can receive their media. Presentational.
 */
@Component({
  selector: 'app-participants-panel',
  imports: [NzDrawerModule, NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nz-drawer
      [nzVisible]="open()"
      [nzTitle]="'People (' + participants().length + ')'"
      nzPlacement="right"
      [nzWidth]="360"
      (nzOnClose)="closed.emit()"
    >
      <ng-container *nzDrawerContent>
        <ul class="list" aria-label="Participants">
          @for (p of sorted(); track p.identity) {
            <li class="person" [class.speaking]="p.isSpeaking">
              <span class="monogram" aria-hidden="true">{{ monogram(p.name) }}</span>
              <span class="name">
                {{ p.name }}
                @if (p.isLocal) {
                  <span class="you">(You)</span>
                }
              </span>
              <span class="status">
                @if (p.sharingScreen) {
                  <span class="sharing" role="img" aria-label="Sharing screen">
                    <nz-icon nzType="desktop" aria-hidden="true" />
                  </span>
                }
                <span
                  [class.off]="p.micMuted"
                  role="img"
                  [attr.aria-label]="p.micMuted ? 'Microphone off' : 'Microphone on'"
                >
                  <nz-icon [nzType]="p.micMuted ? 'audio-muted' : 'audio'" aria-hidden="true" />
                </span>
                <span
                  [class.off]="!p.cameraOn"
                  role="img"
                  [attr.aria-label]="p.cameraOn ? 'Camera on' : 'Camera off'"
                >
                  <nz-icon nzType="video-camera" [class.slashed]="!p.cameraOn" aria-hidden="true" />
                </span>
              </span>
            </li>
          }
        </ul>
        <p class="footnote">
          Everyone listed can see and hear this call. Names aren't verified yet — until end-to-end
          encryption and safety codes arrive, this list is only as trustworthy as your server.
        </p>
      </ng-container>
    </nz-drawer>
  `,
  styleUrl: './participants-panel.less',
})
export class ParticipantsPanel {
  readonly open = input.required<boolean>();
  readonly participants = input.required<CallParticipant[]>();
  readonly closed = output();

  /** You first, then everyone else alphabetically — stable, so rows don't jump while people talk. */
  protected readonly sorted = computed(() =>
    [...this.participants()].sort(
      (a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name),
    ),
  );

  protected monogram(name: string): string {
    return initials(name);
  }
}
