---
name: media
description: Calls and media for Cipheroom on Cloudflare Realtime SFU — MediaService (one RTCPeerConnection, publish/subscribe, negotiation queue, simulcast and quality, mute, reconnect), the api's SFU proxy (ISfu / CloudflareSfuClient, hub methods), ICE/TURN, negotiation-order rules (iOS), free-tier usage, and connectivity debugging. Use for anything touching calls, media, the SFU, TURN or WebRTC behaviour.
---

# Media (Cloudflare Realtime SFU)

Design: `docs/plans/2026-10-07-cloudflare-sfu-design.md`. Protocol: `docs/signaling-protocol.md`. Architecture:
`docs/architecture.md` ("Components", "Media path").

## Boundaries
- **Frontend** `web/src/app/core/media/`: `MediaService` (provided per room route) owns the single
  `RTCPeerConnection` and exposes signals (`tiles`, `participants`, `state`, device flags, `cameras`,
  `videoQuality`, `availableQualities`, `canPlaybackAudio`, `diagnostics`). Components never touch the peer
  connection, tracks' senders or keys. Pure helpers next to it: `serial-queue`, `subscriptions`, `layers`,
  `quality`, `speaking`, `audio-playback`, `cameras`, `ice-path` — each with a spec.
- **Backend**: the api proxies every SFU call — clients never see the app secret, Cloudflare session ids or track
  names. Port `ISfu` (Application) ← `CloudflareSfu` adapter ← typed `CloudflareSfuClient` (Infrastructure). Room
  rules (one track per source, server-generated names, pulls only within the room) live in the `Room` aggregate.
- **Signaling**: everything goes over SignalR (`/hubs/room`) — there is no second signaling channel. Media itself
  flows browser ⇄ Cloudflare edge; the api never sees it.
- **E2EE**: `connect(config, self, frames)` takes `CryptoService`'s frame transforms; every sender gets them right
  after `addTransceiver`, every receiver in `ontrack` (and is retagged after each subscribe). Publishing without
  them throws. Remote tiles are `securing` until that participant's key arrived. See the `e2ee-media` skill.

## Flow
1. `CryptoService.identityBundle` → `JoinRoom` → `CryptoService.start` → `GetRtcConfig` (ICE servers) →
   `MediaService.connect(config, self, frames)`.
2. **Publish own tracks first** (room `publishOwnTracks`): microphone and camera via `PublishTracks(offer, [{mid,
   source}])`; devices that are off are still published (mic muted, camera as placeholder frames via
   `reserveCamera()`).
3. Then `startReceiving()`: subscriptions follow `SignalingService.participants` — `SubscribeTracks` → SFU offer →
   answer → `Renegotiate`. Tracks the SFU couldn't add yet are retried with backoff (1 s … 15 s).
4. `TracksPublished` / `TracksUnpublished` / `TrackMuted` / `ParticipantLeft` keep `participants` current.

## Rules (learned the hard way)
- **Negotiation order:** never publish a *new* transceiver after the connection started by answering the SFU's
  offer — iOS Safari fails to add a simulcast camera then. Publish first, receive second; device toggles after that
  are `replaceTrack` only.
- **One negotiation at a time:** every SFU/peer-connection mutation goes through `SerialQueue`. Roll back
  (`setLocalDescription({type:'rollback'})`) when a publish fails.
- **Never leave an SFU offer unanswered:** per-track errors in `tracks/new` (e.g. `empty_track_error`) don't fail the
  batch; the adapter returns what succeeded plus the offer. An unanswered offer makes the next negotiation fail with
  `406 invalid_session_description`.
- **Keep published tracks alive:** Cloudflare garbage-collects tracks after 30 s without packets. Muted mic =
  `track.enabled = false` (silence keeps flowing); camera/screen off = 1 fps black canvas placeholder.
- **SFU mutations aren't idempotent:** the SFU HTTP client never retries POST/PUT.
- **Codec:** all video (camera and screen) in VP8 — frame encryption keeps its fixed-size header clear, and
  simulcast works everywhere. H.264 was tried and reverted — it wasn't
  the cause of the iOS issue.

## Quality
- Send: user choice Auto (best the camera supports, up to 4K) / 4K / 1080p / 720p (`quality.ts`; 4K/1080p only when
  the camera can). f/h/q simulcast with bitrates by captured height; `setParameters` re-targets them after a
  resolution change.
- Receive: always the full layer for cameras on screen (subscriptions start at `f`, Cloudflare steps down on
  congestion); `q` for off-screen tiles (`ElementSizeDirective` → `setTileSize`) and hidden tabs.
- Speaking: `getStats` audio levels every 250 ms, 800 ms hold — client-side only.

## Recovery
ICE `disconnected` → restart after 2 s; `failed` → restart now (`RestartIce` with an ICE-restart offer; Cloudflare
keeps the session 30 s). After two failed restarts `state` = `disconnected` → the room rejoins (same devices), up to
3 times in a row, then shows "Connection lost." with Try Again. A dropped SignalR connection also triggers a rejoin.

## ICE / TURN
`GetRtcConfig` returns Cloudflare STUN/TURN (`CloudflareIceServerProvider`, short-lived credentials). Media normally
goes straight to Cloudflare's anycast edge; TURN (UDP/TCP/TLS 443) is the fallback for restrictive networks.
`Turn:ForceRelay` (`TURN_FORCE_RELAY=true`) forces relay to test that path. Nothing at home needs to be reachable.

## Cost (free tier)
SFU and TURN share 1,000 GB/month of egress (traffic *from* Cloudflare). A 4K camera ≈ 3.6 GB per viewer-hour,
1080p about a third. The usage guard is still to be built — keep the Cloudflare billing notification on.

## Debugging
- api log (`scripts/logs.sh api`): failed SFU calls are logged as `{HubMethod}: media server request failed` with
  Cloudflare's status and error code (never SDP).
- Browser: `[cipheroom] camera failed …` in the console has the real device / negotiation error (Safari: Web
  Inspector over USB for iPhones). `chrome://webrtc-internals` for ICE and codecs.
- Two-browser checks without devices: headless Chrome (`--use-fake-device-for-media-stream`) or Playwright WebKit
  with a canvas `getUserMedia` stand-in, against `https://<PUBLIC_HOST>` (keep such scripts under `artifacts/`).
- getUserMedia needs a secure context: localhost is fine; LAN devices need `scripts/certs.sh`.
