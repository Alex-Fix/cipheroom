# Architecture

## Goals

- Self-hosted with `docker compose up` on a home machine: **no public IP**, **zero running cost** (free tiers only, no
  rented VMs). Nothing at home has to be reachable from the internet.
- Media is end-to-end encrypted: neither our server, Cloudflare's SFU, nor any TURN relay can decrypt it (see
  "Encryption model"); so is in-call chat, with keys derived from the same sender keys.
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
| `api` (.NET 10, SignalR) | rooms, **lobby and admission** (verifies host proofs, tickets and host-control signatures), presence, **SFU proxy** (relays SDP, checks every track belongs to the caller's room), ICE config, **key-envelope and knock relay** (to the recipient only, within the room), **encrypted chat relay** (to the room's other members) | metadata, SDP (client IPs), public keys, signatures, opaque envelopes, knocks and chat events — never names or chat text |
| Cloudflare Realtime SFU | forwards media between browsers, simulcast layer selection | end-to-end encrypted frames (codec payload header in the clear), metadata |
| Cloudflare TURN | fallback relay for client networks that block direct UDP | DTLS-SRTP packets |
| `web` | static Angular app (ng-zorro UI, icons bundled — no runtime CDN fetches) + security headers; `/source` redirects to the running commit's code (AGPL §13, `SOURCE_URL` + commit baked in at build) | nothing sensitive |
| `cloudflared` | one public HTTPS hostname → `web` (which proxies `/api`, `/hubs` to the api, `/grafana/` to Grafana) | TLS-terminated HTTP/WS |
| Observability (profile `observability`) | otel-collector → Prometheus / Loki / Tempo, Grafana at `/grafana/` behind its own hardened login, node-exporter, cAdvisor — [`observability.md`](observability.md) | pseudonymous metadata: hashed room ids, random participant ids, call timing, call-quality numbers (7 days) |

**One signaling channel:** SignalR (`/hubs/room`) carries everything — rooms, media negotiation (the api relays offers
and answers to the SFU with its app secret, which never reaches clients), key envelopes and encrypted chat. Media
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

Design: [`plans/2026-10-08-lobby-admission-design.md`](plans/2026-10-08-lobby-admission-design.md).

0. **New meeting** (home page): the browser creates a **host key** (Ed25519 + X25519), stores the Ed25519 signing
   key non-extractable in IndexedDB (the X25519 private key isn't used, and WebKit can't keep X25519 keys in
   IndexedDB, so only the backup holds it) and offers a one-time, passphrase-encrypted backup file. The room id is
   `base32(SHA-256(fields("cipheroom/room/v1", hostEd25519Pub, hostX25519Pub)))[0..26]`, so the invite link names
   its host — nobody can claim the room without the host key.
1. The browser creates its per-call identity (`CryptoService`); a browser that can't encrypt stops here.
2. `JoinLobby(roomId, identity, videoCodecs, hostProof?, ticket?)`:
   - **Host**: `hostProof` = the host public keys + the host key's signature over our identity → straight in.
   - **Returning member** (same tab, e.g. after a reconnect): the ticket that admitted this identity → straight in.
   - **Everyone else** waits in the lobby: no participant list, no media, no keys. The guest encrypts its name to
     each admitter (`Knock`); an admitter's browser decrypts it, and `Admit` sends a **ticket** — the admitter's
     identity signature over the guest's identity. The guest gets `Admitted` with the participant list.
3. `CryptoService.start` starts the frame worker with our first sender key and sends it, with our name, to every
   **verified and admitted** participant in envelopes (`SendKeyEnvelopes`); everyone else rotates and sends us theirs.
4. `GetRtcConfig()` → Cloudflare STUN/TURN servers; the browser opens one `RTCPeerConnection`, with the frame
   transforms on every sender and receiver.
5. The browser **publishes its own tracks first** (`PublishTracks`): microphone and camera (f/h/q simulcast, in the
   video codec chosen at join — VP9 by default, see "Video codecs" below);
   devices that are off are published muted / as placeholder frames. iOS Safari can't add a camera once the
   connection began by answering the SFU, so this order is a rule.
6. Then it **receives** others: `SubscribeTracks` → SFU offer → answer (`Renegotiate`); new and removed tracks arrive
   as `TracksPublished` / `TracksUnpublished` / `ParticipantLeft`.
7. Recovery: ICE restart in place (Cloudflare keeps the session 30 s), otherwise a full rejoin (with our ticket).

Host and co-host controls are signed statements too: `GrantCoHost`, `RemoveParticipant` (revocation → everyone
rotates without them), `UpdateSettings` (auto-admit: admitters' browsers sign tickets as people knock),
`AskToMute` (advisory), `EndCall`.

## Encryption model

Design and rationale: [`plans/2026-10-07-e2ee-media-design.md`](plans/2026-10-07-e2ee-media-design.md). All crypto
lives in `web/src/app/core/crypto/` (WebCrypto only); the api only relays public keys and opaque envelopes.

**Frame encryption is ours:** one worker (`frame-crypto.worker.ts`), AES-GCM-256, applied with encoded transforms
(`RTCRtpScriptTransform`, `createEncodedStreams` fallback on Chrome) to every sender and receiver `MediaService`
creates — before any frame flows. Frame layout (v2):
`[clear header][ciphertext + tag][counter 8 B][codec 1 B][keyIndex 1 B]`, the codec byte authenticated so the SFU
can't relabel a frame. The VP8 payload header (10 bytes on keyframes, 3 otherwise) stays in the clear so the SFU can
forward and switch layers; VP9 and Opus have none (codec byte 3, formerly AV1, is reserved). Every video
transceiver negotiates only the call's codec; anything else is dropped, never sent raw. Frames without a key
are dropped on both sides. Browsers without encoded transforms or Ed25519/X25519 can't join; there's no plaintext
fallback.

### Identities
- **Per call** (not per device): Ed25519 signing key + X25519 agreement key, non-extractable, in memory only —
  calls can't be linked by key. Reused for a rejoin within the same call, so the safety code stays stable.
- Public bundle `{ ed25519Pub, x25519Pub, sig }`, `sig` over the room id and both keys; sent with `JoinLobby`,
  relayed in every `ParticipantDto`. The server checks only the shape and can't forge it. A bundle that doesn't
  verify → that participant gets no keys and is flagged in the UI.

### Admission (who gets keys)
- **Authority chain**, every link an Ed25519 signature over `fields(label, roomId, …)`: the host key attests the
  host's per-call identity (`cipheroom/host/v1`); the host identity grants co-hosts (`cohost/v1`); hosts and co-hosts
  sign tickets (`ticket/v1`), removals (`revoke/v1`), "end" (`end/v1`) and mute requests (`mute/v1`, with a
  sequence number); the host signs settings (`settings/v1`, sequence number).
- The api verifies each statement before acting on it (Ed25519 on BouncyCastle) — that keeps strangers away from the
  SFU and the participant list. **Clients verify everything again** (`statements.ts`): a participant only gets our
  keys if their identity verifies *and* the host key attests them or they hold a ticket from a host or co-host, and
  they weren't removed. Someone a malicious server slips into the call gets no keys. A removal a browser has
  verified is kept for the rest of the call: a later authority without it (an api restart, or a server lying by
  omission) never lets that identity back in.
- Statements name per-call identities, so none can be replayed into a later call.

### Names
Display names never reach the server in plaintext: guests encrypt theirs to each admitter (knocks, `knock.ts`), and
everyone sends theirs to everyone inside key envelopes (v2: sender key ‖ name). Names are padded to one size
(`names.ts`), and signed by the person who chose them.

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
- Every join and leave is announced; keys go only to participants shown in the call **who were admitted** (see
  "Admission").
- Later: **TOFU pinning** of contacts' keys (needs identities that persist across calls).

### Later: MLS
For very large rooms / multi-device, swap sender-key distribution for MLS (RFC 9420). Only `CryptoService` changes;
the frame worker's key interface stays the same.

### Chat
Design: [`plans/2026-10-09-encrypted-chat-design.md`](plans/2026-10-09-encrypted-chat-design.md). In-call text and
emoji reactions, browser memory only (gone when you leave; newcomers see only what comes after they joined).
- Chat key = HKDF(sender key, `cipheroom/chat/v1`), so it rotates with the media key (same epoch, same switch-over).
- Every event (message or reaction — the server can't tell which) is signed by the author's per-call identity
  (`cipheroom/chat-sig/v1`), padded to 512 B / 2 / 8 / 16 KB, and AES-GCM encrypted with AAD = room, relayed sender
  and key index (`cipheroom/chat-aad/v1`). Receivers drop replays (per-author sequence numbers), forgeries (another
  member holds the same chat key, not the author's identity) and anything from participants without verified keys.
- Events that beat their sender's key wait up to 10 s. Links are plain anchors to `http(s)` URLs; nothing is fetched.
  Reactions must use an emoji from the app's own set (`core/chat/emoji.ts`).

### Known limits
- Metadata (who, when, IPs, bandwidth, who publishes which tracks, frame sizes and timing, the RTP audio-level
  header) is visible to the api and Cloudflare; for chat, the api sees who sent an event, when, and its size bucket.
  Size-based layer requests also show which camera a viewer watches large (pin or active speaker).
- A malicious server can drop envelopes, knocks or admissions, or hide a leave or a removal from some members
  (calls break, someone waits forever, or a leaver keeps getting keys until the next rotation) — visible as "who's
  in the call", never a decryption. It can't admit anyone, appoint a host or forge a removal or "end", nor undo a
  removal a member has already seen.
- The server learns which random participant ids are host / co-host, and lobby timing and size — never names.
- A co-host's tickets stay valid after that co-host is removed (their earlier admissions don't break); a removed
  co-host colluding with a malicious server could admit someone the call would see in the list.
- The web app is served by your server: a server that ships malicious JavaScript defeats any web-app E2EE.
- Host key backups are only as strong as their passphrase (PBKDF2-SHA-256, 600k iterations; WebCrypto has no
  Argon2).
- Not independently audited. Server-side recording/transcription is impossible by design.
- With observability on, the home server also keeps (7 days) traces and logs per hub call with keyed room hashes and
  random participant ids, and browsers' call-quality numbers — never keys, envelopes, SDP, names or IPs
  ([`observability.md`](observability.md)).
- Debug: `?e2ee=passthrough` makes one browser skip decrypting what it receives (others look broken there) — a
  check that the SFU carries ciphertext; what it sends stays encrypted.

## Video layouts
Design: [`plans/2026-10-10-video-layouts-design.md`](plans/2026-10-10-video-layouts-design.md). Each person picks
their own view; nothing about it goes to the server beyond the existing layer requests.
- A pure `callLayout` (`features/room/layout/`) gives every tile a role (`stage` / `strip` / `grid` / `float` /
  `hidden`) and a rect; the room keeps all tiles in one container, so videos never re-mount (hidden tiles stay mounted,
  zero-sized, so their audio plays).
- Stage priority in Speaker view: pin > remote screen share > active speaker (1.5 s hysteresis, `StageSpeaker`) >
  first remote camera. A new remote share switches Grid to Speaker until it ends or the user picks a view.
- Receive layers follow tile size in device pixels: ≥ 960 → `f`, ≥ 360 → `h`, else (or hidden / background tab) → `q`.
- View, self-view mode and corner are remembered per browser (`core/settings/call-view.ts`); phones default to
  Speaker + floating self-view.

## Video codecs

Designs: [`plans/2026-10-08-video-compression-design.md`](plans/2026-10-08-video-compression-design.md),
[`plans/2026-10-08-remove-av1-design.md`](plans/2026-10-08-remove-av1-design.md). Users pick VP9 (default, ~⅓ fewer
bytes than VP8) or VP8 in the ⋯ menu; it's remembered per browser. Each participant tells the others what it can
decode (`videoCodecs` in `JoinLobby`), and each sender picks its codec when it joins: its choice if everyone can
decode it, else VP8. Cloudflare doesn't forward a codec change on a published track, so changing it — or someone
joining who can't decode it — makes that sender rejoin (~1–2 s). VP9 layers are sent with `scalabilityMode: L1T3`
(otherwise Chrome sends VP9 as one SVC stream). AV1 was removed: with Cloudflare dropping its Dependency Descriptor
and our encrypted payload, a viewer that dropped to a lower simulcast layer never switched back up.

## Media path — free, no public IP

- **Cloudflare Realtime SFU** forwards media at Cloudflare's anycast edge. The home machine needs no inbound
  connectivity at all (works behind CGNAT): the tunnel carries HTTP/WebSocket, the api calls the SFU API outbound.
- **Cloudflare TURN** (`POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers`,
  behind `IIceServerProvider`) is only a fallback for client networks that block direct UDP — ports UDP 3478/443,
  TCP 3478/80, TLS 5349/443. `Turn:ForceRelay` forces it for testing.
- **Free tier:** SFU and TURN share **1,000 GB/month** of egress (traffic from Cloudflare to clients), $0.05/GB after.
  4K camera video ≈ 3.6 GB per viewer-hour, 1080p about a third — quality is user-selectable (4K / 1080p, the default / 720p).

History:
- **Spike #1 — PASSED (2026-10-06):** LiveKit at home reached through Cloudflare TURN (`relay ⇄ prflx`, ~40 ms).
  It depended on the home router's public IPv4 (TURN won't relay to private addresses), so it would break behind CGNAT.
- **Spike #2 — PASSED (2026-10-07):** Cloudflare Realtime SFU — publish/pull, simulcast layer switching, ICE restart
  and forced TURN, including a phone on mobile data. LiveKit was then removed.

Contingency if Cloudflare's SFU ever stops fitting (cost, terms): bring back a self-hosted SFU (LiveKit, mediasoup)
behind the same seams — `MediaService` in the browser and the `ISfu` port in the api — once the home has a public IP
(IPv6 or a port-forwarded IPv4).

### Usage guard — stay free
Design: [`plans/2026-10-09-usage-guard-design.md`](plans/2026-10-09-usage-guard-design.md). `UsageGuard` (api) keeps
Cloudflare Realtime egress (SFU + TURN, 1 TB/month free) inside the free tier, enforced server-side:
- **The figure:** Cloudflare's month-to-date egress while its last poll is fresh (≤ 45 min), plus the api's own
  estimate since an hour before that poll; without fresh Cloudflare data, the estimate for the month. The estimate
  is what browsers' call-quality reports say they received (capped per report, ×1.1 for TURN overhead), kept in
  `/data/usage.json` (volume `api-data`; numbers and timestamps only) across restarts.
- **Levels** (`REALTIME_*_PERCENT` in `deploy/.env`): saving at 80% (received cameras held at the half simulcast
  layer, senders capped at 720p), audio-only at 95% (no new calls or guests, lobbies emptied, video forwarding
  stopped), paused at 99% (every call ended). Within a month the level only rises; it resets on the 1st (UTC).
- Everyone sees why (`UsageChanged`: level, percent, reset date — nothing at normal). `REALTIME_GUARD_ENABLED=false`
  turns it off. Keep a Cloudflare billing notification as a second safety net.
- Abuse: an admitted participant over-reporting can only bring a pause forward (capped per report; Cloudflare's
  figure wins while fresh) — a denial of service, never a bill.

Cloudflare's SFU and TURN see only end-to-end encrypted frames + metadata.
