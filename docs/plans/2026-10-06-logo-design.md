# Logo and favicon — design
Status: approved · Date: 2026-10-06

## Problem
The app ships Angular's default `favicon.ico`, and the home screen's "app icon" is a gradient square with a stock
camera glyph. Cipheroom has no identity of its own in tabs, bookmarks or on an iOS home screen.

## Goals / Non-goals
**Goals**
- An original "anonymous" mark: a faceless hooded figure whose face is a glowing camera lens.
- Favicon (SVG + ICO), iOS home-screen icon, and the in-app logo on the home screen.
- Everything free and open source: original artwork, open-source tooling, no SaaS.

**Non-goals**
- Web manifest / PWA icons (192/512), wordmark lockup, social preview image.
- Anything resembling the Guy Fawkes mask or "hacker" clichés (skulls, glitch, green-on-black).

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | No impact; static assets. |
| $0 running cost | No service; generator runs locally, outputs committed. |
| No public IP | No impact. |
| Self-hostable + open source | Artwork is original (hand-written SVG geometry). Generator: `@resvg/resvg-js` (MPL-2.0, dev-only). ICO writer is our own code. No SaaS icon generators, no fonts, no stock art. |
| Untrusted server | Served same-origin from `web/public/`; no third-party favicon fetch that could track users. |
| Browser support | SVG favicon (modern browsers) + ICO fallback (legacy) + PNG apple-touch-icon (iOS). |
| CSP | `img-src 'self'` already covers it; unchanged. |

## Chosen approach
Hand-written SVG master + a reproducible generator script (resvg) that renders PNG/ICO outputs, which are committed.

- *Why not `sharp`:* Apache-2.0 itself, but ships LGPL-3.0 libvips binaries; resvg is a dedicated, more accurate
  SVG renderer with a single MPL-2.0 dependency.
- *Why not rasterising via headless Chrome:* ties regeneration to a local Chrome install.
- *Why not SVG only:* iOS home-screen icons need PNG.

## Design

### The mark
- **Canvas** 1024×1024, iOS-style squircle tile (~22.5% continuous corners); the tile is part of the artwork.
- **Background:** linear gradient `#0B1026` → `#000000` with a faint radial vignette.
- **Hood:** one symmetric path — rounded peak, draping into shoulders that bleed off the bottom edge; fill `#1C2340`,
  lighter rim `#2A3258` along the top edge. No face features.
- **Face opening:** dark oval `#05070F` inside the hood.
- **Lens** (the only bright element), centred in the opening: outer ring gradient `#5AC8FA` → `#5E5CE6`, dark pupil,
  aperture ring, small white specular highlight top-left, soft outer glow.
- **Small variant** (≤ 48 px): no glow, aperture or rim — tile, hood, solid gradient lens dot — so it stays crisp.
- **Feel:** quiet, premium, "someone's there but you can't see who".

### Files
```
web/src/assets-src/          (not served)
  logo.svg                   full mark, 1024 master
  logo-small.svg             simplified mark for ≤ 48 px
web/public/                  (served; generated outputs committed)
  logo.svg                   full mark (in-app)
  favicon.svg                small mark
  favicon.ico                16/32/48, PNG-in-ICO
  apple-touch-icon.png       180×180, full mark
scripts/icons.sh             regenerates web/public/ icons from web/src/assets-src/
```

### Wiring
- `index.html`: `<link rel="icon" href="favicon.svg" type="image/svg+xml">`,
  `<link rel="icon" href="favicon.ico" sizes="any">`, `<link rel="apple-touch-icon" href="apple-touch-icon.png">`.
- Home: `.app-icon` becomes `<img src="logo.svg" alt="" width="72" height="72">` (decorative; the title names the
  app). Drop `VideoCameraFill` from `APP_ICONS`.
- `README.md`: logo at the top + licensing note.

## Protocol changes
None.

## Security notes
- SVGs contain only shapes, gradients and filters: no `<script>`, event handlers, `<foreignObject>`, external
  `href`s, `@import` or fonts. `scripts/icons.sh` fails if any appear.
- Same-origin assets only; no favicon service/CDN (which could log who opens the app).

## Licensing
- Logo artwork (`web/src/assets-src/logo*.svg` and generated icons in `web/public/`): **CC BY-SA 4.0**, © Cipheroom
  contributors. Code remains AGPL-3.0.
- Noted in `README.md` and in a `LICENSE-ASSETS.md` at the repo root listing the covered files.
- Tooling: `@resvg/resvg-js` MPL-2.0 (devDependency, not shipped to browsers).

## Testing
- Render previews at 16, 32, 180 and 1024 px on light and dark backgrounds; review visually and iterate until the hood
  reads at 16 px.
- `npm run build` (assets copied, budget unchanged), `scripts/test.sh --web`, `scripts/security-check.sh`.
- Check the tab icon and iOS "Add to Home Screen" on the rebuilt stack.

## Open questions
- None.

## Implementation steps
1. Draw `logo.svg` and `logo-small.svg`; iterate with rendered previews (16/32/180/1024, light/dark).
2. Add `@resvg/resvg-js` devDependency + `scripts/icons.sh` (render PNGs, write ICO, SVG safety check); generate and
   commit outputs; remove the old `favicon.ico`.
3. Wire `index.html` links; replace the home app-icon with `logo.svg`; drop `VideoCameraFill`.
4. `LICENSE-ASSETS.md` (CC BY-SA 4.0) + README logo and licensing note; update the `angular-frontend` skill
   (where icons live, how to regenerate).
