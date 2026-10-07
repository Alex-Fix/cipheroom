# Cloudflare Realtime SFU instead of LiveKit — design
Status: approved, implemented on `feat/cloudflare-sfu` · Date: 2026-10-07

## Problem

Media currently flows client → Cloudflare TURN → LiveKit at home → TURN → clients. Although no ports are forwarded,
this still depends on the home router having a **public IPv4**: LiveKit advertises it (`use_external_ip`) and
Cloudflare TURN refuses to relay to private addresses. Behind CGNAT it breaks, and the home uplink caps call size and
quality. The user doesn't want to depend on a public IP for now (it may be added later).

## Goals / Non-goals

Goals
- Replace LiveKit with Cloudflare Realtime SFU: home only needs outbound HTTPS (api → Cloudflare API, tunnel).
- Feature parity at switch time: group calls, screen share, camera switch, mute state, **simulcast / adaptive
  quality**, **active speaker**, **seamless reconnect** (ICE restart, rejoin fallback).
- A clean seam (frontend `MediaService`, backend `ISfu` port) so a self-hosted SFU can come back once a public IP exists.
- Groundwork for E2EE: one transform hook on every sender/receiver; codec choice compatible with frame encryption.

Non-goals
- E2EE itself (next milestone, own design; frame crypto becomes ours instead of LiveKit's).
- Diagnostics drawer (deferred; hidden in v1 — `ice-path.ts` can be reused later).
- Runtime switch between LiveKit and Cloudflare (LiveKit is removed; git history keeps it).
- The usage guard itself (separate roadmap item) — this change only keeps it possible.
- Cloudflare RealtimeKit (closed SDK, per-minute billing).

## Constraints check

| Constraint | Answer |
|---|---|
| E2EE invariant | ⚠️ **Temporary regression:** until E2EE ships, Cloudflare can see media (today only our own LiveKit could). README warning updated to say so. After E2EE: ciphertext only, via our own frame-crypto worker. |
| $0 | ✅ SFU + TURN share one free tier: 1,000 GB/month egress, $0.05/GB after; TURN↔SFU traffic not double-charged. Simulcast lowers egress. Billing notification stays as the hard net. |
| No public IP | ✅ Improves: home needs outbound HTTPS only; works behind CGNAT. |
| Open source / self-hostable | ⚠️ Media path on a closed SaaS (Cloudflare already provides TURN and the tunnel). Mitigated by the seam. |
| Untrusted server | api and Cloudflare learn track metadata (who publishes what, when) — participants were already visible. api passes SDP (contains client ICE candidates/IPs), never logged. Track names and Cloudflare session ids are server-controlled. |
| Browser support | Media: same as today. E2EE later needs encoded transforms (`RTCRtpScriptTransform`, `createEncodedStreams` fallback) — same requirement as LiveKit's worker. |
| Signaling | ✅ Simpler: SignalR becomes the only signaling channel (Cloudflare SFU has no client-facing signaling). |

## Chosen approach

**A — our own thin media client + SFU operations proxied over SignalR.** The api holds the Cloudflare app secret,
keeps a per-room track registry, and validates every operation in the hub pipeline (FluentValidation, rate limits,
`HubExceptionFilter`). The client runs one `RTCPeerConnection` in a new `MediaService`.

- Why not `partytracks` + REST proxy: a generic proxy to Cloudflare's API is hard to lock down per room, puts
  security checks outside the hub pipeline, and adds RxJS state next to signals.
- Why not keep LiveKit behind a config switch: two media paths to maintain, and E2EE would have to work on both.

## Design

### 1. Flow and components

Join
1. `JoinRoom(roomId, displayName)` → `selfId` + participants **with their published tracks**.
2. `GetRtcConfig()` → `iceServers` (Cloudflare STUN + TURN credentials), `forceRelay`. No LiveKit URL/token.
3. Client creates one `RTCPeerConnection`, adds mic + camera (camera with simulcast `f`/`h`/`q`).
4. `PublishTracks(offer, tracks)` → api creates the participant's Cloudflare session (one per participant, kept in
   `Room`), calls `tracks/new` with the local offer, records track names, broadcasts `TracksPublished`, returns answer.
5. `SubscribeTracks([{participantId, source}])` → api checks the tracks are in the caller's room, calls `tracks/new`
   with remote tracks, returns Cloudflare's offer; client answers with `Renegotiate(answer)`. Later joiners' tracks
   arrive via `TracksPublished` and follow the same path.
6. Leave/disconnect → api closes the participant's tracks, broadcasts `TracksUnpublished` + `ParticipantLeft`.

Components
- **Domain:** `Participant` (immutable record, replaced by `Room` on change) gains `SfuSessionId`,
  `PublishedTrack`s (`Name`, `Source` camera/microphone/screen → `Kind`, publisher `Mid`, `Muted`) and
  `Subscription`s (receiving `Mid`, publisher, source). Rules: one track per source; names generated server-side
  (`{participantId}-{source}`) and never sent to clients; pulls only within the same room; leaving/unpublishing drops
  everyone's subscriptions to those tracks. `IRoomStore.InRoom(connection, action)` applies changes atomically.
- **Application:** `PublishTracks`, `SubscribeTracks`, `Renegotiate`, `UnpublishTracks`, `UnsubscribeTracks`,
  `SetTrackMuted`, `SelectVideoLayer`, `RestartIce` commands + validators; `ISfu` port.
- **Infrastructure:** typed `CloudflareSfuClient` (`https://rtc.live.cloudflare.com/v1/apps/{appId}/…`: `sessions/new`,
  `sessions/{id}/tracks/new`, `…/renegotiate`, `…/tracks/update`, `…/tracks/close`), Bearer app secret set once in
  `AddHttpClient`, standard resilience handler, source-generated JSON; adapter maps to Application types.
  `LiveKitTokenIssuer` and LiveKit options removed.
- **Frontend:** `core/media/` replaces `core/livekit/`. `MediaService` owns the peer connection, a **serialized
  negotiation queue** (Cloudflare requires ordered per-session mutations), local tracks, remote streams per
  participant → signals, exposing the same `CallParticipant`/tile shape so `features/room/*` barely changes.
- **Deploy:** remove `livekit` service, `deploy/livekit/`, nginx `/livekit/` route, UDP port range. New `.env`:
  `CF_SFU_APP_ID`, `CF_SFU_APP_SECRET`.

### 2. Quality, speaker, mute, reconnect

- **Send quality (user choice):** selector **Auto / 4K / 1080p / 720p**, default **Auto** = the best the camera
  supports, up to 4K (`ideal` 3840×2160); explicit choices cap capture. 4K / 1080p are only offered when the camera's
  capabilities reach them. Remembered in this browser (`cipheroom.videoQuality`). Changing it re-captures the camera
  and `replaceTrack`s it — no renegotiation.
- **Simulcast:** the camera publishes `f` (capture resolution), `h` (½) and `q` (¼) with bitrates by height
  (2160p 8 Mbps, 1440p 5, 1080p 3, 720p 1.5, 540p 0.8, 360p 0.5, lower 0.2); bitrates are re-targeted via
  `setParameters` when the resolution changes. Screen share sends one layer.
- **Receive quality:** always the **highest** layer (`f`) for every camera on screen — subscriptions start at `f` and
  Cloudflare steps down (`priorityOrdering` / `ridNotAvailable: "asciibetical"`) only when the receiver's bandwidth
  can't keep up. Tiles report on/off screen (`setTileSize`, debounced ~500 ms); off-screen tiles and a hidden tab drop
  to `q`.
- **Quota impact:** 4K ≈ 8 Mbps ≈ 3.6 GB per received camera per hour (a 3-person hour ≈ 22 GB of the 1 TB/month
  free tier); 1080p ≈ a third of that. The usage guard (separate roadmap item) and the Cloudflare billing alert
  remain the safety net.
- **Negotiation order:** a client publishes its own tracks *before* it starts receiving others'
  (`MediaService.startReceiving()` after the room's device setup). iOS Safari fails to add a simulcast camera once
  the peer connection began by answering the SFU's offer — joining a room with others in it broke the camera, joining
  first worked. Devices that are off at join are still published (microphone muted; camera as muted placeholder frames
  via `reserveCamera()`), so turning them on later is a `replaceTrack`, never a new negotiation. Screen share remains a
  later publish (not available on iOS).
- **Active speaker:** every 250 ms read inbound `audioLevel` from `getStats()` (+ local level); speaking above a
  threshold with ~800 ms hold. Client-side only.
- **Mute:** never renegotiates. Microphone: `track.enabled = false` (keeps sending silence). Camera / screen: the
  capture track is stopped (camera light off) and the sender switches to a 320×180 black canvas track at 1 fps —
  Cloudflare garbage-collects tracks after 30 s without packets, so the placeholder keeps the published track alive
  and turning the camera back on is a `replaceTrack`. Then `SetTrackMuted` → `TrackMuted` broadcast; remote tiles
  show the muted icon / monogram.
- **Reconnect:** ICE `disconnected`/`failed` → ICE restart (`createOffer({ iceRestart: true })` → `RestartIce`);
  Cloudflare keeps sessions 30 s after connectivity loss. SignalR reconnect with a new connection id → rejoin,
  republish, resubscribe. Beyond 30 s or failed restart → full rejoin. UI shows "Reconnecting…" throughout.
- **Audio autoplay:** catch `play()` rejection on audio elements → existing "tap to enable audio" prompt.

### 3. Data and state

All in memory in the api (as today): per room, participants with Cloudflare session id and published tracks.
Nothing persisted; an api restart drops calls (clients rejoin). Cloudflare garbage-collects tracks idle for 30 s.

## Protocol changes

Follows the `signaling-protocol` skill (C# hub + `IRoomClient` + Contracts, TS types + `SignalingService`,
`docs/signaling-protocol.md` incl. Errors table, functional tests — same commit).

Changed
| Dir | Method | Change |
|---|---|---|
| C→S | `JoinRoom` | `participants[]` gain `tracks[]`: `TrackDto { source, kind, muted }` |
| C→S | `GetRtcConfig` | `RtcConfig { iceServers[], forceRelay }` — `livekitUrl`, `token` removed |

New
| Dir | Method | Args → Returns |
|---|---|---|
| C→S | `PublishTracks` | `offerSdp, tracks[{ mid, source }]` → `answerSdp` (kind follows from source) |
| C→S | `SubscribeTracks` | `tracks[{ participantId, source }]` → `{ offerSdp, tracks[{ participantId, source, mid }] }` (`offerSdp` null if nothing new) |
| C→S | `Renegotiate` | `answerSdp` → — |
| C→S | `UnpublishTracks` | `sources[]` → — |
| C→S | `UnsubscribeTracks` | `mids[]` → — |
| C→S | `SetTrackMuted` | `source, muted` → — |
| C→S | `SelectVideoLayer` | `mid, rid` (`f`/`h`/`q`) → — |
| C→S | `RestartIce` | `offerSdp` → `answerSdp` |
| S→C | `TracksPublished` | `participantId, TrackDto[]` |
| S→C | `TracksUnpublished` | `participantId, sources[]` |
| S→C | `TrackMuted` | `participantId, source, muted` |

Clients refer to remote tracks by **participant + source** only; Cloudflare track names stay server-side.

Validation: SDP ≤ 32 KB starting with `v=0`; 1–3 tracks per publish with distinct mids and sources; `source` ∈
{microphone, camera, screen}; participant ids must look like ours (16 hex); `rid` ∈ {f, h, q}; `mid`
`^[A-Za-z0-9_-]{1,16}$`; ≤ 64 tracks per subscribe/unsubscribe. New errors (constant text): `Invalid session
description.`, `Invalid track.`, `Invalid layer.`, `Track already published.`, `Unknown track.`, `No media session.`,
`Media server unavailable.` (plus the existing `Join a room first.`). Existing per-connection rate limit applies;
client debounces `SelectVideoLayer`.

## Security notes

- **Cloudflare sees plaintext media until E2EE** — accepted; README warning names Cloudflare.
- **App secret** only in `deploy/.env` → api options; never sent to clients or logged; `security-check.sh` covers it.
  A leak spends quota → billing notification + future usage guard.
- **Cross-room pulls** blocked in `SubscribeTracks` via the `Room` aggregate (functional test).
- **Server-controlled identifiers:** track names generated by the api; Cloudflare session ids never leave the server;
  clients address tracks by `participantId + source` (remote) or `mid` (own).
- **SDP** passed through after size/prefix checks; never logged (contains client IPs).
- **E2EE readiness:** one place where senders/receivers are created to hook a frame transform into (no-op now).
  VP8 for camera simulcast (payload header can stay clear, Cloudflare doesn't read payload). (H.264 was tried for
  the iOS camera issue and reverted — the cause was negotiation order, see "Negotiation order".) `e2ee-media` skill and
  `architecture.md` change "frame crypto is LiveKit's" → "frame crypto is ours, one worker in `core/crypto/`".
- **Usage data:** without LiveKit webhooks, usage comes from client-reported `bytesSent/Received` (`ReportUsage`,
  every 60 s, capped, treated as an estimate) — protocol addition belongs to the usage-guard work, not this change.

## Testing

- Domain: track registry rules, cleanup on leave.
- Application: validators; handlers with substituted `ISfu`, incl. `Unknown track.` for foreign tracks.
- Infrastructure: `CloudflareSfuClient` via real registration + stub handler — request shapes, auth header, error mapping.
- Api functional: two SignalR clients + fake `ISfu`: publish → `TracksPublished`; subscribe → offer; foreign track
  rejected; disconnect → `TracksUnpublished`; constant error messages.
- Frontend: `MediaService` with mocked `RTCPeerConnection` — negotiation ordering, layer choice + debounce, speaking
  threshold/hold, mute event, ICE restart path; room component specs keep the tile shape.
- Manual on the home stack: two desktops + phone on mobile data (CGNAT), screen share, camera flip, mute, 3-person
  call (layer switching), network toggle (reconnect), Safari.

## Spike result

**Spike #2 — PASSED (2026-10-07).** Throwaway `/sfu-spike.html` + `/api/spike/sfu/*` pass-through on the home stack
(`https://cipheroom.alexfix.dev`): push mic + camera (VP8 simulcast f/h/q), pull other publishers, layer switching via
`tracks/update`, ICE restart via `renegotiate` with an offer, and forced relay through Cloudflare TURN all worked,
including a phone on mobile data. The spike page and endpoints were removed afterwards; `CloudflareSfuClient` stays.

Learned:
- Session ids are 64 hex characters (the OpenAPI example shows 32).
- A wrong app id/secret returns a non-JSON error body: the client only parses JSON and maps everything else to
  `CloudflareSfuException(status)`.
- `renegotiate` accepts a client **offer** and returns an answer — that is how ICE restart works.

## Open questions

- Can Cloudflare's analytics (GraphQL) give per-app SFU/TURN egress cheaply enough to cross-check client-reported
  usage? Check during the spike.
- Simulcast behaviour and `RTCRtpScriptTransform` availability on current mobile Safari — confirm in the spike.

## Implementation steps

1. **Spike** (branch): `CloudflareSfuClient` + throwaway dev page and hub methods; verify CGNAT/mobile data,
   Safari simulcast, analytics question. Stop and rethink if it fails.
2. Domain + Application: track registry, commands/validators, `ISfu` port, tests.
3. Infrastructure: `CloudflareSfuClient`, options, DI, tests; `GetRtcConfig` without LiveKit fields.
4. Api + protocol: hub methods/events, Contracts, TS types, `SignalingService`, protocol doc, functional tests.
5. Frontend `MediaService`: peer connection, publish/subscribe, negotiation queue, mute, screen share, camera switch.
6. Frontend quality: simulcast + layer selection, active speaker, ICE restart / rejoin, audio autoplay prompt.
7. Room wired to `MediaService`; diagnostics drawer hidden; `livekit-client` and `core/livekit/` removed.
8. Deploy: remove LiveKit service/config/nginx route/ports; `.env.example` and `scripts/secrets.sh` updated.
9. Docs + skills (`livekit-media` → `media`, `e2ee-media`, `docker-deploy`, `security`), CLAUDE.md, README,
   `architecture.md`; full tests, security check, home-stack smoke test.

References: [Realtime SFU](https://developers.cloudflare.com/realtime/sfu/),
[simulcast](https://developers.cloudflare.com/realtime/sfu/simulcast/),
[limits](https://developers.cloudflare.com/realtime/sfu/limits/),
[pricing](https://developers.cloudflare.com/realtime/sfu/pricing).
