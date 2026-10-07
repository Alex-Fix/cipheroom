import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { SafetyCode } from '../../../core/crypto/safety-code';

/**
 * The call's safety code, for comparing out loud: everyone in the call should see the same emoji and digits. If
 * someone's differ, the server may have slipped a participant in or swapped a key. Presentational.
 */
@Component({
  selector: 'app-safety-code',
  imports: [NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './safety-code.html',
  styleUrl: './safety-code.less',
})
export class SafetyCodePanel {
  readonly code = input.required<SafetyCode>();
  /** Participants whose identity didn't verify: they get no keys (can't see or hear you) — but something is off. */
  readonly unverified = input(0);
}
