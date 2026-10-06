---
name: angular-frontend
description: Conventions and scaffolding for the Cipheroom Angular frontend (standalone components, signals, SignalR client, livekit-client, crypto service boundaries, dev proxy, nginx Dockerfile). Use when creating or modifying anything under web/.
---

# Angular frontend

## Scaffold (first time only)
```bash
npx @angular/cli@latest new web --directory web --routing --style=scss --ssr=false --skip-git
cd web && npm i @microsoft/signalr livekit-client
```
Add `web/proxy.conf.json` proxying `/api` and `/hubs` (with `"ws": true`) to `http://localhost:5080`,
and reference it from `angular.json` → `serve.options.proxyConfig`.

## Structure
```
web/src/app/
  core/
    signaling/   signaling.service.ts, signaling.types.ts   (SignalR wrapper, typed)
    livekit/     livekit.service.ts                         (Room, tracks → signals; see `livekit-media`)
    crypto/      identity, sender-keys, key provider, safety code, chat crypto (see `e2ee-media`)
    media/       media-devices.service.ts                   (device list, preview before join)
  features/
    home/        create/join room
    room/        room.ts (container) + call-header, call-tile, call-controls, diagnostics-drawer
  shared/        presentational components, pipes
core/ui/          icons.ts (static ng-zorro icon registry), theme.service.ts (OS appearance / forced dark)
```

## Conventions
- Standalone components only, `ChangeDetectionStrategy.OnPush`, signals (`signal`, `computed`, `input()`, `output()`),
  `inject()` for DI, new control flow (`@if`, `@for`).
- Zoneless change detection if the CLI default supports it; WebRTC/SignalR callbacks then just set signals.
- Services in `core/` are `providedIn: 'root'` except room-scoped state, which is provided on the room route.
- Video tiles: `track.attach(videoEl)` / `track.detach()` in a directive tied to the element lifecycle. Local preview muted.
- LiveKit callbacks run outside Angular's knowledge — only ever write to signals from them.
- E2EE worker: `new Worker(new URL('livekit-client/e2ee-worker', import.meta.url))` — check the Angular builder bundles it.
- Only `core/crypto` touches key material. Components get booleans/strings (e.g. safety code), never keys.
- Feature containers (e.g. `Room`) inject services; their child components are presentational (inputs/outputs only).

## Look & feel: Apple HIG on ng-zorro-antd
Design: `docs/plans/2026-10-06-ngzorro-ui-design.md` (see "Revision: Apple-style").
- **Appearance:** follows the OS (light/dark) everywhere; the call screen is always dark (`ThemeService.setForcedDark`).
- **Tokens:** use the CSS variables from `src/styles.less` (`--bg`, `--bg-elevated`, `--label`, `--label-secondary`,
  `--separator`, `--fill`, `--accent`, `--red`, `--green`, `--orange`, `--glass*`) — iOS system colours, defined for
  both appearances. Never hard-code a colour that differs between light and dark.
- **Materials:** add the global `glass` class for frosted surfaces (falls back to opaque with reduced transparency).
- **Type:** system font stack (SF on Apple devices); HIG sizes — 34 large title, 22 title, 17 body/headline,
  15 callout, 13 footnote. No web fonts.
- **Targets:** ≥ 44 px on touch (`@media (pointer: coarse)`); respect `env(safe-area-inset-*)`.
- **Conventions:** toggled-off device = white button with dark glyph; destructive = `--red`; grey monogram avatars;
  inset grouped lists for forms; visible `:focus-visible` ring; honour `prefers-reduced-motion`.

### ng-zorro specifics
- Import the per-component `NzXxxModule` in each standalone component; global providers only in `app.config.ts`
  (`provideNzI18n(en_US)`, `provideNzIcons(APP_ICONS)`, `provideNzConfig`). ng-zorro 22 needs no `@angular/animations`.
- Themes: `src/theme/theme-{light,dark}.less` are non-injected bundles linked from `index.html` with
  `media="(prefers-color-scheme: …)"` (no flash, no JS needed). Both share `_components.less` (**only the
  `<component>/style/entry.less` files we use** — add one when using a new component) and `_apple.less` (shared
  Less variable overrides). Their file names are unhashed, so nginx serves them with `expires -1`.
- App logo / favicons: masters in `src/assets-src/logo{,-small}.svg` (CC BY-SA 4.0, `LICENSE-ASSETS.md`); edit those,
  then run `scripts/icons.sh` and commit the regenerated files in `public/`. Masters must stay static SVG (no
  scripts, images, styles or external refs — the generator rejects them).
- Icons: add to `core/ui/icons.ts`. **Never** enable dynamic icon loading (`NzIconService` fetch / CDN): CSP
  `connect-src 'self'` blocks it and a third-party fetch would leak who uses the app.
- `NzMessageService` renders string content with `[innerHTML]`: only pass **constant strings** — never display names,
  room ids, or error text from browsers/servers. Show those via template interpolation.
- Component SCSS stays SCSS; per-component style budget is 4 kB warn / 8 kB error.

## Commands
- Dev: `npm start --prefix web` (or `scripts/dev.sh`)
- Test: `npm test --prefix web -- --watch=false`
- Build: `npm run build --prefix web`

## Dockerfile
Multi-stage: `node:lts-alpine` build → `nginx:alpine` serving `dist/web/browser`, SPA fallback
(`try_files $uri /index.html`), proxy `/api` and `/hubs` (WebSocket upgrade headers) to `api:8080`.
Security headers: strict CSP (`script-src 'self'`, `worker-src 'self' blob:`, `connect-src 'self'` — LiveKit is same-origin under `/livekit/`), `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`.
