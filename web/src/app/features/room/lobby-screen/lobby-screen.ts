import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';

/** What the lobby screen shows: waiting to be let in, or why we're out of the call. */
export type LobbyScreenState = 'waiting' | 'denied' | 'removed' | 'ended' | 'paused';

interface Copy {
  icon: string;
  title: string;
  text: string;
}

/**
 * Shown instead of the call while we wait in the lobby, or after we were turned away, removed, or the call ended.
 * Presentational.
 */
@Component({
  selector: 'app-lobby-screen',
  imports: [NzButtonModule, NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lobby-screen.html',
  styleUrl: './lobby-screen.less',
})
export class LobbyScreen {
  readonly state = input.required<LobbyScreenState>();
  /** Someone who can let us in is in the call right now. */
  readonly hostHere = input(false);
  /** Asking again is allowed (the server makes us wait a little after being turned away). */
  readonly canAskAgain = input(true);
  /** Paused (usage guard): the day calls are possible again, e.g. "1 November". */
  readonly resetDate = input('');

  readonly cancel = output();
  readonly home = output();
  readonly askAgain = output();

  protected readonly copy = computed<Copy>(() => {
    switch (this.state()) {
      case 'waiting':
        return this.hostHere()
          ? {
              icon: 'hourglass',
              title: 'Waiting for the host to let you in…',
              text: 'Your name was sent to the host encrypted — the server can’t read it.',
            }
          : {
              icon: 'hourglass',
              title: 'The host isn’t here yet',
              text: 'You’ll be asked in as soon as the host or a co-host joins.',
            };
      case 'denied':
        return {
          icon: 'lock',
          title: 'The host didn’t let you in',
          text: 'You can ask again in a moment.',
        };
      case 'removed':
        return {
          icon: 'user-delete',
          title: 'You were removed from the call',
          text: 'The call’s keys have changed: you can’t see or hear it anymore.',
        };
      case 'ended':
        return { icon: 'poweroff', title: 'The host ended the call', text: 'Everyone has left.' };
      case 'paused':
        return {
          icon: 'pause-circle',
          title: `Calls are paused until ${this.resetDate()}`,
          text: 'This month’s free traffic is used up. You can start calls again once the month resets.',
        };
    }
  });
}
