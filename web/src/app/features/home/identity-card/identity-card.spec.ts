import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { IdentityCard } from './identity-card';

function render(status: string) {
  TestBed.configureTestingModule({
    imports: [IdentityCard],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(IdentityCard);
  fixture.componentRef.setInput('status', status);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('IdentityCard', () => {
  it('offers to set up an identity', () => {
    const { el, fixture } = render('none');
    const setUp = vi.fn();
    fixture.componentInstance.setUp.subscribe(setUp);
    expect(el.textContent).toContain('recognise you next time');
    el.querySelector<HTMLButtonElement>('.set-up')!.click();
    expect(setUp).toHaveBeenCalled();
  });

  it('says when it is set up, and offers to start over', () => {
    const { el, fixture } = render('ready');
    const startOver = vi.fn();
    fixture.componentInstance.startOver.subscribe(startOver);
    expect(el.textContent).toContain('can recognise you in later calls');
    el.querySelector<HTMLButtonElement>('.start-over')!.click();
    expect(startOver).toHaveBeenCalled();
  });

  it('explains when this browser can’t keep one', () => {
    expect(render('unavailable').el.textContent).toContain("can't keep an identity");
  });

  it('shows nothing while loading', () => {
    expect(render('unknown').el.textContent!.trim()).toBe('');
  });
});
