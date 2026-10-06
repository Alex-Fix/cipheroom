import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ConnectionState } from 'livekit-client';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzPopoverModule } from 'ng-zorro-antd/popover';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';

export type CallStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/**
 * LiveKit starts out "disconnected" before the first connect — that's still "connecting" to the user.
 * `failed` = the join itself failed (the room shows its own Retry, so no Rejoin in the header).
 */
export function callStatus(state: ConnectionState, joined: boolean, failed = false): CallStatus {
  if (failed) return 'failed';
  switch (state) {
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'reconnecting';
    case ConnectionState.Connecting:
      return 'connecting';
    default:
      return joined ? 'disconnected' : 'connecting';
  }
}

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
  template: `
    <div class="room">
      <span class="room-id" [title]="roomId()">{{ roomId() }}</span>
      <button
        type="button"
        class="icon-button glass copy"
        aria-label="Copy invite link"
        nz-tooltip
        nzTooltipTitle="Copy invite link"
        nz-popover
        [nzPopoverContent]="manualCopyTpl"
        nzPopoverTitle="Copy this link"
        [nzPopoverTrigger]="null"
        [nzPopoverVisible]="manualCopy()"
        (nzPopoverVisibleChange)="!$event && manualCopyClosed.emit()"
        nzPopoverPlacement="bottomLeft"
        (click)="copyLink.emit()"
      >
        <nz-icon nzType="copy" />
      </button>
      <ng-template #manualCopyTpl>
        <input
          nz-input
          readonly
          class="manual-copy"
          [value]="link()"
          (focus)="$any($event.target).select()"
          aria-label="Invite link"
        />
      </ng-template>
    </div>

    <div class="status glass">
      <span class="state" [attr.data-status]="status()">
        <span class="dot" aria-hidden="true"></span>
        <span class="state-text">{{ statusText() }}</span>
      </span>

      @if (status() === 'disconnected') {
        <button
          nz-button
          nzType="primary"
          nzShape="round"
          nzSize="small"
          class="rejoin"
          (click)="rejoin.emit()"
        >
          Rejoin
        </button>
      }

      <span class="divider" aria-hidden="true"></span>

      @if (encrypted()) {
        <span class="e2ee secure" nz-tooltip nzTooltipTitle="Media is end-to-end encrypted">
          <nz-icon nzType="lock" /> <span class="label">Encrypted</span>
        </span>
      } @else {
        <span
          class="e2ee"
          nz-tooltip
          nzTooltipTitle="End-to-end encryption isn't enabled in this build yet. The server can see this call."
        >
          <nz-icon nzType="unlock" /> <span class="label">Not encrypted yet</span>
        </span>
      }

      <span class="divider" aria-hidden="true"></span>

      <span
        class="count"
        nz-tooltip
        nzTooltipTitle="Participants"
        [attr.aria-label]="participants() + ' participants'"
      >
        <nz-icon nzType="team" /> {{ participants() }}
      </span>
    </div>
  `,
  styleUrl: './call-header.scss',
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

  protected readonly statusText = computed(() => STATUS_TEXT[this.status()]);
}
