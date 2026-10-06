import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

const LIGHT = '(prefers-color-scheme: light)';
const DARK = '(prefers-color-scheme: dark)';

/**
 * Appearance follows the OS (light/dark) everywhere except calls, which are always dark — like FaceTime,
 * video reads best on black. Swaps which ng-zorro theme <link> applies and sets [data-theme] for app tokens.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);

  setForcedDark(forced: boolean): void {
    const root = this.doc.documentElement;
    if (forced) root.dataset['theme'] = 'dark';
    else delete root.dataset['theme'];

    this.media('theme-light', forced ? 'not all' : LIGHT);
    this.media('theme-dark', forced ? 'all' : DARK);
    this.doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = forced || meta.media === DARK ? '#000000' : '#f2f2f7';
    });
  }

  private media(id: string, media: string): void {
    const link = this.doc.getElementById(id) as HTMLLinkElement | null;
    if (link) link.media = media;
  }
}
