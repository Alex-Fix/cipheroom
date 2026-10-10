import { Directive, ElementRef, inject, input, output, signal } from '@angular/core';
import { Corner } from '../../core/settings/call-view';
import { nearestCorner } from './layout/call-layout';

/** Moves this far before a press counts as a drag (a tap still reaches the tile). */
export const DRAG_THRESHOLD_PX = 6;

/**
 * Drags the floating self-view with mouse, pen or finger (Pointer Events) and, on release, emits the corner of its
 * container nearest to where it was dropped. While dragging it moves the element directly; on release it puts the
 * layout's position back so the room's new placement (the corner) animates in.
 */
@Directive({
  selector: '[appCornerDrag]',
  host: {
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'up($event)',
    '(pointercancel)': 'cancel()',
    '[style.touch-action]': "appCornerDrag() ? 'none' : null",
    '[class.dragging]': 'dragging()',
  },
})
export class CornerDragDirective {
  readonly appCornerDrag = input(false);
  readonly cornerDrop = output<Corner>();

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private start?: {
    x: number;
    y: number;
    pointer: number;
    transform: string;
    left: number;
    top: number;
  };
  protected readonly dragging = signal(false);

  protected down(event: PointerEvent): void {
    if (!this.appCornerDrag() || event.button !== 0) return;
    // The bubble's own buttons (minimize) stay buttons: capturing would retarget their click.
    if ((event.target as Element | null)?.closest?.('button')) return;
    // Capture at once: a quick first move already leaves the small bubble.
    this.element.setPointerCapture?.(event.pointerId);
    const parent = this.element.parentElement?.getBoundingClientRect();
    const own = this.element.getBoundingClientRect();
    this.start = {
      x: event.clientX,
      y: event.clientY,
      pointer: event.pointerId,
      transform: this.element.style.transform,
      left: own.left - (parent?.left ?? 0),
      top: own.top - (parent?.top ?? 0),
    };
  }

  protected move(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.pointer) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!this.dragging()) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      this.dragging.set(true);
    }
    this.element.style.transform = `translate(${start.left + dx}px, ${start.top + dy}px)`;
  }

  protected up(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.pointer) return;
    if (this.dragging()) {
      const parent = this.element.parentElement;
      const own = this.element.getBoundingClientRect();
      const box = parent?.getBoundingClientRect();
      const center = {
        x: own.left + own.width / 2 - (box?.left ?? 0),
        y: own.top + own.height / 2 - (box?.top ?? 0),
      };
      // The visible part of a scrolling container, not its whole content.
      const visibleH = parent?.parentElement?.clientHeight || box?.height || 0;
      this.element.style.transform = start.transform;
      this.cornerDrop.emit(nearestCorner(center, { w: box?.width ?? 0, h: visibleH }));
    }
    this.reset();
  }

  protected cancel(): void {
    if (this.start && this.dragging()) this.element.style.transform = this.start.transform;
    this.reset();
  }

  private reset(): void {
    this.start = undefined;
    this.dragging.set(false);
  }
}
