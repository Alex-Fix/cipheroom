import { DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

/** Emits the host element's content-box size in CSS pixels whenever it changes. */
@Directive({ selector: '[appBoxSize]' })
export class BoxSizeDirective {
  readonly appBoxSize = output<{ w: number; h: number }>();

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      this.appBoxSize.emit({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(element);
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}
