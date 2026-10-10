import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Corner } from '../../core/settings/call-view';
import { CornerDragDirective, DRAG_THRESHOLD_PX } from './corner-drag.directive';

@Component({
  imports: [CornerDragDirective],
  template: `<div class="canvas">
    <div
      class="bubble"
      [appCornerDrag]="enabled()"
      [style.transform]="'translate(10px, 10px)'"
      (cornerDrop)="drops.push($event)"
    ></div>
  </div>`,
})
class Host {
  readonly enabled = signal(true);
  readonly drops: Corner[] = [];
}

/** jsdom has no layout: the bubble's box follows its transform, the canvas is 1000×600 at the origin. */
function rects(bubble: HTMLElement) {
  const canvas = bubble.parentElement!;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 600,
  } as DOMRect);
  vi.spyOn(bubble, 'getBoundingClientRect').mockImplementation(() => {
    const [x, y] = (bubble.style.transform.match(/-?[\d.]+/g) ?? ['0', '0']).map(Number);
    return { left: x, top: y, width: 100, height: 60 } as DOMRect;
  });
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true });

describe('CornerDragDirective', () => {
  beforeAll(() => {
    // jsdom lacks PointerEvent.
    if (typeof PointerEvent === 'undefined') {
      vi.stubGlobal(
        'PointerEvent',
        class extends MouseEvent {
          pointerId: number;
          constructor(type: string, init: PointerEventInit = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 0;
          }
        },
      );
    }
  });

  function render() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    rects(bubble);
    return { fixture, bubble, drops: fixture.componentInstance.drops };
  }

  it('follows the pointer and drops into the nearest corner, handing the position back', () => {
    const { bubble, drops } = render();
    bubble.dispatchEvent(pointer('pointerdown', 50, 40));
    bubble.dispatchEvent(pointer('pointermove', 850, 540));
    expect(bubble.style.transform).toBe('translate(810px, 510px)');
    bubble.dispatchEvent(pointer('pointerup', 850, 540));

    expect(drops).toEqual(['bottom-right']);
    // The layout's own placement comes back (the room moves it to the new corner).
    expect(bubble.style.transform).toBe('translate(10px, 10px)');
  });

  it('treats a small movement as a tap, not a drag', () => {
    const { bubble, drops } = render();
    bubble.dispatchEvent(pointer('pointerdown', 50, 40));
    bubble.dispatchEvent(pointer('pointermove', 50 + DRAG_THRESHOLD_PX - 2, 40));
    bubble.dispatchEvent(pointer('pointerup', 50 + DRAG_THRESHOLD_PX - 2, 40));
    expect(drops).toEqual([]);
    expect(bubble.style.transform).toBe('translate(10px, 10px)');
  });

  it('leaves presses on the bubble’s own buttons alone', () => {
    const { bubble, drops } = render();
    const button = document.createElement('button');
    bubble.appendChild(button);
    button.dispatchEvent(pointer('pointerdown', 50, 40));
    bubble.dispatchEvent(pointer('pointermove', 850, 540));
    bubble.dispatchEvent(pointer('pointerup', 850, 540));
    expect(drops).toEqual([]);
    expect(bubble.style.transform).toBe('translate(10px, 10px)');
  });

  it('does nothing when not enabled, and puts the bubble back on cancel', () => {
    const { fixture, bubble, drops } = render();
    bubble.dispatchEvent(pointer('pointerdown', 50, 40));
    bubble.dispatchEvent(pointer('pointermove', 400, 300));
    bubble.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    expect(bubble.style.transform).toBe('translate(10px, 10px)');

    fixture.componentInstance.enabled.set(false);
    fixture.detectChanges();
    bubble.dispatchEvent(pointer('pointerdown', 50, 40));
    bubble.dispatchEvent(pointer('pointermove', 900, 500));
    bubble.dispatchEvent(pointer('pointerup', 900, 500));
    expect(drops).toEqual([]);
  });
});
