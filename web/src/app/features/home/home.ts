import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

export const DISPLAY_NAME_KEY = 'cipheroom.displayName';

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
}

@Component({
  selector: 'app-home',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="home">
      <h1>Cipheroom</h1>
      <p class="muted">Self-hosted, end-to-end encrypted video calls.</p>
      <form (ngSubmit)="join()" class="card">
        <label>
          Your name
          <input name="name" [(ngModel)]="name" maxlength="64" required autocomplete="nickname" />
        </label>
        <label>
          Room
          <input name="room" [(ngModel)]="roomId" pattern="[a-z0-9-]{3,64}" required />
        </label>
        <button type="submit" [disabled]="!name().trim() || !validRoom()">Join</button>
      </form>
    </main>
  `,
})
export class Home {
  private readonly router = inject(Router);

  protected readonly name = signal(loadDisplayName());
  protected readonly roomId = signal(inject(ActivatedRoute).snapshot.queryParamMap.get('room') ?? newRoomId());

  protected validRoom(): boolean {
    return /^[a-z0-9-]{3,64}$/.test(this.roomId());
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
