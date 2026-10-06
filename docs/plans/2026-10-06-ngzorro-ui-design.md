# ng-zorro UI overhaul — design
Status: approved · Date: 2026-10-06

## Problem
The web UI is hand-rolled from the connectivity spike: plain buttons, text-only controls, diagnostics panel open by
default, uncaught device errors, no clear connection or encryption status. It looks unfinished and is awkward to use.

## Goals / Non-goals
**Goals**
- Move home and call screens to **ng-zorro-antd** with a **dark-only** theme.
- Better call UX: icon control bar with tooltips, compact header (state, E2EE status, participant count), tile
  overlays (avatar, name pill, mic-off, speaking ring, screen tag), diagnostics in a drawer, toasts for feedback.
- Visible handling of failures (join error + retry, device permission denied, reconnecting, autoplay blocked).
- Responsive, desktop-first: usable on a phone, no mobile-only gestures.

**Non-goals**
- New features: pre-join lobby / device preview, device pickers, chat, active-speaker layout, light theme.
- Any change to signaling protocol, backend, LiveKit config or crypto.

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | No impact; no server sees anything new. |
| $0 running cost | ng-zorro is MIT, client-side only. |
| No public IP | No impact. |
| Self-hostable + open source | MIT library, bundled; no SaaS. |
| Untrusted server | No new metadata. Display names still rendered via interpolation only (no `innerHTML`). |
| Browser support | ng-zorro 22 supports evergreen browsers incl. mobile Safari. |
| Two signaling channels | Neither touched. |
| CSP (`deploy/nginx/default.conf`) | `style-src 'unsafe-inline'` already allowed. `connect-src 'self'` blocks dynamic icon loading → icons **must be registered statically**. No web fonts / CDN. CSP unchanged. |
| `angular-frontend` skill: "No third-party UI kit until needed" | Explicitly reversed by this design; skill updated. Bundle budget (500 kB warn / 1 MB error) kept. |

## Chosen approach
**Per-component LESS + dark theme + static icons.** `styles.less` imports ng-zorro's dark theme variables and only
the `style/entry.less` of components we use; icons registered via `provideNzIcons` with an explicit list.

- *Why not prebuilt `ng-zorro-antd.dark.min.css`:* ships CSS for ~70 components, likely trips the budget, and theming
  becomes CSS overrides.

## Design

### User flow
**Home (`/`)** — centred `nz-card` (~400 px): wordmark, tagline, "End-to-end encrypted · self-hosted" with lock icon.
`nz-form`:
- *Name* — `nz-input`, user-icon prefix, remembered in `localStorage` as today.
- *Room* — `nz-input` with a regenerate-ID suffix button; inline validation message for the `[a-z0-9-]{3,64}` pattern.
- Full-width primary **Join**. `?room=` prefill unchanged.

**Call (`/r/:roomId`)** — header / stage / control bar:
- **Header:** room id + copy button (`nz-message` "Link copied"); connection `nz-badge` (green connected, orange
  reconnecting, red disconnected + *Rejoin*); E2EE `nz-tag` — orange "Not encrypted yet" until E2EE lands (later green
  "Encrypted" / safety-code entry point); participant count.
- **Stage:** auto-fit tile grid (as today). Tile: rounded, name pill bottom-left with mic-off icon, accent ring when
  speaking, `nz-avatar` with initials + name-derived colour when no video, "Screen" tag on screen-share tiles.
- **Control bar:** round icon buttons with `nz-tooltip` — mic, camera, screen share, "more" dropdown (Diagnostics),
  red **Leave** set apart. Off state = slashed icon on red/neutral background.
- **Diagnostics:** right-side `nz-drawer`, closed by default.
- **Phone width:** header collapses to room id + badges; control bar stays one row ("more" absorbs overflow); one
  tile column.

### Components and boundaries
- `app.config.ts`: `provideNzIcons(APP_ICONS)` (~15 icons: audio, audio-muted, video-camera, video-camera stop/slash,
  desktop, more, logout/phone, copy, lock, unlock, user, reload, setting, info), `provideNzConfig` (message
  duration/top), `provideAnimationsAsync()`, `NZ_I18N` → `en_US`.
- `src/styles.scss` → `src/styles.less`: dark theme vars, per-component entries, overrides (`@primary-color: #4f8cff`,
  radius, system font stack), a few app tokens as CSS custom properties. Component styles stay SCSS.
- `features/home/home.ts` (+ `home.html`): ng-zorro form; logic unchanged.
- `features/room/room.ts`: thin container — join/leave lifecycle, error state, `retry()`, catches errors from
  `setMicrophone/setCamera/setScreenShare` and shows toasts. **Only component that injects `LiveKitService`.**
- New presentational components in `features/room/` (inputs/outputs only, no service injection):
  `call-header`, `call-tile`, `call-controls`, `diagnostics-drawer`.
- `shared/avatar-color.ts`: pure name → palette colour.
- `livekit.service.ts`, `signaling.service.ts`: unchanged.

### Failure modes
- **Join fails:** error panel (`nz-result` style) with *Retry* (cleanup → join + connect again) and *Back to home*.
- **Device permission denied / no device:** toggle stays off; error toast with a hint to allow it in site settings.
- **Reconnecting / disconnected:** badge reflects `livekit.state()`; *Rejoin* in disconnected state. LiveKit
  reconnect logic untouched.
- **Autoplay blocked:** persistent `nz-alert` with "Enable audio" action.
- **Clipboard API unavailable** (insecure context): popover with the link pre-selected for manual copy.

## Protocol changes
None.

## Security notes
- No new network requests or origins: icons bundled, no web fonts, CSP unchanged.
- Never enable ng-zorro dynamic icon loading (`NzIconService` fetch / CDN) — would also leak app usage to a third party.
- User-controlled strings (display names, room id) only via Angular interpolation; no `innerHTML`, no HTML-string
  tooltip titles.
- Found during implementation: `NzMessageService` renders string content via `[innerHTML]` (Angular-sanitised, but
  markup still renders). Toasts use constant strings only (`device-error.ts`); join errors go to the `nz-result`
  subtitle via interpolation.
- The E2EE tag must reflect real state; it must never show "Encrypted" unless E2EE is actually active.

## Testing
Vitest (Angular default runner):
- `avatar-color`: deterministic, within palette.
- `call-controls`: icons/tooltips/off states per input; emits correct events.
- `call-tile`: avatar without video, mic-off icon, speaking class, screen tag.
- `home`: validation message on bad room id; Join stores name and navigates.
- `room`: device error → toast (mocked `LiveKitService`); Retry re-connects.

Manual: two browsers + phone on LAN (`scripts/certs.sh`); 375 px / 768 px / desktop; drawer, toasts, reconnect badge
(stop the API). `scripts/test.sh --web`, `scripts/lint.sh`, `npm run build` within budget.

## Open questions
- ~~LESS entry paths~~ — resolved: `includePaths: ["node_modules"]` + `ng-zorro-antd/<c>/style/entry.less`
  (package `exports` map breaks bare-specifier resolution for some components).
- Initial bundle is 625 kB raw / 127 kB transfer (was 462 kB before ng-zorro components): over the 500 kB *warning*,
  under the 1 MB error. ng-zorro core + icon service land in `main` because providers are in `app.config.ts`.
  Options: accept and raise the warning to 700 kB, or move ng-zorro providers into a lazy parent route. Undecided.

## Implementation steps
1. Add `ng-zorro-antd`, `less`; switch to `styles.less` with dark theme + per-component imports; providers in
   `app.config.ts` (icons, config, animations, i18n). App builds and looks the same-ish.
2. Home screen on ng-zorro (card, form, validation, regenerate id) + tests.
3. `avatar-color` + `call-tile` component + tests; use in room grid.
4. `call-controls` component (icon buttons, tooltips, more-dropdown, leave) + tests; device errors → toasts in `Room`.
5. `call-header` (copy + toast, state badge, E2EE tag, count, clipboard fallback).
6. `diagnostics-drawer`; remove inline diagnostics panel.
7. Join error panel with Retry, autoplay `nz-alert`, disconnected *Rejoin*; `room` tests.
8. Responsive pass (375 / 768 / desktop); budget check.
9. Docs: update `angular-frontend` skill (UI kit rules, static icons), one line in `docs/architecture.md`.
