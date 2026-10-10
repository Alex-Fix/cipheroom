# Source link and 320 px fix — design
Status: approved · Date: 2026-10-10

## Problem
- AGPL-3.0 §13: people using the app over a network must be offered the source of the version they use. The UI
  has no link to it.
- At 320 px the call control bar (six buttons incl. screen share) is 346 px wide and the page scrolls sideways.

## Goals / Non-goals
Goals: a Source link on the home page and in the call's ⋯ menu that opens the exact running commit, configurable for
forks; control bar fits 320 px. Non-goals: an About page, version display, other paper cuts.

## Constraints check
| Constraint | This change |
|---|---|
| E2EE / untrusted server | Nothing sent anywhere; a top-level link. |
| $0 / no public IP / open source | No new service or dependency. |
| Browser support | Plain links and CSS. |
| Signaling | None. |

## Chosen approach
nginx answers `/source` with a 302 to `SOURCE_URL` (+ `/tree/<SOURCE_COMMIT>`), both baked into the web image at
build time (the nginx config is filled in by the Node build stage — the final image runs as non-root and can't edit
it). `scripts/up.sh` passes `git rev-parse HEAD` when the working tree is clean; with uncommitted changes no commit
matches, so the link goes to the repository root.
- Not a runtime nginx template: up.sh always rebuilds, and a build-time value can't drift from the image.
- Not an API endpoint or app config: the app only links to `/source`.

## Design
- `deploy/.env` / `.env.example`: `SOURCE_URL` (default `https://github.com/Alex-Fix/cipheroom`); compose passes it
  and `SOURCE_COMMIT` as web build args. The Dockerfile refuses anything but a plain `https://` URL and a hex commit.
- nginx: `location = /source { return 302 <target>; }` (server-level security headers still apply).
- Home: footer "Free software under AGPL-3.0 · Source code". Call: ⋯ menu "Source code". Both `target="_blank"
  rel="noopener noreferrer"`.
- Control bar below 360 px: 44 px buttons, 6 px gaps (six buttons = 310 px; 44 px is Apple's minimum target).

## Security notes
No data leaves the browser except the navigation the user chose; `Referrer-Policy: no-referrer` already applies.

## Testing
Specs: home footer link, ⋯ menu item. Stack: `curl -I /source` → 302 to `…/tree/<sha>`; dirty tree → repository
root. Headless re-measure at 320 px.

## Implementation steps
1. Build args, nginx `/source`, up.sh commit, `.env.example`.
2. Home footer + ⋯ menu item.
3. Control bar at 320 px.
4. Docs (README, architecture, docker-deploy skill).
