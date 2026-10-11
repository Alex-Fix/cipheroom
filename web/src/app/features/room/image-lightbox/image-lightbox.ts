import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { SharedFile } from '../../../core/files/file-transfer.service';

/** A shared image at full size, with Save. */
@Component({
  selector: 'app-image-lightbox',
  imports: [NzIconModule, NzModalModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './image-lightbox.html',
  styleUrl: './image-lightbox.less',
})
export class ImageLightbox {
  readonly file = input<SharedFile | undefined>();
  readonly closed = output();
}
