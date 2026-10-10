import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { Trust } from '../../../core/contacts/contacts';
import { CallParticipant } from '../../../core/media/media.types';
import { PendingGuest } from '../../../core/lobby/lobby.service';
import { initials } from '../../../shared/initials';

/** Something a host or co-host does to one participant. */
export type ParticipantAction = 'make-cohost' | 'ask-to-mute' | 'remove' | 'verify' | 'unverify';

/**
 * Everyone in the media room, and — for hosts and co-hosts — the lobby. Part of the ghost-participant defence
 * (docs/architecture.md): people must always be able to see who can receive their media. Names come from each
 * participant's own signed key envelope; roles from our own checks of the room's signed authority. Presentational.
 */
@Component({
  selector: 'app-participants-panel',
  imports: [NzButtonModule, NzDrawerModule, NzDropdownModule, NzIconModule, NzMenuModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './participants-panel.html',
  styleUrl: './participants-panel.less',
})
export class ParticipantsPanel {
  readonly open = input.required<boolean>();
  readonly participants = input.required<CallParticipant[]>();
  /** Knocks waiting for a decision (only shown to admitters). */
  readonly guests = input<PendingGuest[]>([]);
  /** We may admit, deny, remove and ask to mute. */
  readonly canAdmit = input(false);
  /** We may also make co-hosts and remove co-hosts. */
  readonly isHost = input(false);
  /** How much we know each participant (contacts, by participant id). */
  readonly trust = input<ReadonlyMap<string, Trust>>(new Map());
  /** Participants with a device key: they can be marked as verified. */
  readonly verifiable = input<ReadonlySet<string>>(new Set());

  readonly closed = output();
  readonly admit = output<string>();
  readonly deny = output<string>();
  readonly admitAll = output();
  readonly act = output<{ action: ParticipantAction; participantId: string }>();

  /** You first, then everyone else alphabetically — stable, so rows don't jump while people talk. */
  protected readonly sorted = computed(() =>
    [...this.participants()].sort(
      (a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name),
    ),
  );

  protected readonly roleLabel: Record<CallParticipant['role'], string> = {
    host: 'Host',
    cohost: 'Co-host',
    guest: '',
  };

  protected monogram(name: string): string {
    return initials(name);
  }

  protected trustOf(p: CallParticipant): Trust | undefined {
    return p.isLocal ? undefined : this.trust().get(p.identity);
  }

  protected canVerify(p: CallParticipant): boolean {
    return !p.isLocal && this.verifiable().has(p.identity);
  }

  /** Co-hosts manage guests only; hosts manage everyone but themselves. */
  protected canManage(p: CallParticipant): boolean {
    return (
      !p.isLocal && this.canAdmit() && (this.isHost() ? p.role !== 'host' : p.role === 'guest')
    );
  }
}
