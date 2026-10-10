import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMenuModule } from 'ng-zorro-antd/menu';
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
 * Call header: room id + copy, connection state, encryption state (opens the safety code), participant count (with
 * how many wait in the lobby), and the host menu (auto-admit, end the call) for hosts and co-hosts. Presentational.
 */
@Component({
  selector: 'app-call-header',
  imports: [
    NzButtonModule,
    NzDropdownModule,
    NzIconModule,
    NzInputModule,
    NzMenuModule,
    NzPopoverModule,
    NzTooltipModule,
    SafetyCodePanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './call-header.html',
  styleUrl: './call-header.less',
})
export class CallHeader {
  /**
   * The safety code card opens under the whole header, right-aligned: the badge sits on the right on wide screens, and
   * on phones (where it starts a row of its own) a card anchored to the small badge would hang off the screen.
   */
  protected readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly safetyCodePlacement = ['bottomRight', 'bottom', 'bottomLeft'];

  readonly roomId = input.required<string>();
  readonly link = input.required<string>();
  readonly status = input.required<CallStatus>();
  /** Set only while end-to-end encryption is running (our keys in place) — never optimistic. */
  readonly safetyCode = input<SafetyCode>();
  /** Participants whose identity didn't verify (they get no keys). */
  readonly unverified = input(0);
  readonly participants = input.required<number>();
  /** Not in a call (lobby, removed, ended, paused): no connection or encryption state to show. */
  readonly inCall = input(true);
  /** Clipboard API unavailable (insecure context): show the link for manual copying. */
  readonly manualCopy = input(false);
  /** People knocking (shown to admitters). */
  readonly waiting = input(0);
  /** We're a host or co-host: show the host menu. */
  readonly canAdmit = input(false);
  /** Only the host changes settings. */
  readonly isHost = input(false);
  readonly autoAdmit = input(false);
  /** Our connection has been poor for a while: show a chip that opens the Connection drawer. */
  readonly poorConnection = input(false);

  readonly copyLink = output();
  readonly manualCopyClosed = output();
  readonly rejoin = output();
  readonly showParticipants = output();
  readonly showConnection = output();
  readonly setAutoAdmit = output<boolean>();
  readonly endCall = output();

  protected readonly statusText = computed(() => STATUS_TEXT[this.status()]);
  /** What screen readers announce for the badge: the code in words. */
  protected readonly safetyCodeLabel = computed(() => {
    const code = this.safetyCode();
    if (!code) return undefined;
    const emoji = code.emoji.map((e) => e.name).join(', ');
    return `End-to-end encrypted. Safety code: ${emoji}, ${code.digits}. Show details`;
  });
}
