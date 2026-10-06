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
    room/        call grid, controls, participant tile
  shared/        presentational components, pipes
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
- No third-party UI kit until needed; keep bundle small.

## Commands
- Dev: `npm start --prefix web` (or `scripts/dev.sh`)
- Test: `npm test --prefix web -- --watch=false`
- Build: `npm run build --prefix web`

## Dockerfile
Multi-stage: `node:lts-alpine` build → `nginx:alpine` serving `dist/web/browser`, SPA fallback
(`try_files $uri /index.html`), proxy `/api` and `/hubs` (WebSocket upgrade headers) to `api:8080`.
Security headers: strict CSP (`script-src 'self'`, `worker-src 'self' blob:`, `connect-src 'self'` — LiveKit is same-origin under `/livekit/`), `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`.
