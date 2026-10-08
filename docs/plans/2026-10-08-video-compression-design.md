# Video compression (AV1 / VP9) — design
Status: approved, revised after the spike (see "Revision") · Date: 2026-10-08

> **Superseded in part:** AV1 was removed afterwards — see `2026-10-08-remove-av1-design.md`. The AV1 spike notes
> below are kept in case it comes back.

## Revision (after the spike)

- **User picks the codec:** ⋯ menu "Video codec" — VP9 (default), AV1 (experimental), VP8; remembered per browser.
  The automatic rule still applies on top: a sender falls back (VP9, then VP8) when someone in the call can't
  decode its pick, and the menu says so.
- **Codec is chosen at join; changing it rejoins.** Cloudflare doesn't forward a codec change on a published track
  (spike item 4), so `encodings[].codec` switching and the hysteresis are gone. A codec change, or a newcomer who
  can't decode our codec, makes that sender rejoin (~1–2 s; same identity, so the safety code is unchanged).
- **No `powerEfficient` gate:** AV1 is an explicit opt-in; software AV1 at 4K is heavy (see spike).
- **`L1T3` always for VP9/AV1:** Chrome doesn't list scalability modes in `getCapabilities`; a browser that rejects
  the mode gets the layers without it.
- **AV1 ships "experimental":** frames are OBU-preserving encrypted and decode fine, but Cloudflare can't switch a
  viewer back up a simulcast layer (no Dependency Descriptor). Opus tuning, stats-based fallbacks and the Grafana
  panel (steps 7–8) are not part of this change.

## Problem

Calls send video as VP8 and audio as Opus with default settings. VP8 is the least efficient codec browsers offer:
the 4K full layer is capped at 8 Mbit/s, 1080p at 3 Mbit/s (`web/src/app/core/media/quality.ts`). That burns through
Cloudflare Realtime's shared 1,000 GB/month free tier and mobile data. We want the best quality for the fewest bytes.

Media is already codec-compressed and end-to-end encrypted. Ciphertext doesn't compress, and generic compression
before encryption gains almost nothing on codec output while leaking content through sizes. So "more compression"
means a more efficient codec plus tuned bitrates, not an extra compression layer.

## Goals / Non-goals

Goals
- Each sender uses the most efficient video codec every viewer in the room can decode: **AV1 > VP9 > VP8**.
- Per-codec bitrate caps that keep perceived quality while cutting bytes (~35% VP9, ~50% AV1 vs VP8).
- Opus DTX + in-band FEC + 32 kbit/s cap; screen share tuned for sharp text.
- E2EE unchanged in strength: every codec is frame-encrypted, nothing is ever sent raw.

Non-goals
- SVC (single-stream spatial layers) — Cloudflare doesn't document SVC forwarding; we keep simulcast.
- H.264 / H.265.
- A user-facing codec picker or data-saver mode.
- Support for browsers that can't decode VP9 (target is modern browsers; VP8 stays only as a safety baseline).

## Constraints check

| Constraint | This feature |
|---|---|
| E2EE invariant | Holds. Every codec is frame-encrypted; the codec id is authenticated in the frame trailer. No server needs plaintext. |
| $0 running cost | Improves it: fewer bytes against the 1 TB/mo Cloudflare free tier. No new services. |
| No public IP | Unchanged; media still browser ⇄ Cloudflare edge. |
| Self-hostable + open source | Browser-native codecs only; no SDKs. |
| Untrusted server | The api relays each participant's decodable codec list (unsigned). Tampering can only downgrade (more bytes) or break a viewer's video (DoS the server can already cause) — never decrypt. |
| Browser support | Modern browsers. AV1 decode depends on hardware on Safari (iPhone 15 Pro+, M3+); VP9 decodes everywhere modern; VP8 as baseline. AV1 encode only with a power-efficient (hardware) encoder. |
| Signaling | One change: `JoinRoom` gets `videoCodecs`, `ParticipantDto` carries it (→ `signaling-protocol` skill). |

## Chosen approach

**AV1-first with VP9 fallback, chosen per sender from the room's advertised decode capabilities**, all codecs
frame-encrypted with a codec-aware frame format (v2), plus per-codec bitrate caps and Opus tuning. Gated by a spike;
AV1 has a kill switch so the feature can ship as VP9 > VP8 if encrypted AV1 can't be packetized.

Why not the alternatives:
- *VP9 only + tuning:* simpler and no protocol change, but leaves ~15–20% more savings on the table (user chose AV1).
- *Data-saver toggle only:* trades quality for bytes instead of getting both.

## Design

### User flow
- Nothing new to do: calls use fewer bytes. The quality picker (Auto/4K/1080p/720p) stays.
- The call-details panel (behind the "Encrypted" badge) shows the codec we're currently sending.

### Codec choice (client-side, deterministic)
- Ranking AV1 > VP9 > VP8. A codec is eligible for a sender when:
  1. **every other participant shown in the call** advertises it in `videoCodecs`, and
  2. the sender can encode it: `MediaCapabilities.encodingInfo({ type: 'webrtc', … })` at the capture resolution —
     AV1 requires `powerEfficient: true`; VP9 needs `supported`.
- Each client computes this from the same participant list; no coordination, the server only relays capabilities.
  Senders in one room may use different codecs.
- **Join of a less capable participant:** senders downgrade within the existing rotation debounce (300 ms), hidden
  behind the newcomer's "Securing…" period.
- **Leave:** upgrade after ~5 s hysteresis (no flapping).
- **Switching:** all three codecs are negotiated on each video transceiver up front (`setCodecPreferences`, other
  codecs removed); switches use `sender.setParameters` with `encodings[i].codec` (no SDP round-trip). Where that's
  missing, renegotiate through `MediaService`'s queue.
- **AV1 kill switch** in client config; off → ranking VP9 > VP8.

### Decode capabilities
- New `codecCapabilities()` in `web/src/app/core/media/`: from `RTCRtpReceiver.getCapabilities('video')`,
  confirmed with `MediaCapabilities.decodingInfo({ type: 'webrtc' })` (drops AV1 on Safari without hardware decode).
  Always includes `vp8`.

### Frame encryption per codec (`web/src/app/core/crypto/`)

| Codec | Clear part | Status |
|---|---|---|
| VP8 | 10 B (keyframe) / 3 B (delta) | unchanged, proven |
| VP9 | 0 B — whole frame encrypted (payload descriptor is built from encoder metadata) | hypothesis, spike |
| AV1 | whole frame if Chrome/Firefox packetize it; else **OBU-preserving**: OBU headers + size fields clear, each OBU payload encrypted, size rewritten to include the tag | spike decides |

**Frame format v2** — trailer grows from 9 to 10 bytes:

```
[ clear header ][ AES-GCM ciphertext + 16 B tag ][ counter 8 B ][ codec 1 B ][ keyIndex 1 B ]
codec: 0 = audio, 1 = VP8, 2 = VP9, 3 = AV1
AAD  = clear header ‖ counter ‖ codec ‖ keyIndex
```

- Receiver reads the codec byte from the end *before* computing the clear-header length; no reliance on
  `getMetadata().mimeType` (inconsistent across browsers). Authenticated, so the SFU can't relabel a frame's codec.
- Sender takes the codec from frame metadata when present, else the codec `MediaService` last posted to the worker.
- Codec byte vs. actual payload type mismatch → drop. Unknown codecs → drop (never raw).
- `isSupportedCodec` adds `video/vp9` and `video/av1`.

### Bitrate and quality
- `bitrateFor(height, codec)` = VP8 table × factor: **VP8 1.0, VP9 0.65, AV1 0.5** (starting points; tuned from
  Grafana numbers). `updateBitrates()` re-applies on codec switch.
- Simulcast f/h/q stays; VP9/AV1 layers use `scalabilityMode: 'L1T3'` (temporal layers for the SFU).
- Screen share: `contentHint = 'detail'`, `degradationPreference = 'maintain-resolution'`.

### Audio (Opus)
- DTX: add `usedtx=1` to the SFU answer's Opus fmtp before `setRemoteDescription`.
- `useinbandfec=1`, `stereo=0`, sender `maxBitrate` 32 kbit/s via `setParameters`.

### Components and boundaries
- `MediaService`: codec choice, transceiver codec preferences, switching, bitrate factors, Opus fmtp, stats-based
  fallback. Components never touch codecs directly.
- `frame-codec.ts` / frame worker: v2 format and per-codec clear headers.
- Backend: `VideoCodecs` value object on `Participant`; `JoinRoomCommand` + validator; hub argument + DTO mapping. No
  SFU proxy changes (the api never parses SDP codecs).

### Data and state
- Capabilities are in-memory with the participant (same lifetime as the identity bundle); nothing persisted.

### Failure modes
- **Hardware encoder falls back to software** (`qualityLimitationReason = 'cpu'` > 10 s): this sender drops
  AV1 → VP9 locally.
- **Viewer receives but can't decode** (`framesReceived` grows, `framesDecoded` flat): request a keyframe; if it
  persists, tile shows "Can't play this video"; the call-quality report records the codec.
- **Someone can only decode VP8:** room works on VP8, without savings.
- **Spike fails for AV1:** kill switch off, VP9 > VP8.
- Reconnect / rejoin: capabilities re-sent with `JoinRoom`; codec choice recomputed.

## Protocol changes

| Dir | Message | Change |
|---|---|---|
| C→S | `JoinRoom` | new 4th argument `videoCodecs: string[]` |
| S→C | `JoinResult.participants[]`, `ParticipantJoined` | `ParticipantDto` gains `videoCodecs: string[]` |

- Validation: values in `{"vp8","vp9","av1"}`, distinct, 1–3 entries, must include `"vp8"`.
- New client error `Invalid video codecs.` (checked after `Invalid identity.`).
- Old clients without the argument fail SignalR binding and never join (same build is served to everyone).
- Update together: `IRoomClient` / hub (C#), `signaling.types.ts` + `SignalingService` (TS),
  `docs/signaling-protocol.md`.

## Security notes
- No key material involved; capabilities are public data.
- **Unsigned capabilities:** a malicious api can strip `av1`/`vp9` (downgrade → more bytes, no confidentiality loss)
  or add codecs a viewer can't decode (DoS, already possible by dropping tracks). Signing them into the identity
  bundle would change the signature format for no confidentiality gain.
- **Metadata:** the api learns each participant's decode capability (rough hardware class). The SFU sees codec,
  layer structure (VP9 payload descriptor / AV1 Dependency Descriptor) and frame sizes, comparable to VP8 today.
  DTX exposes speech/silence through packet timing — already visible via the RTP audio-level header.
- e2ee-media checklist: frame encryption attached before any frame flows (unchanged); unknown codecs dropped, never
  raw; codec id authenticated (AAD); per-codec parsing never trusts clear bytes beyond length bounds; AV1
  OBU-preserving variant (if used) gets a dedicated review; `?e2ee=passthrough` check per codec.

## Testing
- **Spike (go/no-go, not merged)**, throwaway page under `artifacts/` on the home stack via tunnel:
  1. Cloudflare forwards VP9 and AV1 simulcast by rid; layer switches work.
  2. VP9 whole-frame encrypted plays in Chrome, Firefox, Safari (macOS + iPhone).
  3. AV1 whole-frame encrypted packetizes in Chrome/Firefox; else the OBU-preserving variant does.
  4. `encodings[].codec` switches mid-call without renegotiation (Chrome, Safari, Firefox).
  5. Which browsers expose `getMetadata().mimeType` on encoded frames.
  6. Measured bytes/min VP8 vs VP9 vs AV1 at 720p/1080p, same scene → bitrate factors.
  Fail on 1 or 2 for VP9 → stop and rethink. Fail on 3 → ship with AV1 off.
- **Backend:** domain tests for `VideoCodecs`; `JoinRoomCommand` validator tests; hub functional tests that
  `JoinResult` / `ParticipantJoined` carry `videoCodecs` and bad input gets `Invalid video codecs.`
- **Frontend unit:** `frame-codec` round-trips per codec with v2 trailer, tamper cases (codec byte flipped,
  mismatch); codec choice (participants + local capabilities → codec, hysteresis); `bitrateFor` factors; Opus fmtp
  edit on a sample SDP answer.
- **Two-browser e2e** (Playwright, Chrome + WebKit): Chrome↔Chrome on AV1/VP9; WebKit joins → Chrome drops to VP9;
  WebKit leaves → upgrade; `?e2ee=passthrough` shows garbage per codec.

## Spike results (2026-10-08, Chrome ↔ Chrome, headless, local api → Cloudflare Realtime)

Harness: `artifacts/spikes/video-compression/` (`spike-codecs.mjs`, `spike.patch`, run logs; not in git).
Baseline VP8 through the same harness works (4K decoded, layer switching works).

| # | Question | Result |
|---|---|---|
| 1 | Cloudflare forwards VP9 simulcast | **Pass** — needs explicit `scalabilityMode: 'L1T3'` per encoding; without it Chrome silently sends VP9 as one SVC stream (`L3T3_KEY`) and rid-based layer selection stops working. Down- and up-switch work. |
| 1 | Cloudflare forwards AV1 simulcast | **Partial** — forwarded, down-switch (f → q) works, **up-switch never happens** (stayed on q for 45 s; VP8 recovers in ~20 s). |
| 2 | VP9, whole frame encrypted | **Pass** (Chrome; hardware decode). Firefox / Safari / iPhone not tested yet. |
| 3 | AV1, whole frame encrypted | **Fail** — bytes arrive, receiver assembles 0 frames (Chrome's AV1 depacketizer parses OBUs). |
| 3 | AV1, OBU-preserving | **Pass** for decode (20 fps, 0 failures) once the per-OBU IV index skips empty OBUs: the packetizer drops temporal delimiters. |
| 4 | `encodings[].codec` switching | **Fail** — Cloudflare's answer keeps all codecs and the sender switches encoders, but viewers receive nothing afterwards (not even after switching back). Codec changes need a new track → rejoin. |
| 5 | `getMetadata().mimeType` on encoded frames | Chrome: reported on send and receive. Others not tested. |
| 6 | Bytes per codec | Not measured: the synthetic camera isn't representative; needs a real-scene `.y4m` source. |

Why AV1 can't switch up (confirmed part): Chrome offers the AV1 **Dependency Descriptor** header extension when
publishing; **Cloudflare's answer drops it** (accepts only transport-cc, mid, rid, repaired-rid). Without DD the SFU
must read the AV1 payload to find switch points, which our encryption hides.
Unconfirmed: which payload bytes it needs. Leaving the first frame-header byte clear (variant A) didn't help; leaving
the sequence header clear (variant B) broke decoding in a run that coincided with the dev server stopping — inconclusive.

Also seen: software AV1 at 4K starves the CPU (sender's f layer at ~5 fps), supporting the `powerEfficient` gate.

## Open questions
- AV1 up-switch on Cloudflare with encrypted payloads (see Spike results): blocks AV1 simulcast.
- Spike items 2, 4, 5 on Firefox and Safari/iPhone; item 6 with a real-scene source.
- Final bitrate factors (from spike item 6 and Grafana).
- Whether Firefox supports `encodings[].codec`; if not, renegotiation path frequency is acceptable?

## Implementation steps
1. Spike under `artifacts/` (not merged); record results in this doc and adjust the plan.
2. Frame format v2: codec byte in trailer, per-codec clear headers (VP8, VP9; AV1 per spike), `isSupportedCodec`;
   unit tests.
3. Backend: `VideoCodecs` value object, `JoinRoom` argument, validator, `ParticipantDto`; domain/validator/hub tests.
4. Frontend protocol: `signaling.types.ts`, `SignalingService`, `codecCapabilities()`; `docs/signaling-protocol.md`.
5. `MediaService`: negotiate AV1/VP9/VP8, deterministic codec choice + hysteresis, switching via
   `encodings[].codec` (renegotiation fallback), AV1 kill switch; unit tests.
6. Bitrate factors per codec, `L1T3`, screen-share content hint / degradation preference.
7. Opus: DTX fmtp on the SFU answer, FEC, mono, 32 kbit/s cap.
8. Stats-based fallbacks (CPU-limited AV1 → VP9, undecodable video tile) + codec in call-quality reports and a
   Grafana "bytes per minute by codec" panel.
9. Two-browser e2e tests.
10. Docs: `architecture.md`, `observability.md`, `e2ee-media` and `media` skills (frame format v2, codec rules).
