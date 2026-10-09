import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { UsageDto } from '../../../core/signaling/signaling.types';
import { APP_ICONS } from '../../../core/ui/icons';
import { UsageBanner } from './usage-banner';

describe('UsageBanner', () => {
  let fixture: ComponentFixture<UsageBanner>;
  const el = () => fixture.nativeElement as HTMLElement;

  function render(usage: UsageDto | undefined): void {
    fixture.componentRef.setInput('usage', usage);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideNzIcons(APP_ICONS)] });
    fixture = TestBed.createComponent(UsageBanner);
  });

  const at = (level: UsageDto['level'], percent: number | null = 83): UsageDto => ({
    level,
    percent,
    resetsAt: '2026-11-01T00:00:00Z',
  });

  it('shows nothing normally', () => {
    render(undefined);
    expect(el().querySelector('.banner')).toBeNull();
    render(at('normal', null));
    expect(el().querySelector('.banner')).toBeNull();
  });

  it('explains saving and can be dismissed until the level changes', () => {
    render(at('saving'));
    expect(el().textContent).toContain('83% of this month');
    expect(el().textContent).toContain('720p');
    el().querySelector<HTMLButtonElement>('.dismiss')!.click();
    fixture.detectChanges();
    expect(el().querySelector('.banner')).toBeNull();

    render(at('audio-only', 96));
    expect(el().textContent).toContain('audio-only until 1 November');
    expect(el().querySelector('.dismiss')).toBeNull();
  });
});
