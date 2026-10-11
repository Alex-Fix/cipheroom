import { TestBed } from '@angular/core/testing';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { SharedFile } from '../../../core/files/file-transfer.service';
import { APP_ICONS } from '../../../core/ui/icons';
import { ImageLightbox } from './image-lightbox';

const photo: SharedFile = {
  id: 'f1', name: 'beach.jpg', size: 10, mime: 'image/jpeg', image: true, own: false, fromId: 'bob', state: 'done', progress: 1, url: 'blob:full',
};

describe('ImageLightbox', () => {
  afterEach(() => document.body.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  it('shows the image full size with Save, and closes', async () => {
    TestBed.configureTestingModule({ imports: [ImageLightbox], providers: [provideNzIcons(APP_ICONS)] });
    const fixture = TestBed.createComponent(ImageLightbox);
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.componentRef.setInput('file', photo);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(document.body.querySelector('img.full')!.getAttribute('src')).toBe('blob:full');
    expect(document.body.querySelector('a.save')!.getAttribute('download')).toBe('beach.jpg');
    document.body.querySelector<HTMLButtonElement>('.ant-modal-close')!.click();
    expect(closed).toBe(1);
  });
});
