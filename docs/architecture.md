# Architecture

## Goals

- Self-hosted with `docker compose up` on a home machine: **no public IP**, **zero running cost** (free tiers only, no
  rented VMs). Nothing at home has to be reachable from the internet.
- Media is end-to-end encrypted: neither our server, Cloudflare's SFU, nor any TURN relay can decrypt it (see
  "Encryption model"; chat will use the same keys).
- Standards-based (WebRTC, WebCrypto), no closed SDKs. Everything that runs at home is open source; media is
  forwarded by Cloudflare Realtime (hosted, free tier) — see [the SFU design](plans/2026-10-07-cloudflare-sfu-design.md).

## Components

```
 Browser (Angular)                                     Docker host (home, no public IP)
 ┌──────────────────────────────┐                     ┌──────────────────────────────────┐
 │ UI (grid, controls)          │  HTTPS / WSS        │ cloudflared  tunnel ingress      │
 │ SignalingService (SignalR) ──┼── Cloudflare ──────▶│ web          nginx + Angular     │
 │ MediaService (WebRTC)        │   Tunnel            │ api          .NET 10 + SignalR   │
 │ CryptoService (E2EE keys)    │                     └───────────────┬──────────────────┘
 └──────────────┬───────────────┘                                     │ outbound HTTPS only
                │ media (WebRTC, DTLS-SRTP)    ┌──────────────────────┴───┐  (SFU API, app secret)
                └─────────────────────────────▶│ Cloudflare Realtime SFU  │
                   (TURN fallback for strict   │ (+ TURN), anycast edge   │
                    client networks)           └──────────────────────────┘
```

| Service | Role | Sees |
|---|---|---|
| `api` (.NET 10, SignalR) | rooms, presence, **SFU proxy** (relays SDP, checks every track belongs to the caller's room), ICE config, **key-envelope relay** (to the recipient only, within the room); later lobby and encrypted chat | metadata, SDP (client IPs), public keys, opaque envelopes |
| Cloudflare Realtime SFU | forwards media between browsers, simulcast layer selection | end-to-end encrypted frames (codec payload header in the clear), metadata |
| Cloudflare TURN | fallback relay for client networks that block direct UDP | DTLS-SRTP packets |
| `web` | static Angular app (ng-zorro UI, icons bundled — no runtime CDN fetches) + security headers | nothing sensitive |
| `cloudflared` | one public HTTPS hostname → `web` (which proxies `/api`, `/hubs` to the api) | TLS-terminated HTTP/WS |

**One signaling channel:** SignalR (`/hubs/room`) carries everything — rooms, media negotiation (the api relays offers
and answers to the SFU with its app secret, which never reaches clients), key envelopes and, later, chat. Media
flows browser ⇄ Cloudflare edge and never passes through the home machine. Protocol:
[`signaling-protocol.md`](signaling-protocol.md).

## Backend layering

The api follows Clean Architecture ([design](plans/2026-10-06-backend-clean-architecture-design.md)):

```
Cipheroom.Api ──► Cipheroom.Application ──► Cipheroom.Domain
      │                    ▲
      └──► Cipheroom.Infrastructure (implements Application ports)
```

- **Domain**: the `Room` aggregate — participants, their SFU session, published tracks (one per source, server-named)
  and subscriptions — plus value objects (`RoomId`, `DisplayName`, `ParticipantId`) and rules (tracks are only
  visible inside their room).
- **Application**: one command/query per use case on Mediator (MIT, source-generated) — join/leave, RTC config,
  publish/subscribe/renegotiate/restart/mute/layer — with pipeline behaviours for unhandled-exception logging, logging
  (request type only — never values, never SDP) and FluentValidation. Ports: `IRoomStore`, `ISfu`, `IIceServerProvider`.
- **Infrastructure**: in-memory room store, `CloudflareSfu` (over the typed `CloudflareSfuClient`; mutations never
  retried), Cloudflare/direct ICE providers, options.
- **Api**: SignalR hub (thin), `HubRateLimitFilter` (per-connection token bucket), `HubExceptionFilter` (safe client
  messages, incl. `Media server unavailable.`), ProblemDetails for REST, trusted forwarded headers, `--health` probe
  for the chiseled image.

## Join flow

**Today** (open rooms, end-to-end encrypted media):

1. The browser creates its per-call identity (`CryptoService`); a browser that can't encrypt stops here.
2. `JoinRoom(roomId, displayName, identity)` → own participant id + everyone already there, with their tracks and
   public identities. `CryptoService.start` then starts the frame worker with our first sender key and sends it to
   everyone in envelopes (`SendKeyEnvelopes`); everyone else rotates and sends us theirs.
3. `GetRtcConfig()` → Cloudflare STUN/TURN servers; the browser opens one `RTCPeerConnection`, with the frame
   transforms on every sender and receiver.
4. The browser **publishes its own tracks first** (`PublishTracks`): microphone and camera (f/h/q simulcast, VP8);
   devices that are off are published muted / as placeholder frames. iOS Safari can't add a camera once the
   connection began by answering the SFU, so this order is a rule.
5. Then it **receives** others: `SubscribeTracks` → SFU offer → answer (`Renegotiate`); new and removed tracks arrive
   as `TracksPublished` / `TracksUnpublished` / `ParticipantLeft`.
6. Recovery: ICE restart in place (Cloudflare keeps the session 30 s), otherwise a full rejoin.

**Target** flow adds `JoinLobby` with host admission before joining.

## Encryption model

Design and rationale: [`plans/2026-10-07-e2ee-media-design.md`](plans/2026-10-07-e2ee-media-design.md). All crypto
lives in `web/src/app/core/crypto/` (WebCrypto only); the api only relays public keys and opaque envelopes.

**Frame encryption is ours:** one worker (`frame-crypto.worker.ts`), AES-GCM-256, applied with encoded transforms
(`RTCRtpScriptTransform`, `createEncodedStreams` fallback on Chrome) to every sender and receiver `MediaService`
creates — before any frame flows. Frame layout: `[clear header][ciphertext + tag][counter 8 B][keyIndex 1 B]`; the
VP8 payload header (10 bytes on keyframes, 3 otherwise) stays in the clear so the SFU can forward and switch layers;
Opus has none. Every video transceiver prefers VP8; other codecs are dropped, never sent raw. Frames without a key
are dropped on both sides. Browsers without encoded transforms or Ed25519/X25519 can't join; there's no plaintext
fallback.

### Identities
- **Per call** (not per device): Ed25519 signing key + X25519 agreement key, non-extractable, in memory only —
  calls can't be linked by key. Reused for a rejoin within the same call, so the safety code stays stable.
- Public bundle `{ ed25519Pub, x25519Pub, sig }`, `sig` over the room id and both keys; sent with `JoinRoom`,
  relayed in every `ParticipantDto`. The server checks only the shape and can't forge it. A bundle that doesn't
  verify → that participant gets no keys and is flagged in the UI.

### Sender keys
- Each participant has a random 256-bit **sender key** per `epoch` (`keyIndex = epoch mod 16`); the worker derives
  the AES media key with HKDF (`cipheroom/media/v1`). One IV counter per key, shared by all our tracks.
- Delivered to each other participant in an **envelope**: ephemeral X25519 ⟶ X25519 with the recipient's key ⟶
  HKDF-SHA-256 (salt = room id) ⟶ AES-GCM over the sender key, AAD = room, epoch, key index, from, to; Ed25519-signed.
  Everything signed or hashed uses labelled, length-prefixed fields (`encoding.ts`).
- Receiver checks the signature first (against the sender's identity as shown), then room, sender, recipient and a
  strictly increasing epoch; only then does the key reach the worker.
- **Rotation** on every **join** (newcomers can't read earlier media) and **leave** (leavers can't read later
  media), debounced (300 ms) into one `SendKeyEnvelopes` call; we switch 500 ms after the server accepted it (at
  once if sending failed). Receivers keep a sender's previous key for 10 s; a missing key → frames dropped, tile
  shows "Securing…", keyframe requested when it arrives.

### Authentication (anti-MITM)
A malicious server could inject a ghost participant, swap public keys, or show people different participant sets.
Defences:
- **Safety code** — 4 named emoji + 8 digits from a hash of the room id and every participant's Ed25519 key
  (ours included), behind the header's "Encrypted" badge; a toast asks to compare again whenever it changes.
- Every join and leave is announced; keys go only to participants shown in the call.
- Later: **TOFU pinning** of contacts' keys (needs identities that persist across calls).

### Later: MLS
For very large rooms / multi-device, swap sender-key distribution for MLS (RFC 9420). Only `CryptoService` changes;
the frame worker's key interface stays the same.

### Known limits
- Metadata (who, when, IPs, bandwidth, who publishes which tracks, frame sizes and timing, the RTP audio-level
  header) is visible to the api and Cloudflare.
- A malicious server can drop envelopes or hide a leave (calls break, or a leaver keeps getting keys until the next
  rotation) — visible as "who's in the call", never a decryption.
- Not independently audited. Server-side recording/transcription is impossible by design.
- Debug: `?e2ee=passthrough` makes one browser skip decrypting what it receives (others look broken there) — a
  check that the SFU carries ciphertext; what it sends stays encrypted.

## Media path — free, no public IP

- **Cloudflare Realtime SFU** forwards media at Cloudflare's anycast edge. The home machine needs no inbound
  connectivity at all (works behind CGNAT): the tunnel carries HTTP/WebSocket, the api calls the SFU API outbound.
- **Cloudflare TURN** (`POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers`,
  behind `IIceServerProvider`) is only a fallback for client networks that block direct UDP — ports UDP 3478/443,
  TCP 3478/80, TLS 5349/443. `Turn:ForceRelay` forces it for testing.
- **Free tier:** SFU and TURN share **1,000 GB/month** of egress (traffic from Cloudflare to clients), $0.05/GB after.
  4K camera video ≈ 3.6 GB per viewer-hour, 1080p about a third — quality is user-selectable (Auto/4K/1080p/720p).

History:
- **Spike #1 — PASSED (2026-10-06):** LiveKit at home reached through Cloudflare TURN (`relay ⇄ prflx`, ~40 ms).
  It depended on the home router's public IPv4 (TURN won't relay to private addresses), so it would break behind CGNAT.
- **Spike #2 — PASSED (2026-10-07):** Cloudflare Realtime SFU — publish/pull, simulcast layer switching, ICE restart
  and forced TURN, including a phone on mobile data. LiveKit was then removed.

Contingency if Cloudflare's SFU ever stops fitting (cost, terms): bring back a self-hosted SFU (LiveKit, mediasoup)
behind the same seams — `MediaService` in the browser and the `ISfu` port in the api — once the home has a public IP
(IPv6 or a port-forwarded IPv4).

### Usage guard (planned — stay free)
- Track Realtime egress per month (client-reported byte counts as an estimate; Cloudflare's analytics as the
  authority if they expose SFU usage) against `REALTIME_MONTHLY_SOFT_LIMIT_GB` (warn) and
  `REALTIME_MONTHLY_HARD_LIMIT_GB` (refuse new calls).
- Also set a Cloudflare billing notification as a second safety net.

Cloudflare's SFU and TURN see only end-to-end encrypted frames + metadata.
