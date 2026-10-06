import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzPopoverModule } from 'ng-zorro-antd/popover';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { CallStatus } from '../call-status';

const STATUS_TEXT: Record<CallStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  failed: 'Not connected',
};

/** Call header: room id + copy, connection state, encryption state, participant count. Presentational. */
@Component({
  selector: 'app-call-header',
  imports: [NzButtonModule, NzIconModule, NzInputModule, NzPopoverModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './call-header.html',
  styleUrl: './call-header.less',
})
export class CallHeader {
  readonly roomId = input.required<string>();
  readonly link = input.required<string>();
  readonly status = input.required<CallStatus>();
  /** Only true once E2EE is actually active — never optimistic. */
  readonly encrypted = input(false);
  readonly participants = input.required<number>();
  /** Clipboard API unavailable (insecure context): show the link for manual copying. */
  readonly manualCopy = input(false);

  readonly copyLink = output();
  readonly manualCopyClosed = output();
  readonly rejoin = output();
  readonly showParticipants = output();

  protected readonly statusText = computed(() => STATUS_TEXT[this.status()]);
}
