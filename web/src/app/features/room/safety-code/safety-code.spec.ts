import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { SafetyCode } from '../../../core/crypto/safety-code';
import { APP_ICONS } from '../../../core/ui/icons';
import { SafetyCodePanel } from './safety-code';

const code: SafetyCode = {
  emoji: [
    { symbol: '🐙', name: 'octopus' },
    { symbol: '🌵', name: 'cactus' },
    { symbol: '🚲', name: 'bicycle' },
    { symbol: '🍋', name: 'lemon' },
  ],
  digits: '4821 9037',
};

function render(unverified = 0): HTMLElement {
  TestBed.configureTestingModule({
    imports: [SafetyCodePanel],
    providers: [provideNzIcons(APP_ICONS)],
  });
  const fixture = TestBed.createComponent(SafetyCodePanel);
  fixture.componentRef.setInput('code', code);
  fixture.componentRef.setInput('unverified', unverified);
  fixture.detectChanges();
  return fixture.nativeElement;
}

describe('SafetyCodePanel', () => {
  it('shows the emoji with names to read out, and the digits', () => {
    const el = render();
    expect([...el.querySelectorAll('.symbol')].map((s) => s.textContent)).toEqual([
      '🐙',
      '🌵',
      '🚲',
      '🍋',
    ]);
    expect([...el.querySelectorAll('.name')].map((s) => s.textContent)).toEqual([
      'octopus',
      'cactus',
      'bicycle',
      'lemon',
    ]);
    expect(el.querySelector('.digits')?.textContent).toBe('4821 9037');
    expect(el.querySelector('.warning')).toBeNull();
  });

  it('warns about participants whose identity didn’t verify', () => {
    expect(render(2).querySelector('.warning')?.textContent).toContain(
      "2 participants couldn't be verified",
    );
  });
});
