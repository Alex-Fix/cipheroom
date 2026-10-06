import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzFormModule } from 'ng-zorro-antd/form';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';

export const DISPLAY_NAME_KEY = 'cipheroom.displayName';

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
}

@Component({
  selector: 'app-home',
  imports: [
    FormsModule,
    NzButtonModule,
    NzCardModule,
    NzFormModule,
    NzIconModule,
    NzInputModule,
    NzTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.scss',
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
    try {
      localStorage.setItem(DISPLAY_NAME_KEY, name);
    } catch {
      // Storage unavailable (private mode) — name just won't be remembered.
    }
    void this.router.navigate(['/r', this.roomId()]);
  }
}
