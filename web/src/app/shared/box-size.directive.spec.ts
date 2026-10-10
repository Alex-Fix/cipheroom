import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BoxSizeDirective } from './box-size.directive';

type Callback = (entries: object[]) => void;

@Component({
  imports: [BoxSizeDirective],
  template: `<div (appBoxSize)="sizes.push($event)"></div>`,
})
class Host {
  readonly sizes: { w: number; h: number }[] = [];
}

describe('BoxSizeDirective', () => {
  let callback: Callback;
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = disconnect;
        observe = vi.fn();
        constructor(cb: Callback) {
          callback = cb;
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports width and height, and stops observing when destroyed', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    callback([{ contentRect: { width: 800, height: 450 } }]);
    expect(fixture.componentInstance.sizes).toEqual([{ w: 800, h: 450 }]);

    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
  });
});
