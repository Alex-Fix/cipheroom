import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { APP_ICONS } from '../../../core/ui/icons';
import { LobbyScreen, LobbyScreenState } from './lobby-screen';

describe('LobbyScreen', () => {
  let fixture: ComponentFixture<LobbyScreen>;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideNzIcons(APP_ICONS)] });
    fixture = TestBed.createComponent(LobbyScreen);
  });

  function render(state: LobbyScreenState, hostHere = false): HTMLElement {
    fixture.componentRef.setInput('state', state);
    fixture.componentRef.setInput('hostHere', hostHere);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('says whether the host is here while waiting, and offers Cancel', () => {
    expect(render('waiting', false).textContent).toContain('The host isn’t here yet');
    const el = render('waiting', true);
    expect(el.textContent).toContain('Waiting for the host to let you in');
    expect(el.querySelector('.cancel')).not.toBeNull();
    expect(el.querySelector('.home')).toBeNull();
  });

  it('lets a turned-away guest ask again once allowed', () => {
    const el = render('denied');
    const ask = el.querySelector<HTMLButtonElement>('.ask-again')!;
    expect(ask.disabled).toBe(false);
    fixture.componentRef.setInput('canAskAgain', false);
    fixture.detectChanges();
    expect(ask.disabled).toBe(true);
  });

  it.each([
    ['removed', 'You were removed from the call'],
    ['ended', 'The host ended the call'],
  ] as const)('explains %s and only offers going home', (state, text) => {
    const el = render(state);
    expect(el.textContent).toContain(text);
    expect(el.querySelector('.ask-again')).toBeNull();
    expect(el.querySelector('.home')).not.toBeNull();
  });

  it('says until when calls are paused', () => {
    fixture.componentRef.setInput('resetDate', '1 November');
    const el = render('paused');
    expect(el.textContent).toContain('Calls are paused until 1 November');
    expect(el.querySelector('.home')).not.toBeNull();
    expect(el.querySelector('.ask-again')).toBeNull();
  });

  it('emits the chosen action', () => {
    const cancel = vi.fn();
    fixture.componentInstance.cancel.subscribe(cancel);
    render('waiting').querySelector<HTMLButtonElement>('.cancel')!.click();
    expect(cancel).toHaveBeenCalled();
  });
});
