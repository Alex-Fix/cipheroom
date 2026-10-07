import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { Diagnostics } from '../../../core/media/media.types';
import { IcePath } from '../../../core/media/ice-path';

/** Connection path details (which ICE candidates / TURN transport are in use). Presentational. */
@Component({
  selector: 'app-diagnostics-drawer',
  imports: [NzDrawerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './diagnostics-drawer.html',
  styleUrl: './diagnostics-drawer.less',
})
export class DiagnosticsDrawer {
  readonly open = input.required<boolean>();
  readonly diagnostics = input.required<Diagnostics>();
  readonly closed = output();

  protected readonly rows = computed<{ label: string; path?: IcePath }[]>(() => {
    const d = this.diagnostics();
    return [
      { label: 'Sending', path: d.publisher },
      { label: 'Receiving', path: d.subscriber },
    ];
  });
}
