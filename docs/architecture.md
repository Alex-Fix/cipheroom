# Architecture

## Goals

- Self-hosted with `docker compose up` on a home machine: **no public IP**, **zero running cost** (free tiers only, no rented VMs).
- Media and chat are end-to-end encrypted: neither our server, LiveKit, nor any TURN relay can decrypt them.
- Open source, standards-based (WebRTC, WebCrypto), no closed SDKs.

## Components

```
 Browser (Angular)                                  Docker host (home, no public IP)
 ┌───────────────────────────────┐                 ┌──────────────────────────────────┐
 │ UI (lobby, grid, controls)    │  HTTPS / WSS    │ cloudflared  tunnel ingress      │
 │ SignalingService (SignalR) ───┼─── Cloudflare ─▶│ web      nginx + Angular static  │
 │ LiveKitService (livekit-client)── Tunnel ──────▶│ api      .NET 10 + SignalR       │
 │ CryptoService (planned)       │                 │ livekit  SFU (signaling via tunnel)
 │ LiveKit E2EE worker (planned) │                 └────────────────┬─────────────────┘
 └───────────────┬───────────────┘                                  │ outbound UDP
                 │ media                    ┌───────────────────────┐│
                 └─────────────────────────▶│ Cloudflare TURN relay │◀┘
                                            └───────────────────────┘
```

| Service | Role | Sees |
|---|---|---|
| `api` (.NET 10, SignalR) | identities, rooms, lobby/admission, presence, encrypted-chat relay, **key-envelope relay**, LiveKit token + ICE config issuance | metadata, public keys, ciphertext blobs |
| `livekit` | SFU: routing, simulcast, dynacast, screen share | encrypted frames + metadata |
| TURN | relay so media can reach LiveKit without a public IP | DTLS-SRTP packets around E2EE frames |
| `web` | static Angular app (ng-zorro dark UI, icons bundled — no runtime CDN fetches) + security headers | nothing sensitive |
| `cloudflared` | public HTTPS hostnames → `web`, `api`, `livekit` (signaling only) | TLS-terminated HTTP/WS |

**Two signaling channels by design:**
- **LiveKit signaling** (LiveKit WebSocket) — SDP/ICE/track subscriptions. Owned by `livekit-client`; not re-implemented.
- **App signaling** (SignalR `/hubs/room`) — Cipheroom logic, including E2EE key distribution. LiveKit never sees keys.

## Backend layering

The api follows Clean Architecture ([design](plans/2026-10-06-backend-clean-architecture-design.md)):

```
Cipheroom.Api ──► Cipheroom.Application ──► Cipheroom.Domain
      │                    ▲
      └──► Cipheroom.Infrastructure (implements Application ports)
```

- **Domain**: `Room`, `Participant`, value objects (`RoomId`, `DisplayName`, `ParticipantId`) and their rules.
- **Application**: one command/query per use case on Mediator (MIT, source-generated), with pipeline behaviours for
  unhandled-exception logging, logging (request type only — never values) and FluentValidation.
- **Infrastructure**: in-memory room store, LiveKit token issuer, Cloudflare/direct ICE providers, options.
- **Api**: SignalR hub (thin), `HubRateLimitFilter` (per-connection token bucket), `HubExceptionFilter` (safe
  client messages), ProblemDetails for REST, trusted forwarded headers, `--health` probe for the chiseled image.

## Join flow

**Today:** `JoinRoom(roomId, displayName)` (open, no lobby) → `GetRtcConfig()` → connect to LiveKit with the
returned token and ICE servers; no E2EE yet ([protocol](signaling-protocol.md)). **Target** flow:

1. Client loads/creates its **device identity** and connects to SignalR.
2. `JoinLobby(roomId, signedIdentityBundle)` → host admits (or room is open).
3. On admit the api returns `RtcConfig`: LiveKit URL, **LiveKit access token** (JWT, room-scoped, short TTL),
   and **ICE servers** (TURN credentials from the configured provider).
4. Client connects to LiveKit with E2EE enabled (per-participant keys) and `rtcConfig.iceServers` from step 3.
5. Sender keys are exchanged over SignalR (below); media starts once keys are in place.

## Encryption model

> **Status: planned.** Nothing below is implemented yet; calls currently rely on DTLS-SRTP only (see the README
> warning). This section is the target design.

LiveKit's E2EE worker does the frame crypto (AES-GCM via encoded transforms). **We own key management** —
no custom frame crypto in this repo.

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
- Receiver verifies signature → decrypts → sets key for `(participantIdentity, keyIndex)` in the LiveKit key provider.
- **Rotation:** on every **join** (newcomers can't read earlier media) and every **leave** (leavers can't read
  later media). Old indexes stay in LiveKit's keyring briefly so switching is glitch-free.
- Chat uses the same sender keys with a separate HKDF label.

### Authentication (anti-MITM)
A malicious server could inject a ghost participant or swap public keys. Defences:
- **Safety code** — emoji/digits from a hash of all participants' identity keys, shown in-call; compare out loud.
- **TOFU pinning** — remember contacts' identity keys; warn loudly if one changes.
- Clients only send envelopes to participants shown in the UI; joins always trigger a visible notice.

### Later: MLS
For very large rooms / multi-device, swap sender-key distribution for MLS (RFC 9420). Only `CryptoService`
changes; the LiveKit key-provider interface stays the same.

### Known limits
- Metadata (who, when, IPs, bandwidth) is visible to api, LiveKit and TURN.
- Server-side recording/transcription is impossible by design.

## NAT / TURN — free, no public IP

Cloudflare Tunnel carries HTTP + WebSocket (web, api, SignalR, LiveKit signaling) but **not media**. Media needs a
publicly reachable relay, so clients relay through **Cloudflare Realtime TURN**:

- Free tier: **1,000 GB/month** egress (shared with Cloudflare's SFU product), $0.05/GB after — the api's usage
  guard keeps us inside the free tier.
- api calls `POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers`
  (`{ "ttl": … }`) behind `IIceServerProvider` and hands the returned `iceServers` to the client.
  Ports offered: UDP 3478/443, TCP 3478/80, TLS 5349/443 — works on locked-down networks.
- Clients use `iceTransportPolicy: "relay"`; LiveKit runs with `use_external_ip: true` so its candidate is the home
  router's public address (Cloudflare refuses to relay to private IPs).

**Spike #1 — PASSED (2026-10-06).** Two Chrome clients over `https://cipheroom.alexfix.dev` with
`iceTransportPolicy: relay`: selected pair `relay ⇄ prflx`, UDP via TURN/UDP, ~40 ms RTT. LiveKit's outbound
packets open the home NAT; the TURN server sees LiveKit as a peer-reflexive candidate (TURN permissions are per IP,
so port mapping doesn't matter). Still to confirm: a phone on mobile data, and restrictive (TCP/TLS-only) networks.

Free contingencies if some network fails:
1. **IPv6** — if the ISP gives public IPv6, open LiveKit's ports for v6; Cloudflare TURN bridges v4-only clients.
2. **Router port-forward of the LiveKit UDP range** — if the home has a (dynamic) public IPv4 without CGNAT.
3. **Cloudflare Realtime SFU** instead of LiveKit — no inbound connectivity needed at all, same free tier, but
   replaces LiveKit and its E2EE worker (we'd own frame encryption). Last resort.

### Usage guard (stay free)
- api records relay usage per call from LiveKit webhooks (participant-minutes × bitrate estimate) and keeps a monthly total.
- At `TURN_MONTHLY_SOFT_LIMIT_GB` (default 800) admins are warned; at the hard limit new calls are refused.
- Also set a Cloudflare billing notification as a second safety net.

Because media is E2EE, Cloudflare's relay sees only ciphertext + metadata.
