import { TestBed } from '@angular/core/testing';
import { EMOJI_CATEGORIES, QUICK_REACTIONS } from '../../../core/chat/emoji';
import { RECENT_EMOJI_KEY } from '../../../core/settings/recent-emoji';
import { EmojiPicker } from './emoji-picker';

function render(quick: readonly string[] = []) {
  const fixture = TestBed.createComponent(EmojiPicker);
  fixture.componentRef.setInput('quick', quick);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  const picked: string[] = [];
  fixture.componentInstance.picked.subscribe((e) => picked.push(e));
  return { fixture, el, picked };
}

describe('EmojiPicker', () => {
  beforeEach(() => localStorage.clear());

  it('lists every category', () => {
    const { el } = render();
    expect([...el.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(
      EMOJI_CATEGORIES.map((c) => c.name),
    );
    expect(el.querySelector('.quick')).toBeNull();
  });

  it('emits the picked emoji and shows it under recently used', () => {
    const { fixture, el, picked } = render();
    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent!.trim() === '🎉')!
      .click();
    fixture.detectChanges();

    expect(picked).toEqual(['🎉']);
    expect(el.querySelector('h4')!.textContent).toBe('Recently used');
    expect(el.querySelector('.recent')!.textContent!.trim()).toBe('🎉');
    expect(JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)!)).toEqual(['🎉']);
  });

  it('shows quick reactions first when given', () => {
    const { el, picked } = render(QUICK_REACTIONS);
    const quick = [...el.querySelectorAll<HTMLButtonElement>('.quick button')];
    expect(quick.map((b) => b.textContent!.trim())).toEqual([...QUICK_REACTIONS]);
    quick[0].click();
    expect(picked).toEqual(['👍']);
  });
});
