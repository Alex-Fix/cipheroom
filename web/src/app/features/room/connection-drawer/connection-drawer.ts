import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzIconModule } from 'ng-zorro-antd/icon';
import {
  ConnectionReport,
  dropText,
  kbpsText,
  keysText,
  limitationText,
  msText,
  percentText,
  routeText,
  sourceText,
  streamText,
  verdictText,
} from '../../../core/media/connection-health';

/**
 * Our own link to the SFU: a verdict, the route, network numbers, what we send and encryption counts. Presentational;
 * docs/plans/2026-10-10-connection-diagnostics-design.md.
 */
@Component({
  selector: 'app-connection-drawer',
  imports: [NzButtonModule, NzDrawerModule, NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './connection-drawer.html',
  styleUrl: './connection-drawer.less',
})
export class ConnectionDrawer {
  readonly open = input.required<boolean>();
  readonly report = input<ConnectionReport>();
  /** The report as text when the clipboard was blocked: shown selected, to copy by hand. */
  readonly manualText = input<string>();
  readonly closed = output();
  readonly copy = output();

  private readonly manualBox = viewChild<ElementRef<HTMLTextAreaElement>>('manualBox');

  protected readonly headline = computed(() => {
    const report = this.report();
    return report ? verdictText(report) : 'Not connected';
  });
  protected readonly icon = computed(() => {
    switch (this.report()?.verdict) {
      case 'good':
        return 'check';
      case 'poor':
        return 'exclamation-circle';
      case 'relay':
        return 'info-circle';
      default:
        return 'sync';
    }
  });
  protected readonly dropped = computed(() =>
    Object.entries(this.report()?.encryption.dropped ?? {}).map(([reason, count]) => ({
      reason: dropText(reason),
      count,
    })),
  );

  protected readonly routeText = routeText;
  protected readonly sourceText = sourceText;
  protected readonly streamText = streamText;
  protected readonly limitationText = limitationText;
  protected readonly keysText = keysText;
  protected readonly kbps = kbpsText;
  protected readonly percent = percentText;
  protected readonly ms = msText;

  constructor() {
    effect(() => {
      const box = this.manualBox()?.nativeElement;
      if (!box) return;
      box.focus();
      box.select();
    });
  }
}
