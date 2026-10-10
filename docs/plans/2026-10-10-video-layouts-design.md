# Video layouts — design
Status: approved · Date: 2026-10-10

## Problem
Every call shows one auto-fit grid of equal tiles. There is no way to follow whoever is talking, make one person or
a screen share big, or get your own camera out of the way — and every visible tile receives the full-quality layer,
which spends Cloudflare's free-tier traffic on thumbnails.

## Goals / Non-goals
Goals (v1), each person for their own screen only:
- **Grid** (everyone the same size) and **Speaker** view (active speaker on the stage, thumbnail strip).
- **Pin** any tile — someone else, your own camera ("maximize my video"), a screen share — to the stage.
- **Floating self-view**: draggable bubble that snaps to corners, can collapse to a pill, or be hidden.
- **Screen share takes the stage** automatically while it lasts.
- Tiles receive the simulcast layer that matches their size.
- Smart defaults (phones: Speaker + Floating; desktop: Grid + In layout), remembered per browser.

Non-goals: host "spotlight for everyone" (needs a signed host statement — later), custom grid ordering, browser
picture-in-picture, multiple pins, server-side anything.

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | Untouched: same tracks and transforms; only where they are drawn changes. |
| $0 running cost | Improves it: small tiles receive `h` / `q` instead of `f`. |
| No public IP | Nothing new. |
| Self-hostable + open source | No new dependency (plain CSS/DOM, Pointer Events). |
| Untrusted server | Mild new metadata: the api/SFU already learns which cameras are on screen; with size-based layers it also learns which one you view **large** (pin / active speaker). A hint at attention, never content. Accepted for the bandwidth saving. |
| Browser support | Plain CSS, Pointer Events — fine on iOS Safari. |
| Signaling | None. Uses the existing `SelectVideoLayer`. |

## Chosen approach
**One stage container, tile roles and rects from a pure layout function.** Every tile stays in one `@for` keyed by
tile, absolutely positioned from a computed rect — elements never re-mount when the view, pin or speaker changes, so
video never flickers and moves can animate.
- Not separate containers per area (stage / strip / grid / bubble): tiles moving between them re-mount and re-attach
  video on every speaker change.
- Not CSS grid areas: one grid can't give a scrollable strip, a best-fit grid and a floating bubble together.

## Design

### User flow
- **View** group in the ⋯ menu: **Grid** / **Speaker**; **Self view**: *In layout* / *Floating* / *Hidden*.
- **Stage** (Speaker view) priority: 1) your pin, 2) a remote screen share (newest), 3) the active speaker (takes the
  stage after ~1.5 s of continuous speaking, keeps it through silence; you are never your own active speaker),
  4) the first remote participant, or you when alone.
- **Strip**: bottom on landscape/desktop, a row on portrait phones; as many thumbnails as fit, most recent speakers
  first, the rest behind a **"+N"** tile that switches to Grid.
- **Pin**: a pin button on every tile (hover on desktop; on touch, tapping a tile shows it for a few seconds).
  Pinning in Grid switches to Speaker; unpinning returns to the view you had. Pins are per call.
- **Floating self-view**: rounded bubble (~120 px wide on phones, ~200 px on desktop) over the stage/grid; drag it,
  it snaps to the nearest corner clear of the header, control bar, chat panel and safe areas. A button collapses it
  to a pill ("You" + mic state) and back. Camera off → initials.
- **Screen share**: a remote share takes the stage; Grid users switch to Speaker while it lasts, then return. A pin
  still wins. Your own share never takes your stage automatically (it would show the screen inside itself).
- **Remembered** (localStorage): view, self-view mode, bubble corner.

### Components and boundaries
- `features/room/layout/call-layout.ts` — pure `callLayout(input)` → per tile `{ role, rect }`, role ∈
  `stage | strip | grid | float | hidden`, plus the "+N" tile:
  - Grid: the column count that makes 16:9 tiles largest in the box; below ~160 px wide it stops shrinking and the
    grid scrolls vertically.
  - Speaker: stage = box minus strip; strip thumbnails as many as fit, ordered by last spoken.
  - Float: bubble or pill rect in the chosen corner, inside the box minus insets (header, controls, safe areas).
- `features/room/layout/stage-speaker.ts` — hysteresis over `MediaService`'s speaking set (1.5 s to take the stage;
  keeps the last speaker during silence); also tracks "last spoken" order for the strip.
- `core/settings/call-view.ts` — load/save view, self-view mode, corner (try/catch; phone/desktop defaults).
- `features/room/corner-drag.directive.ts` — Pointer Events drag; emits the nearest corner on release.
- `Room` — owns `view`, `selfView`, `corner`, `pin` signals; renders one `<section class="stage">` with every
  `app-call-tile` positioned by `transform` + `width/height` (200 ms transition, none under
  `prefers-reduced-motion`); box size from `ElementSizeDirective`.
- `CallTile` — pin button (`pinned` input, `pin` output), pill look for the collapsed self tile.
- `CallControls` — the View group in the ⋯ menu.
- `MediaService` — `receiveLayer(width × devicePixelRatio)`: ≥ 960 device px → `f`, ≥ 360 → `h`, else (or hidden)
  → `q`; still debounced. Screen shares unchanged. Nothing else changes; components never touch the peer connection.

### Data and state
Browser only: `view`, `selfView`, `corner` persisted in localStorage; `pin` and speaker history per call. The server
sees only the existing layer requests.

### Failure modes and edge cases
- Alone: own tile on the stage, no bubble.
- Cameras off: initials tiles; a speaker without video still takes the stage.
- Pinned tile disappears (leave, or rejoin with a new participant id): pin dropped.
- Resize / rotation / chat panel: layout recomputes; the bubble re-snaps inside the new box.
- Our rejoin: view, self-view and corner persist; the pin survives only if the tile still exists.
- Many people: Grid scrolls; Speaker shows what fits plus "+N" (hidden tiles at `q`).

## Protocol changes
None.

## Security notes
- New metadata: which camera a viewer receives at the full layer (pin / active speaker) is visible to the api and
  Cloudflare, alongside what was already visible (which cameras are on screen).
- No change to keys, transforms or what is encrypted. Names still only via interpolation.

## Testing
- Unit: `callLayout` (best-fit grid, speaker stage + strip, "+N", bubble corners clear of insets, priority pin >
  share > speaker > first, alone, own-share exclusion); `StageSpeaker` hysteresis and order; `receiveLayer`
  thresholds; `call-view` settings; corner-drag directive; `CallTile` pin; View menu; `Room` wiring.
- E2E (headless-shell, fake devices) at desktop and 375 px: switch views, pin/unpin, drag the bubble, a screen share
  taking the stage, `SelectVideoLayer` requests (thumbnails `q`, stage `f`).

## Open questions
- Host "spotlight for everyone" later: a signed `spotlight/v1` statement like mute/end.

## Implementation steps
1. `receiveLayer` by size (device px) + MediaService wiring and tests.
2. `call-view.ts` settings; `StageSpeaker` with tests.
3. `callLayout` pure function with tests.
4. Room stage container: rect-positioned tiles, Grid/Speaker, strip, "+N"; View menu in CallControls.
5. Pinning (CallTile button, Room state); screen share takes the stage.
6. Floating self-view: bubble, pill, hidden, corner-drag directive, persistence.
7. E2E check at desktop and phone sizes; docs (README, architecture, `media` and `angular-frontend` skills).
