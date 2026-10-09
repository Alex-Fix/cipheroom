import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { UsageDto } from '../../../core/signaling/signaling.types';
import { resetDate } from '../usage-text';

/**
 * Why quality dropped or video stopped (usage guard, docs/plans/2026-10-09-usage-guard-design.md): shown to everyone
 * in the call. Saving can be dismissed (until the level changes); audio-only can't. Presentational.
 */
@Component({
  selector: 'app-usage-banner',
  imports: [NzIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './usage-banner.html',
  styleUrl: './usage-banner.less',
})
export class UsageBanner {
  readonly usage = input<UsageDto | undefined>(undefined);

  private readonly dismissedLevel = signal<string | undefined>(undefined);

  protected readonly text = computed(() => {
    const usage = this.usage();
    if (!usage) return undefined;
    if (usage.level === 'saving') {
      return `Saving bandwidth: ${usage.percent ?? 0}% of this month's free traffic is used. Video is limited to 720p.`;
    }
    if (usage.level === 'audio-only') {
      return `This month's free traffic is almost used. Calls are audio-only until ${resetDate(usage)}.`;
    }
    return undefined;
  });
  protected readonly dismissible = computed(() => this.usage()?.level === 'saving');
  protected readonly visible = computed(
    () => !!this.text() && this.dismissedLevel() !== this.usage()?.level,
  );

  protected dismiss(): void {
    this.dismissedLevel.set(this.usage()?.level);
  }
}
