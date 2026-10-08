# Remove AV1 — design
Status: approved · Date: 2026-10-08

## Problem

AV1 shipped as an experimental video codec (PR #9, `2026-10-08-video-compression-design.md`). On Cloudflare Realtime
it can't switch a viewer back up to a sharper simulcast layer (Cloudflare drops the AV1 Dependency Descriptor and
our encrypted payload hides the keyframes), and it needs its own OBU-preserving frame encryption — extra crypto code
to maintain and review for a codec we can't recommend.

## Goals / Non-goals

Goals
- Remove AV1 everywhere: picker, decode/encode advertising, frame encryption, server-side allowed values, docs.
- Keep everything else from PR #9: VP9 default, VP8, the picker, fallback to a codec everyone decodes, rejoin on
  change, frame format v2, `L1T3` simulcast layers for VP9.

Non-goals
- Any change to VP8 / VP9 behaviour or bitrates.
- A compatibility shim for clients advertising `av1` (everyone loads the same build).

## Constraints check

| Constraint | This change |
|---|---|
| E2EE invariant | Unchanged; the VP8/VP9/Opus paths are untouched. Less crypto code. Codec byte 3 stays reserved and is rejected. |
| $0 running cost | Unchanged (VP9 remains the default). |
| No public IP | Unchanged. |
| Self-hostable + open source | Unchanged. |
| Untrusted server | Unchanged; one fewer value a server could inject into `videoCodecs`. |
| Browser support | Unchanged for VP8/VP9. Browsers that only had AV1 as a better option send VP9. |
| Signaling | No new methods; `videoCodecs` allows `vp8`, `vp9` only (protocol doc updated). |

## Chosen approach

Remove AV1 completely. Not chosen: hiding it from the picker only — keeps untested crypto and protocol paths around
as dormant code. Bringing AV1 back later is a git revert plus the spike notes in the earlier design doc.

## Design

### User flow
- ⋯ → Video codec offers **VP9** (default) and **VP8**. The picker shows only when the browser can send both.
- A stored `av1` choice (`cipheroom.videoCodec`) is ignored by `loadVideoCodec` → VP9. No migration.
- Fallback note and rejoin-on-change unchanged.

### Frontend
- `codecs.ts`: `VideoCodec = 'vp9' | 'vp8'`; `VIDEO_CODECS`, wire order and fallbacks without AV1; the module comment
  drops the AV1 notes. `simulcastScalabilityMode` returns `L1T3` for VP9 only.
- `quality.ts`: AV1 bitrate factor removed.
- `call-controls`: AV1 label / experimental naming removed.
- `codecPreferences`, `decodableCodecs`, `encodableCodecs` filter on our codecs, so AV1 capabilities are ignored.

### Crypto (`web/src/app/core/crypto/`)
- `frame-codec.ts`: OBU parsing/writing, leb128, per-OBU IVs and the AV1 branches removed; `FrameCodec` =
  `audio | vp8 | vp9`. Codec byte ids unchanged (0 audio, 1 VP8, 2 VP9); **3 is reserved** (was AV1, never reused)
  and, like any unknown byte, makes the frame undecodable. `video/AV1` from metadata → unsupported → dropped.
- Header comment and `e2ee-media` skill updated.

### Backend
- `VideoCodecs.Known` = `vp8`, `vp9`; `av1` → `Invalid video codecs.` Tests updated.

### Data and state
Nothing persisted server-side. Browser setting falls back as above.

### Failure modes
- An old tab advertising `av1` can't join (`Invalid video codecs.`) — reload fixes it, as with any protocol change.

## Protocol changes

- `JoinRoom.videoCodecs` / `ParticipantDto.videoCodecs`: values `vp8`, `vp9` (1–2, distinct, `vp8` required).

## Security notes
- Removes the OBU parser — the only place frame-crypto parsed attacker-influenced structure beyond the VP8 header.
- Codec byte 3 reserved: rejected as unknown; documented so it isn't reused for a different layout.
- e2ee-media checklist: unknown codecs still dropped, never sent raw; transforms attached before media flows
  (unchanged).

## Testing
- Backend: validator / domain reject `av1`; functional relay test uses `vp8,vp9`.
- Frontend: frame-codec — VP8/VP9/audio round trips, codec byte 3 rejected, `video/AV1` unsupported; codecs — lists
  and fallback without AV1; picker shows VP9/VP8; stored `av1` → VP9.
- Two-browser check through Cloudflare (VP9, VP8); then the user's test on the home stack.

## Open questions
None.

## Implementation steps
Branch `feat/remove-av1`:
1. Backend: `VideoCodecs` without AV1; tests.
2. Crypto: remove the AV1 frame path; reserve codec byte 3; tests.
3. Media and UI: codec type, lists, bitrate factor, picker labels; tests.
4. Docs: protocol, architecture, `media` / `e2ee-media` skills, note in `2026-10-08-video-compression-design.md`.
