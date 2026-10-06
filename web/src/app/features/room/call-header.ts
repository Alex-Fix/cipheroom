import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ConnectionState } from 'livekit-client';
import { NzBadgeModule } from 'ng-zorro-antd/badge';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzPopoverModule } from 'ng-zorro-antd/popover';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';

export type CallStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** LiveKit starts out "disconnected" before the first connect — that's still "connecting" to the user. */
export function callStatus(state: ConnectionState, joined: boolean): CallStatus {
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

const BADGE: Record<
  CallStatus,
  { status: 'success' | 'processing' | 'warning' | 'error'; text: string }
> = {
  connecting: { status: 'processing', text: 'Connecting…' },
  connected: { status: 'success', text: 'Connected' },
  reconnecting: { status: 'warning', text: 'Reconnecting…' },
  disconnected: { status: 'error', text: 'Disconnected' },
};

/** Call header: room id + copy, connection state, encryption state, participant count. Presentational. */
@Component({
  selector: 'app-call-header',
  imports: [
    NzBadgeModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzPopoverModule,
    NzTagModule,
    NzTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="room">
      <span class="room-id" [title]="roomId()">{{ roomId() }}</span>
      <button
        nz-button
        nzType="text"
        class="copy"
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
          autofocus
        />
      </ng-template>
    </div>

    <div class="status">
      <nz-badge
        class="state"
        [class.compact-hidden]="status() === 'connected'"
        [nzStatus]="badge().status"
        [nzText]="badge().text"
      />
      @if (status() === 'disconnected') {
        <button nz-button nzSize="small" class="rejoin" (click)="rejoin.emit()">
          <nz-icon nzType="reload" /> Rejoin
        </button>
      }

      @if (encrypted()) {
        <nz-tag
          class="e2ee"
          nzColor="success"
          nz-tooltip
          nzTooltipTitle="Media is end-to-end encrypted"
        >
          <nz-icon nzType="lock" /> <span class="tag-text">Encrypted</span>
        </nz-tag>
      } @else {
        <nz-tag
          class="e2ee"
          nzColor="warning"
          nz-tooltip
          nzTooltipTitle="End-to-end encryption isn't enabled in this build yet. The server can see this call."
        >
          <nz-icon nzType="unlock" /> <span class="tag-text">Not encrypted yet</span>
        </nz-tag>
      }

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

  protected readonly badge = computed(() => BADGE[this.status()]);
}
