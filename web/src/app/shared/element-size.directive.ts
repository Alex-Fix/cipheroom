import { DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

/** Emits the host element's rendered width in CSS pixels whenever it changes; 0 while it's scrolled off screen. */
@Directive({ selector: '[appElementSize]' })
export class ElementSizeDirective {
  readonly appElementSize = output<number>();

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let width = 0;
    let onScreen = true;
    const emit = () => this.appElementSize.emit(onScreen ? width : 0);

    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(([entry]) => {
            width = entry.contentRect.width;
            emit();
          });
    const intersection =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
            emit();
          });
    resize?.observe(element);
    intersection?.observe(element);

    inject(DestroyRef).onDestroy(() => {
      resize?.disconnect();
      intersection?.disconnect();
    });
  }
}
