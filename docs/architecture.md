# Architecture

## Goals

- Self-hosted with `docker compose up` on a home machine: **no public IP**, **zero running cost** (free tiers only, no
  rented VMs). Nothing at home has to be reachable from the internet.
- Media and chat are end-to-end encrypted: neither our server, Cloudflare's SFU, nor any TURN relay can decrypt them
  (planned — see "Encryption model").
- Standards-based (WebRTC, WebCrypto), no closed SDKs. Everything that runs at home is open source; media is
  forwarded by Cloudflare Realtime (hosted, free tier) — see [the SFU design](plans/2026-10-07-cloudflare-sfu-design.md).

## Components

```
 Browser (Angular)                                     Docker host (home, no public IP)
 ┌──────────────────────────────┐                     ┌──────────────────────────────────┐
 │ UI (grid, controls)          │  HTTPS / WSS        │ cloudflared  tunnel ingress      │
 │ SignalingService (SignalR) ──┼── Cloudflare ──────▶│ web          nginx + Angular     │
 │ MediaService (WebRTC)        │   Tunnel            │ api          .NET 10 + SignalR   │
 │ CryptoService (planned)      │                     └───────────────┬──────────────────┘
 └──────────────┬───────────────┘                                     │ outbound HTTPS only
                │ media (WebRTC, DTLS-SRTP)    ┌──────────────────────┴───┐  (SFU API, app secret)
                └─────────────────────────────▶│ Cloudflare Realtime SFU  │
                   (TURN fallback for strict   │ (+ TURN), anycast edge   │
                    client networks)           └──────────────────────────┘
```

| Service | Role | Sees |
|---|---|---|
| `api` (.NET 10, SignalR) | rooms, presence, **SFU proxy** (relays SDP, checks every track belongs to the caller's room), ICE config; later lobby, encrypted-chat and key-envelope relay | metadata, SDP (client IPs), public keys, ciphertext blobs |
| Cloudflare Realtime SFU | forwards media between browsers, simulcast layer selection | DTLS-SRTP-decrypted frames (plaintext until E2EE; ciphertext after), metadata |
| Cloudflare TURN | fallback relay for client networks that block direct UDP | DTLS-SRTP packets |
| `web` | static Angular app (ng-zorro UI, icons bundled — no runtime CDN fetches) + security headers | nothing sensitive |
| `cloudflared` | one public HTTPS hostname → `web` (which proxies `/api`, `/hubs` to the api) | TLS-terminated HTTP/WS |

**One signaling channel:** SignalR (`/hubs/room`) carries everything — rooms, media negotiation (the api relays offers
and answers to the SFU with its app secret, which never reaches clients) and, later, key envelopes and chat. Media
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

**Today** (open rooms, no E2EE yet):

1. `JoinRoom(roomId, displayName)` → own participant id + everyone already there, with their tracks.
2. `GetRtcConfig()` → Cloudflare STUN/TURN servers; the browser opens one `RTCPeerConnection`.
3. The browser **publishes its own tracks first** (`PublishTracks`): microphone and camera (f/h/q simulcast, VP8);
   devices that are off are published muted / as placeholder frames. iOS Safari can't add a camera once the
   connection began by answering the SFU, so this order is a rule.
4. Then it **receives** others: `SubscribeTracks` → SFU offer → answer (`Renegotiate`); new and removed tracks arrive
   as `TracksPublished` / `TracksUnpublished` / `ParticipantLeft`.
5. Recovery: ICE restart in place (Cloudflare keeps the session 30 s), otherwise a full rejoin.

**Target** flow adds before step 2: device identity, `JoinLobby` with a signed identity bundle and host admission;
and after step 3: sender keys exchanged over SignalR, media flowing only once keys are in place.

## Encryption model

> **Status: planned.** Nothing below is implemented yet; calls currently rely on DTLS-SRTP only, so Cloudflare's SFU
> can see media (see the README warning). This section is the target design.

**Frame encryption is ours** (since the SFU switch there is no LiveKit worker): one worker in
`web/src/app/core/crypto/`, AES-GCM via WebCrypto, applied with encoded transforms (`RTCRtpScriptTransform`,
`createEncodedStreams` fallback) to every sender and receiver `MediaService` creates. The codec payload header stays in
the clear so the SFU can forward (VP8: 10 bytes on keyframes, 3 otherwise; Opus: none). No custom primitives — only
the framing is ours, and it gets its own design doc and the `e2ee-media` checklist. Browsers without encoded
transforms can't join encrypted rooms; never fall back to plaintext.

### Identities
- Per device: Ed25519 signing key + X25519 agreement key (WebCrypto; P-256 fallback when unsupported).
  Private keys are non-extractable `CryptoKey`s stored in IndexedDB.
- Public bundle `{ participantId, ed25519Pub, x25519Pub, createdAt }` is self-signed and relayed by the server,
  which can store it but not forge it.

### Sender keys
- Each participant generates a random 256-bit **sender key** with a `keyIndex`.
- It's delivered to each other participant in an **envelope**:
  ephemeral X25519 ⟶ ECDH with recipient key ⟶ HKDF-SHA-256 ⟶ AES-GCM over
  `senderKey ‖ keyIndex ‖ roomId ‖ epoch`, the envelope signed with the sender's Ed25519 key.
- Receiver verifies signature → decrypts → installs the key for `(participantId, keyIndex)` in the frame worker.
- **Rotation:** on every **join** (newcomers can't read earlier media) and every **leave** (leavers can't read
  later media). Old indexes stay in the worker's keyring briefly so switching is glitch-free.
- Chat uses the same sender keys with a separate HKDF label.

### Authentication (anti-MITM)
A malicious server could inject a ghost participant or swap public keys. Defences:
- **Safety code** — emoji/digits from a hash of all participants' identity keys, shown in-call; compare out loud.
- **TOFU pinning** — remember contacts' identity keys; warn loudly if one changes.
- Clients only send envelopes to participants shown in the UI; joins always trigger a visible notice.

### Later: MLS
For very large rooms / multi-device, swap sender-key distribution for MLS (RFC 9420). Only `CryptoService` changes;
the frame worker's key interface stays the same.

### Known limits
- Metadata (who, when, IPs, bandwidth, who publishes which tracks) is visible to the api and Cloudflare.
- Server-side recording/transcription is impossible by design.

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

With E2EE in place, Cloudflare's SFU and TURN see only ciphertext + metadata.
