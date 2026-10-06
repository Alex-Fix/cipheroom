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
core/ui/icons.ts  every ng-zorro icon the app renders (static registry)
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

## UI kit: ng-zorro-antd (dark theme)
Design: `docs/plans/2026-10-06-ngzorro-ui-design.md`.
- Import the per-component `NzXxxModule` in each standalone component; nothing global beyond `app.config.ts`
  (`provideNzI18n(en_US)`, `provideNzIcons(APP_ICONS)`, `provideNzConfig`). ng-zorro 22 needs no `@angular/animations`.
- Styles: `src/styles.less` imports the dark theme + **only the `<component>/style/entry.less` files we use**.
  Using a new component → add its style entry there, or it renders unstyled. Theme tweaks are Less variable overrides
  (`@blue-base`, `@component-background`, …) after the imports. Paths resolve via `stylePreprocessorOptions.includePaths`.
- Icons: add to `core/ui/icons.ts`. **Never** enable dynamic icon loading (`NzIconService` fetch / CDN): CSP
  `connect-src 'self'` blocks it and a third-party fetch would leak who uses the app.
- `NzMessageService` renders string content with `[innerHTML]`: only pass **constant strings** — never display names,
  room ids, or error text from browsers/servers. Show those via template interpolation (e.g. `nz-result` subtitle).
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
