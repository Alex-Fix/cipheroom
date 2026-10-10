import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { DeviceIdentityStatus } from '../../../core/crypto/device-keys.service';

/**
 * This browser's identity (device key): set it up so people you call recognise you, or start over. Restoring goes
 * through the home page's "Import a backup". Presentational.
 */
@Component({
  selector: 'app-identity-card',
  imports: [NzButtonModule, NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './identity-card.html',
  styleUrl: './identity-card.less',
})
export class IdentityCard {
  readonly status = input.required<DeviceIdentityStatus>();
  readonly busy = input(false);

  readonly setUp = output();
  readonly startOver = output();
}
