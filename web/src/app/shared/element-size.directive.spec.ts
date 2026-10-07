import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ElementSizeDirective } from './element-size.directive';

type Callback = (entries: object[]) => void;

@Component({
  imports: [ElementSizeDirective],
  template: `<div (appElementSize)="sizes.push($event)"></div>`,
})
class Host {
  readonly sizes: number[] = [];
}

describe('ElementSizeDirective', () => {
  const callbacks: Record<string, Callback> = {};
  const observer = (name: string) =>
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: Callback) {
        callbacks[name] = callback;
      }
    };

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', observer('resize'));
    vi.stubGlobal('IntersectionObserver', observer('intersection'));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports width, and 0 while off screen', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    callbacks['resize']([{ contentRect: { width: 640 } }]);
    callbacks['intersection']([{ isIntersecting: false }]);
    callbacks['intersection']([{ isIntersecting: true }]);

    expect(fixture.componentInstance.sizes).toEqual([640, 0, 640]);
  });
});
