import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzPopoverModule } from 'ng-zorro-antd/popover';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { SafetyCode } from '../../../core/crypto/safety-code';
import { CallStatus } from '../call-status';
import { SafetyCodePanel } from '../safety-code/safety-code';

const STATUS_TEXT: Record<CallStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  failed: 'Not connected',
};

/**
 * Call header: room id + copy, connection state, encryption state (opens the safety code), participant count.
 * Presentational.
 */
@Component({
  selector: 'app-call-header',
  imports: [
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzPopoverModule,
    NzTooltipModule,
    SafetyCodePanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './call-header.html',
  styleUrl: './call-header.less',
})
export class CallHeader {
  readonly roomId = input.required<string>();
  readonly link = input.required<string>();
  readonly status = input.required<CallStatus>();
  /** Set only while end-to-end encryption is running (our keys in place) — never optimistic. */
  readonly safetyCode = input<SafetyCode>();
  /** Participants whose identity didn't verify (they get no keys). */
  readonly unverified = input(0);
  readonly participants = input.required<number>();
  /** Clipboard API unavailable (insecure context): show the link for manual copying. */
  readonly manualCopy = input(false);

  readonly copyLink = output();
  readonly manualCopyClosed = output();
  readonly rejoin = output();
  readonly showParticipants = output();

  protected readonly statusText = computed(() => STATUS_TEXT[this.status()]);
  /** What screen readers announce for the badge: the code in words. */
  protected readonly safetyCodeLabel = computed(() => {
    const code = this.safetyCode();
    if (!code) return undefined;
    const emoji = code.emoji.map((e) => e.name).join(', ');
    return `End-to-end encrypted. Safety code: ${emoji}, ${code.digits}. Show details`;
  });
}
