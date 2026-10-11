---
name: media
description: Calls and media for Cipheroom on Cloudflare Realtime SFU — MediaService (one RTCPeerConnection, publish/subscribe, negotiation queue, simulcast and quality, mute, reconnect), the api's SFU proxy (ISfu / CloudflareSfuClient, hub methods), ICE/TURN, negotiation-order rules (iOS), free-tier usage, and connectivity debugging. Use for anything touching calls, media, the SFU, TURN or WebRTC behaviour.
---

# Media (Cloudflare Realtime SFU)

Design: `docs/plans/2026-10-07-cloudflare-sfu-design.md`. Protocol: `docs/signaling-protocol.md`. Architecture:
`docs/architecture.md` ("Components", "Media path").

## Boundaries
- **Provider seam** (docs/plans/2026-10-11-livekit-media-mode-design.md): `MediaService` is provider-neutral; the
  connection belongs to a `MediaTransport` (`media-transport.ts`) chosen by `RtcConfig.provider` —
  `CloudflareTransport` (`cloudflare-transport.ts`: the single peer connection, negotiation queue, subscriptions,
  layers, ICE restart, data channels). The api side: `ISfu` (Cloudflare negotiation) + `IMediaRoom` (remove
  participant / end room, `Provider`). Everything below describes the Cloudflare transport.
- **Frontend** `web/src/app/core/media/`: `MediaService` (provided per room route) owns the call (through its
  transport) and exposes signals (`tiles`, `participants`, `state`, device flags, `cameras`,
  `videoQuality`, `availableQualities`, `canPlaybackAudio`, `connection`, `poorConnection`). Components never touch the peer
  connection, tracks' senders or keys. Pure helpers next to it: `serial-queue`, `subscriptions`, `layers`,
  `quality`, `speaking`, `audio-playback`, `cameras`, `ice-path`, `connection-health` — each with a spec.
- **Backend**: the api proxies every SFU call — clients never see the app secret, Cloudflare session ids or track
  names. Port `ISfu` (Application) ← `CloudflareSfu` adapter ← typed `CloudflareSfuClient` (Infrastructure). Room
  rules (one track per source, server-generated names, pulls only within the room) live in the `Room` aggregate.
- **Signaling**: everything goes over SignalR (`/hubs/room`) — there is no second signaling channel. Media itself
  flows browser ⇄ Cloudflare edge; the api never sees it.
- **E2EE**: `connect(config, self, frames)` takes `CryptoService`'s frame transforms; every sender gets them right
  after `addTransceiver`, every receiver in `ontrack` (and is retagged after each subscribe). Publishing without
  them throws. Remote tiles are `securing` until that participant's key arrived. See the `e2ee-media` skill.

## Flow
1. `LobbyService.enter` (`CryptoService.identityBundle` → `JoinLobby`, waits for admission) → `CryptoService.start` → `GetRtcConfig` (ICE servers) →
   `MediaService.connect(config, self, frames)`.
2. **Publish own tracks first** (`MediaService.publishOwnTracks`): microphone and camera in **one** negotiation —
   one offer, one `PublishTracks(offer, [{mid, source}, …])`; devices that are off are still published (mic muted,
   camera as placeholder frames). Capture failures come back per device; a failed negotiation fails the join.
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
- **A refused answer wedges the session:** if answering an SFU offer fails (`MediaService.answerOffer`), Cloudflare
  keeps waiting and refuses everything after it. Don't retry on that session: `state` → `disconnected`, the room
  rejoins with a new one. A failed *publish* (our own offer) is rolled back and doesn't need that.
- **Keep published tracks alive:** Cloudflare garbage-collects tracks after 30 s without packets. Muted mic =
  `track.enabled = false` (silence keeps flowing); camera/screen off = 1 fps black canvas placeholder.
- **SFU mutations aren't idempotent:** the SFU HTTP client never retries POST/PUT.
- **Codec:** chosen per sender at join (`codecs.ts`): the user's pick (VP9 default, or VP8) if everyone in the call
  can decode it, else VP8. Each video transceiver lists that codec **first, then our other codecs** (VP9/VP8):
  Cloudflare offers a subscriber only the codecs its session advertised when publishing, so listing just the sending
  codec made anyone sending VP8 unable to receive VP9 and vice versa ("subscriber's SDP is missing the published
  track's codec"; docs/plans/2026-10-11-call-reliability-design.md). Cloudflare keeps our order, so we still send the
  first. H.264/AV1 stay out (unknown to the frame layout). Cloudflare does **not** forward a
  codec change on a published track (`encodings[].codec` switches the encoder but viewers get nothing), so a
  different codec = rejoin. VP9 needs `scalabilityMode: 'L1T3'` on every simulcast layer — without it Chrome sends
  VP9 as SVC (`L3T3_KEY`) and rid-based layer selection breaks; Chrome doesn't list scalability modes in
  `getCapabilities`, so don't gate on it. AV1 was removed (docs/plans/2026-10-08-remove-av1-design.md): on
  Cloudflare it can't switch back up a layer (the SFU drops the Dependency Descriptor; our encrypted payload hides
  the keyframes). H.264 was tried and reverted — it wasn't the cause of the iOS issue.

## Quality
- Send: user choice 4K / 1080p (default) / 720p (`quality.ts`; a camera that can't do the choice sends its best below
  it, and the picker ticks that; 4K/1080p offered only when the camera can). f/h/q simulcast with bitrates by captured height × a codec factor (VP9 0.65 of VP8's);
  `setParameters` re-targets them after a resolution change.
- Receive: the layer that matches each camera tile's rendered width in device pixels (`layers.ts`): ≥ 960 → `f`,
  ≥ 360 → `h`, smaller / off screen / hidden tile / background tab → `q` (`ElementSizeDirective` → `setTileSize`,
  debounced). Subscriptions start at `f`; Cloudflare steps down on congestion and serves what the sender has (a
  low-resolution camera that sends fewer layers still shows). Layouts: `docs/plans/2026-10-10-video-layouts-design.md`.
- Speaking: `getStats` audio levels every 250 ms, 800 ms hold — client-side only.

## Recovery
ICE `disconnected` → restart after 2 s; `failed` → restart now (`RestartIce` with an ICE-restart offer; Cloudflare
keeps the session 30 s). After two failed restarts — or at once when an answer to an SFU offer is refused — `state` =
`disconnected` → the room rejoins (same devices), up to 3 times in a row, then shows "Connection lost." with Try
Again. Attempts only start over after 30 s connected, so a fault that strikes right after every connect can't loop.
A dropped SignalR connection also triggers a rejoin.

## ICE / TURN
`GetRtcConfig` returns Cloudflare STUN/TURN (`CloudflareIceServerProvider`, short-lived credentials). Media normally
goes straight to Cloudflare's anycast edge; TURN (UDP/TCP/TLS 443) is the fallback for restrictive networks.
`Turn:ForceRelay` (`TURN_FORCE_RELAY=true`) forces relay to test that path. Nothing at home needs to be reachable.

## Data channels (files)
Design: `docs/plans/2026-10-10-encrypted-files-design.md`. `MediaService.publishChannel` / `subscribeChannel` /
`closeChannel` (used only by `FileTransferService`):
- The transport is added lazily on first use: `OpenDataTransport` → the SFU's offer (pulling its `server-events`
  channel) → our answer via `Renegotiate`. It's an SFU offer like a subscribe, so it respects the negotiation-order
  rule; it needs `startReceiving()` first. The SFU opens its `server-events` channel in-band on stream 0 — never
  create it yourself (a negotiated id 0 collides: `OperationError`, seen on WebKit and Chrome).
- Channels are negotiated (`{ negotiated: true, id: channelId, ordered: true }`), reliable and ordered, binary as
  ArrayBuffers. **16 KiB messages**: 64 KiB stalls on Cloudflare although the SDP says `max-message-size` 65536.
- Measured on the home stack: ~6–8 Mbps per transfer, fan-out to every subscriber works. The api closes channels
  after 5 minutes; ≤ 4 published / 8 received per participant.

## Cost (free tier)
SFU and TURN share 1,000 GB/month of egress (traffic *from* Cloudflare). A 4K camera ≈ 3.6 GB per viewer-hour,
1080p about a third; file downloads count too (one copy per recipient). The usage guard (`docs/plans/2026-10-09-usage-guard-design.md`)
estimates usage from browser reports (media and data channel bytes) and Cloudflare's analytics.

## Debugging
- In the call: More → **Connection** (`connection-health.ts`, every 2 s from `getStats`) shows the route (direct
  or TURN over UDP/TCP/TLS), round trip, loss each way, what each source sends (codec, size, layers) and what limits
  it (`qualityLimitationReason`; not on Firefox), plus E2EE counts. "Copy report" gives a numbers-only text to paste.
- api log (`scripts/logs.sh api`): failed SFU calls are logged as `{HubMethod}: media server request failed` with
  Cloudflare's status, error code and reason (SDP lines and addresses stripped). A refused answer
  (`invalid_session_description` on Renegotiate) wedges the session: Cloudflare then answers every other negotiation
  with `406 sessionDescription.type=answer is expected` and won't set up a second data transport — only a new session
  (rejoin) recovers, which now happens automatically. The log line carries `SFU refused the answer. Offered: …
  Answered: …` — mids, kinds and codec names only (`SdpCodecs`); the Connection report has the same as "Last
  negotiation failure" (kept across the rejoin).
- Repro scripts: `artifacts/repro/codec-rejoin.mjs` (codec changes with 2–3 people), `codec-sdp-probe.mjs` (codecs
  per m-line and what each side really sends), `safety-net-e2e.mjs` (old codec bug injected in one browser).
- Browser: `[cipheroom] camera failed …` in the console has the real device / negotiation error (Safari: Web
  Inspector over USB for iPhones). `chrome://webrtc-internals` for ICE and codecs.
- Two-browser checks without devices: headless Chrome (`--use-fake-device-for-media-stream`) or Playwright WebKit
  with a canvas `getUserMedia` stand-in, against `https://<PUBLIC_HOST>` (keep such scripts under `artifacts/`).
- getUserMedia needs a secure context: localhost is fine; LAN devices need `scripts/certs.sh`.
