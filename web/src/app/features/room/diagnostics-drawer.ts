import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { Diagnostics } from '../../core/livekit/livekit.service';
import { IcePath } from '../../core/livekit/ice-path';

/** Connection path details (which ICE candidates / TURN transport are in use). Presentational. */
@Component({
  selector: 'app-diagnostics-drawer',
  imports: [NzDrawerModule, NzTagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nz-drawer
      [nzVisible]="open()"
      nzTitle="Connection diagnostics"
      nzPlacement="right"
      [nzWidth]="360"
      (nzOnClose)="closed.emit()"
    >
      <ng-container *nzDrawerContent>
        <dl class="rows">
          <dt>Relay forced</dt>
          <dd>{{ diagnostics().forceRelay ? 'yes' : 'no' }}</dd>
          @for (row of rows(); track row.label) {
            <dt>{{ row.label }}</dt>
            <dd>
              @if (row.path; as path) {
                <nz-tag [nzColor]="path.localType === 'relay' ? 'blue' : 'default'">{{
                  path.localType
                }}</nz-tag>
                ⇄ {{ path.remoteType }}
                <div class="detail">
                  {{ path.protocol
                  }}{{ path.relayProtocol ? ' via TURN/' + path.relayProtocol : '' }}
                  @if (path.rttMs !== undefined) {
                    · {{ path.rttMs }} ms
                  }
                </div>
                @if (path.remoteAddress) {
                  <div class="detail mono">{{ path.remoteAddress }}</div>
                }
              } @else {
                <span class="muted">—</span>
              }
            </dd>
          }
        </dl>
      </ng-container>
    </nz-drawer>
  `,
  styles: `
    .rows {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 12px 16px;
      margin: 0;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
    }
    .detail {
      margin-top: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  `,
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
