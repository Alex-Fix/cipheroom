import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { Contact } from '../../../core/contacts/contacts';

/**
 * People this browser has been in calls with. Verifying happens in a call (after comparing the safety code); here
 * one can only take a verification back or forget people. Names by interpolation only. Presentational.
 */
@Component({
  selector: 'app-contacts-list',
  imports: [DatePipe, NzButtonModule, NzIconModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './contacts-list.html',
  styleUrl: './contacts-list.less',
})
export class ContactsList {
  readonly contacts = input.required<readonly Contact[]>();
  /** False: this browser can't store them; they're gone when the page closes. */
  readonly persistent = input(true);

  readonly unverify = output<string>();
  readonly forget = output<string>();
  readonly forgetAll = output();

  /** Verified first, then the most recently met. */
  protected readonly sorted = computed(() =>
    [...this.contacts()].sort(
      (a, b) => Number(b.verified) - Number(a.verified) || b.lastSeen - a.lastSeen,
    ),
  );
}
