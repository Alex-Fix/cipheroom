import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    document.head.innerHTML = `
      <meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
      <link id="theme-light" rel="stylesheet" media="(prefers-color-scheme: light)">
      <link id="theme-dark" rel="stylesheet" media="(prefers-color-scheme: dark)">`;
  });

  it('forces the dark theme and restores system appearance afterwards', () => {
    const theme = TestBed.inject(ThemeService);
    const light = document.getElementById('theme-light') as HTMLLinkElement;
    const dark = document.getElementById('theme-dark') as HTMLLinkElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;

    theme.setForcedDark(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(light.media).toBe('not all');
    expect(dark.media).toBe('all');
    expect(meta.content).toBe('#000000');

    theme.setForcedDark(false);
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(light.media).toBe('(prefers-color-scheme: light)');
    expect(dark.media).toBe('(prefers-color-scheme: dark)');
    expect(meta.content).toBe('#f2f2f7');
  });
});
