import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { SharedFile } from '../../../core/files/file-transfer.service';
import { APP_ICONS } from '../../../core/ui/icons';
import { FileCard, formatBytes } from './file-card';

function shared(overrides: Partial<SharedFile> = {}): SharedFile {
  return {
    id: 'f1',
    name: 'report.pdf',
    size: 2_400_000,
    mime: 'application/pdf',
    image: false,
    own: false,
    fromId: 'bob',
    state: 'available',
    progress: 0,
    ...overrides,
  };
}

async function render(file: SharedFile) {
  TestBed.configureTestingModule({ imports: [FileCard], providers: [provideNzIcons(APP_ICONS)] });
  const fixture = TestBed.createComponent(FileCard);
  fixture.componentRef.setInput('file', file);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const events = { download: 0, cancel: 0, view: 0 };
  fixture.componentInstance.download.subscribe(() => events.download++);
  fixture.componentInstance.cancel.subscribe(() => events.cancel++);
  fixture.componentInstance.view.subscribe(() => events.view++);
  const set = (f: SharedFile) => {
    fixture.componentRef.setInput('file', f);
    fixture.detectChanges();
  };
  return { el, events, set, fixture };
}

describe('FileCard', () => {
  it('shows a file’s name and size with Download, then progress with Cancel, then Save', async () => {
    const { el, events, set } = await render(shared());
    expect(el.querySelector('.name')!.textContent).toBe('report.pdf');
    expect(el.querySelector('.size')!.textContent).toBe('2.4 MB');

    el.querySelector<HTMLButtonElement>('.download')!.click();
    expect(events.download).toBe(1);

    set(shared({ state: 'downloading', progress: 0.42 }));
    expect(el.querySelector('.progress')!.textContent).toContain('42%');
    el.querySelector<HTMLButtonElement>('.progress')!.click();
    expect(events.cancel).toBe(1);

    set(shared({ state: 'done', progress: 1, url: 'blob:http://localhost/abc' }));
    const save = el.querySelector<HTMLAnchorElement>('a.save')!;
    expect(save.getAttribute('download')).toBe('report.pdf');
    expect(save.getAttribute('href')).toBe('blob:http://localhost/abc');
  });

  it('never renders a file that isn’t a raster image, even when we have it', async () => {
    const { el } = await render(shared({ name: 'page.html', mime: 'text/html', state: 'done', url: 'blob:x' }));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('iframe, object, embed')).toBeNull();
  });

  it('shows images inline once downloaded, and a blurred preview until then', async () => {
    const { el, events, set } = await render(shared({ name: 'a.jpg', mime: 'image/jpeg', image: true, thumbUrl: 'blob:thumb' }));
    expect(el.querySelector('.preview img')!.getAttribute('src')).toBe('blob:thumb');

    set(shared({ name: 'a.jpg', mime: 'image/jpeg', image: true, thumbUrl: 'blob:thumb', state: 'done', url: 'blob:full' }));
    const img = el.querySelector<HTMLImageElement>('.image:not(.preview) img')!;
    expect(img.getAttribute('src')).toBe('blob:full');
    el.querySelector<HTMLButtonElement>('button.image')!.click();
    expect(events.view).toBe(1);
  });

  it('falls back to a plain file when the image doesn’t decode', async () => {
    const { el, fixture } = await render(shared({ name: 'a.png', mime: 'image/png', image: true, state: 'done', url: 'blob:bad' }));
    el.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a.save')).not.toBeNull();
  });

  it('tells the sender to stay, and when photo details could not be removed', async () => {
    const { el, set } = await render(shared({ own: true, state: 'shared', url: 'blob:own', metadataKept: true }));
    expect(el.querySelector('.note')!.textContent).toContain('stay in the call');
    expect(el.querySelector('.warn')!.textContent).toContain('were not removed');

    set(shared({ own: true, state: 'shared', url: 'blob:own', progress: 0.5 }));
    expect(el.querySelector('.note')!.textContent).toContain('Sending… 50%');
  });

  it('explains files that can’t be had', async () => {
    const { el, set } = await render(shared({ state: 'unavailable' }));
    expect(el.textContent).toContain('No longer available');
    set(shared({ state: 'corrupted' }));
    expect(el.textContent).toContain('File changed or corrupted');
    set(shared({ state: 'paused' }));
    expect(el.textContent).toContain('File sharing paused');
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_234)).toBe('1.2 KB');
    expect(formatBytes(23_456_789)).toBe('23 MB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('105 MB');
  });
});
