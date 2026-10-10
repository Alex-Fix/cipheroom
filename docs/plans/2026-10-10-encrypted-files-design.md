# Encrypted files and images in chat — design
Status: implemented · Date: 2026-10-10

## Problem
Chat (#15) carries text, emoji and links only. People want to drop a screenshot, a photo or a PDF into a call.
The api has no storage by decision (no DB, amnesiac server), the hub caps messages at 64 KB, and every byte through
the api costs home uplink and tunnel bandwidth. Files must keep the invariant: no server sees content.

## Goals / Non-goals
Goals (v1):
- Send images and any file, up to **100 MB each**, up to 10 per send, in the in-call chat.
- Transport over **WebRTC data channels through Cloudflare Realtime SFU** — bytes never touch the api or tunnel.
- End-to-end encrypted with a per-file key carried only inside the signed, encrypted chat event.
- **On demand**, with images ≤ 5 MB auto-downloaded so they appear inline; everything else on click.
- Images (JPEG/PNG/WebP) stripped of metadata (GPS, camera, time) without re-encoding; Orientation kept.
- Nothing stored anywhere: a file lives in the sender's tab and in recipients' memory, gone when they leave.

Non-goals: server-side storage or relay through the api; files for newcomers (they don't see earlier cards, like
chat text); availability after the sender leaves or reloads; peer-to-peer data channels (would expose IPs); inline
rendering of anything but decoded raster images (no SVG/HTML/PDF/video players); re-encoding or resizing images;
file-size padding; lobby files; HEIC/GIF metadata stripping.

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | Random AES-GCM-256 key per file, inside the signed, chat-encrypted card. Chunks encrypted in the browser; Cloudflare relays ciphertext only. |
| $0 running cost | Delivered bytes count against the 1 TB/mo free tier (100 MB × 5 recipients ≈ 0.5 GB). Usage guard counts data-channel bytes and restricts files at Saving / blocks them at AudioOnly and Paused. |
| No public IP | Same path as media: browser ⇄ Cloudflare edge. |
| Self-hostable + open source | No new dependency (stripper, thumbnails, transfer engine are ours). |
| Untrusted server | New metadata: who opened a channel, who subscribed to whose channel, when; Cloudflare also sees bytes per channel (≈ file size). Not name, type or content. A lying api pairing wrong channels fails AEAD + hash. Server can't check file size → channel lifetime and count limits bound quota abuse. |
| Browser support | Data channels exist in every supported browser. Our peer connection has no `m=application` yet — a bootstrap data channel must be created before the first offer (iOS negotiation order still applies: own tracks first). |
| Signaling | New C→S hub methods `OpenDataTransport`, `PublishDataChannel`, `SubscribeDataChannel`, `CloseDataChannel` (no new S→C events). Transfer coordination rides inside opaque `SendChat` blobs. |

## Chosen approach
**One randomly named SFU data channel per (batched) transfer.** Requests for a file are gathered for 1 s, the
sender opens a fresh channel, every requester subscribes, the sender streams once and the SFU fans it out; then the
channel closes. Auto-loaded images cost the sender one upload for the whole room.
- Not a long-lived channel per participant: concurrent downloads of different files reach every subscriber (wasted
  quota), and channels stay open all call.
- Not peer-to-peer data channels: peers learn each other's IPs, TURN fallback is still metered, new P2P signaling.
- Not encrypted blobs held by the api: the user chose WebRTC; also home uplink × recipients and disk/RAM on the api.

## Design

### User flow
**Sending**
- 📎 button in the composer, plus drag-and-drop and paste onto the chat drawer. ≤ 10 files per send, ≤ 100 MB each
  ("Too large — 100 MB max" otherwise). Images get a preview row before sending.
- JPEG/PNG/WebP are stripped of metadata before sending (see Crypto and files); HEIC shows "metadata not removed".
- Own message appears at once as a card: thumbnail or icon, name, size, "Shared from your browser — stay in the call
  so others can get it". One upload at a time per sender; others queue (FIFO).

**Receiving**
- Card appears instantly: name, size, type, blurred thumbnail for images.
- Images ≤ 5 MB download automatically (batched with everyone else); the image replaces the thumbnail. Click →
  lightbox with Save.
- Everything else (and larger images): **Download** with progress and Cancel; on completion the browser saves the
  file (`<a download>` from a blob URL) with the cleaned name. Non-images are never opened or rendered.
- Sender gone: "No longer available — {name} left the call". Guard paused: "File sharing is paused to stay within the
  free tier". ≤ 3 concurrent downloads per recipient.

### Components and boundaries
Browser:
- `core/crypto/file-crypto.ts` — pure: file key, chunk seal/open, AAD, SHA-256 helpers.
- `core/files/image-metadata.ts` — pure stripper: JPEG segments (drop APPn except a minimal EXIF holding only
  Orientation, drop COM), PNG chunks (drop eXIf/tEXt/iTXt/zTXt/tIME), WebP RIFF (drop EXIF/XMP, fix VP8X flags).
- `core/files/thumbnail.ts` — canvas → ~64 px JPEG ≤ 6 KB (re-encoded, so no metadata).
- `core/files/file-transfer.service.ts` (room-scoped) — offers being served (`File` refs, read lazily per chunk),
  request batching, chunk pump with back-pressure, receive assembly, missing ranges, progress signals, cancel,
  download concurrency, 500 MB completed-file memory cap (oldest evicted back to "Download again").
- `MediaService` — small data-channel API: `publishChannel(name)`, `subscribeChannel(participantId, name)`,
  `closeChannel(channel, name, participantId?)`. On first use it sets up the data transport by answering an SFU offer
  (`OpenDataTransport` → `Renegotiate`, like a subscribe — so no new local offer after receiving started) (the SFU
  opens its `server-events` channel in-band; we never create it — it would collide); a rejoin starts over. Components never touch the peer connection.
- `ChatService` — new event kinds inside the existing opaque chat events (relay unchanged): `file` (card),
  `file-request`, `file-channel`, `file-ready`, `file-missing`, `file-gone`.
- `features/room/chat-panel/` — attach button + drop zone; new `file-card/` and `image-lightbox/` components.

Backend:
- `ISfu.EstablishDataTransportAsync`, `PublishDataChannelAsync`, `SubscribeDataChannelAsync`,
  `CloseDataChannelsAsync`; `CloudflareSfu` calls `/datachannels/establish` (pulling `server-events`, "ask for an
  offer"), `/datachannels/new` and `/datachannels/close`. SFU channel names are `{participantId}-{name}`, so nobody
  can publish into someone else's channel.
- `Application/Files/`: `OpenDataTransport`, `PublishDataChannel`, `SubscribeDataChannel`, `CloseDataChannel`,
  `CloseExpiredDataChannels` commands + validators; `FileRules` (name format, lifetime, guard); limits in `Room`.
- Room store tracks open channels per participant (publish + subscriptions); closed on leave. `DataChannelExpiry`
  (every 30 s, `TimeProvider`) closes any channel **5 minutes** after opening.
- Counter `cipheroom.files.data_channels{action=published|subscribed|expired}` (no names or ids).

### Crypto and files
```
fileId   = 16 random bytes
fileKey  = 32 random bytes → AES-GCM-256 (raw bytes only to build the card; imported non-extractable)
card     = { v:1, seq, type:"file", id, name, size, mime, sha256, key, thumb? }   — chat-signed + chat-encrypted
total    = ceil(size / 16 KiB); chunk i = 16 KiB of plaintext (last shorter)
aad      = fields("cipheroom/file-chunk/v1", roomId, fileId, uint32 i, uint32 total)
frame    = version 1 B ‖ uint32 i ‖ iv 12 B (random) ‖ AES-GCM(fileKey, iv, aad, chunk)
```
- Random IVs (not counters): resent chunks are re-read from disk; if the file changed, counter IVs would reuse a
  nonce on different data.
- Recipient: AEAD per chunk, `total` from the signed size (truncation/extension impossible), then SHA-256 of the
  whole file vs the card; mismatch → discard, "File changed or corrupted".
- Card validation: size 1 B–100 MB (bigger → card dropped), name cleaned like chat text + path separators removed,
  ≤ 255 code points; mime is a hint only. Inline rendering needs an image mime **and** a successful decode; SVG is
  always a download card.
- Key lifetime: per file, unrelated to call key rotation; newcomers never receive earlier cards (chat key rotation),
  so never their keys. Keys dropped when the room is left.

### Transfer flow
1. Recipient sends `file-request(fileId)`.
2. Sender gathers requests for 1 s → `PublishDataChannel(name = 22 random base64url chars)` → `file-channel(fileId,
   name, requesterIds)`.
3. Requesters `SubscribeDataChannel(senderId, name)` → `file-ready`.
4. Sender streams when all are ready (or after 3 s, skipping the rest); pauses above 1 MiB `bufferedAmount`, resumes
   at 256 KiB (`bufferedamountlow`).
5. No progress for 5 s → `file-missing(fileId, ranges)`, served in the next batch; 3 failed rounds → Retry.
6. Requests arriving mid-stream wait for the next batch. Channel closed by the sender after the last chunk, by
   subscribers on completion, and by the api after 5 minutes regardless.

### Usage guard
- Browser reports add `fileBytes` from `data-channel` stats (`bytesReceived`) to the estimate, with its own per-report
  cap (200 Mbps) instead of `MaxReportMbps`. Cloudflare's figure stays authoritative when fresh.
- Normal: everything. Saving: no auto-download. AudioOnly / Paused: `PublishDataChannel` / `SubscribeDataChannel`
  refused, cards say paused.
  A transfer in flight when the level rises finishes.

### Data and state
Sender: `File` references in tab memory (not copied). Recipients: partial chunks and completed blobs in memory.
api: open channel names per participant in the in-memory room store. Nothing on disk; everything gone on leave,
reload or restart.

### Failure modes
| Case | Behaviour |
|---|---|
| Sender leaves / closes tab | Cards "No longer available"; in-flight downloads fail. |
| Sender reloads (auto-rejoin) | `File` refs lost → old cards unavailable; sender sees "Shared files were lost on reload". |
| Sender phone backgrounded | Stall → missing-ranges retries → Retry. |
| Recipient reconnects | Partial data kept; re-requests only missing ranges. |
| api restart | Channels gone; Retry. |
| Slow sender (> 5 min) | api closes the channel; remainder fetched via missing ranges on a new channel. |
| No `m=application` negotiated | 📎 hidden with a tooltip. |

## Protocol changes
| Direction | Method | Args | Returns | Notes |
|---|---|---|---|---|
| C→S | `OpenDataTransport` | — | `{ offerSdp, serverEventsChannelId }` | Once per media session, before the first channel; answer with `Renegotiate` |
| C→S | `PublishDataChannel` | `name` | `{ channelId }` | Admitted; name 22-char base64url; ≤ 4 published per participant; guard < AudioOnly; closed by the api after 5 min |
| C→S | `SubscribeDataChannel` | `participantId, name` | `{ channelId }` | Publisher in the caller's room and has published `name`; ≤ 8 received per participant; guard < AudioOnly |
| C→S | `CloseDataChannel` | `name, participantId?` | — | Own channel (`participantId` null, also drops everyone's subscriptions) or own subscription |

Server maps `participantId` → SFU session; clients never see session ids. Errors: `Invalid data channel.`,
`Too many data channels.`, `File sharing is paused.`, `Open the data transport first.`, `Data transport already
open.`, plus existing `Not admitted.` / `Join a room first.`. Chat event kinds are inside `SendChat` blobs and
invisible to the server (documented in the chat section of `docs/signaling-protocol.md`).

## Spike results (step 1, 2026-10-10, home dev stack, headless Chromium)
- Transport via `/datachannels/establish` "ask for an offer" works on our existing peer connection (after publish).
- 16 KiB messages: 10 MiB to one and to two subscribers (fan-out), and 100 MiB to one — every message, in order.
- Throughput ≈ 6–8 Mbps (100 MiB in 128 s): inside the 5-minute channel lifetime.
- 64 KiB messages stall although the SDP advertises `maxMessageSize` 65536 — chunks stay at 16 KiB.

## Security notes
- No key material outside the encrypted card; no file names, ids or channel names in logs, metrics or reports.
- Metadata: api sees channel open/subscribe graph and timing; Cloudflare also sees bytes per channel (≈ file size,
  accepted — padding would cost quota). Chat size buckets hide card details.
- Malicious server can drop, delay or misroute transfers (denial of service), not alter or forge them (AEAD + signed
  hash). Malicious insider can't push > 100 MB or a different file under someone's card.
- Quota abuse by a modified client is bounded by 4 channels × 5 minutes and the usage guard — comparable to 4K video.
- Rendering: only decoded raster images inline, never SVG/HTML; downloads use cleaned names; blob URLs revoked on
  eviction/leave. CSP needs `blob:` in `img-src` (check nginx headers).
- Metadata stripping protects against accidental location leaks for JPEG/PNG/WebP only.
- e2ee checklist: new label `cipheroom/file-chunk/v1`; keys non-extractable after import; no plaintext fallback (no
  chat key → no card → no file); signatures checked before a card is used.

## Testing
- Backend: validator/handler unit tests; functional tests — subscribe same room only, unknown name rejected, limits,
  guard level, close on leave, 5-minute expiry (fake `TimeProvider`); `CloudflareSfu` request shapes (stubbed HTTP).
- Frontend: `file-crypto` round trip, tamper, reorder, truncation (`total`), wrong room/file; stripper on fixture
  JPEG/PNG/WebP (GPS gone, Orientation kept, image data byte-identical); thumbnail size; `FileTransferService`
  batching, back-pressure, missing ranges, cancel, eviction with a fake channel; card validation; components.
- Manual: two browsers + a phone on the home stack (`scripts/up.sh --tunnel`), 100 MB file, sender leaving mid-way.
  No real devices in automated tests.

## Open questions
- Fan-out behaviour with one slow subscriber (does the SFU hold back the others?) — check on a phone on mobile data.
- Whether Cloudflare's usage analytics report data-channel egress in the same dataset as media.

## Implementation steps
Branch `feat/encrypted-files`, one commit each:
1. Spike: bootstrap data channel in `MediaService`, `ISfu` data-channel calls, check fan-out and 16 KiB messages
   on the home stack.
2. Backend: `FileRules`, three commands + validators, room-store tracking, 5-minute expiry, metrics, unit +
   functional tests.
3. Protocol: TS types + `SignalingService`, `docs/signaling-protocol.md`.
4. `file-crypto.ts` + tests.
5. `image-metadata.ts` + `thumbnail.ts` + fixture tests.
6. `FileTransferService` + `MediaService` data-channel API + `ChatService` event kinds + tests.
7. UI: attach/drop/paste, `file-card`, `image-lightbox`, progress, states.
8. Usage guard: `fileBytes` in call reports, estimate cap, level behaviour.
9. Docs: README (feature + roadmap), architecture, `e2ee-media` / `media` / `angular-frontend` skills; CSP check.
