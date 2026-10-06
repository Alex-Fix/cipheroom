import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { CallParticipant } from '../../../core/livekit/livekit.service';
import { initials } from '../../../shared/initials';

/**
 * Everyone in the media room. Part of the ghost-participant defence (docs/architecture.md): people must always be
 * able to see who can receive their media. Presentational.
 */
@Component({
  selector: 'app-participants-panel',
  imports: [NzDrawerModule, NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './participants-panel.html',
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
