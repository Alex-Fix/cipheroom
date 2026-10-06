import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { loadDisplayName, saveDisplayName } from '../../core/settings/display-name';
import { newRoomId } from './room-id';

@Component({
  selector: 'app-home',
  imports: [FormsModule, NzButtonModule, NzIconModule, NzInputModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.less',
})
export class Home {
  private readonly router = inject(Router);

  protected readonly name = signal(loadDisplayName());
  protected readonly roomId = signal(
    inject(ActivatedRoute).snapshot.queryParamMap.get('room') ?? newRoomId(),
  );

  protected validRoom(): boolean {
    return /^[a-z0-9-]{3,64}$/.test(this.roomId());
  }

  protected regenerateRoom(): void {
    this.roomId.set(newRoomId());
  }

  protected join(): void {
    const name = this.name().trim();
    if (!name || !this.validRoom()) return;
    saveDisplayName(name);
    void this.router.navigate(['/r', this.roomId()]);
  }
}
