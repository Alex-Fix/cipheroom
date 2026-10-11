# LiveKit media mode (deployment mode 2) — design
Status: approved · Date: 2026-10-11

## Problem

Every call's media goes through Cloudflare Realtime: it caps traffic at the account-wide 1 TB/month free tier, and
Cloudflare sees call metadata (who connects, when, how much). With a Hetzner server (`docs/deployment-hetzner.md`) we
have a public IP and 20 TB/month of included traffic, so media can run on our own SFU. Deployment mode 2 in the README:
Cloudflare Tunnel for the website and signaling, a self-hosted SFU and TURN on the server's public IP.

## Goals / Non-goals

Goals
- **Independence from Cloudflare Realtime**: in LiveKit mode no media, TURN or SFU request touches Cloudflare.
- One codebase supporting **both providers**, chosen **per deployment** (`MEDIA_MODE=cloudflare|livekit`): home stays
  on Cloudflare, the Hetzner beta runs LiveKit.
- **Full parity**: calls, simulcast with per-tile layers, screen share, codec picker, encrypted files, diagnostics.
- **SignalR stays the only signaling channel** (rule 3 holds literally): LiveKit's signaling is relayed over SignalR.
- Restrictive networks: UDP → TCP → TURN-TLS on 443.
- Usage guard on the server's Hetzner traffic allowance.

Non-goals
- Choosing the provider per room, or automatic fallback between providers.
- Deployment mode 3 (no tunnel, app on the public IP) — later.
- LiveKit's own E2EE, Egress (recording), Ingress, agents, or LiveKit Cloud.
- Running LiveKit at home (no public IP there; home stays Cloudflare).

## Constraints check

| Constraint | LiveKit mode |
|---|---|
| E2EE invariant | Unchanged: our keys, our frame format, our worker; LiveKit forwards ciphertext (VP8 headers already clear). LiveKit's own E2EE is not used. **No frame may leave unencrypted** — gated by the spike. |
| $0 running cost | Opt-in mode on the paid Hetzner server (accepted for the Hetzner path). The usage guard keeps traffic within the included allowance. Default home mode unchanged and free. |
| No public IP | **Knowingly relaxed for this mode**: media and TURN on the server's IP. Website and signaling stay behind the tunnel; LiveKit's signaling port is never exposed. |
| Self-hostable + open source | LiveKit server and `livekit-client` (Apache-2.0), certbot (Apache-2.0). No SaaS. |
| Untrusted server | LiveKit sees what the api sees: pseudonymous room id, random participant ids, IPs, timing — no names (encrypted as today), no keys, no plaintext media. Cloudflare sees no media metadata any more. |
| Browser support | Needs encoded transforms as today (RTCRtpScriptTransform or Chrome encoded streams via LiveKit's hook). Mobile Safari: verified in the spike. |
| Signaling | New relay hub methods + a tagged `GetRtcConfig` (→ `signaling-protocol` skill). |

## Chosen approach

LiveKit server on the Hetzner server, behind a provider abstraction on both sides: `MediaTransport` in the browser
(`CloudflareTransport` = today's code, `LiveKitTransport` = `livekit-client`) and `ISfu` / `IMediaRoom` in the api.
LiveKit's signaling WebSocket is replaced in the browser by a stand-in that carries its opaque messages over SignalR;
the api opens the real WebSocket internally and attaches a token it creates.

Why not the alternatives:
- Own SFU on Pion: no browser change, but we'd own SFU correctness (simulcast switching, NACK, congestion) — the user
  preferred a proven media engine.
- Janus: mature and HTTP-driven, but needs a two-connection client mode for less benefit than LiveKit.
- mediasoup: no SDP; needs mediasoup-client, i.e. a client rewrite.
- LiveKit signaling direct through the tunnel (C1): simpler, but amends rule 3 and exposes the token to the browser;
  the user chose the relay.
- coturn: replaced by LiveKit's built-in TURN (TLS on 443, per-participant credentials via signaling) — one service
  less, same fallback chain.

## Design

### Architecture

```
Browser                                   api (.NET)                          LiveKit (container)
MediaService (facade, provider-neutral)
 ├─ CloudflareTransport ─ SignalR hub ──▶ ISfu → CloudflareSfuClient ──HTTPS─▶ Cloudflare
 └─ LiveKitTransport
     └─ livekit-client ── WS stand-in ── SignalR ──▶ LiveKitRelay ──ws (internal)──▶ :7880 signaling
              media ───────────────── UDP/TCP (public IP) ───────────────────────▶ :7882/udp, :7881/tcp
                    └─ TURN-TLS :443, TURN :3478/udp ─────────────────────────────▶ LiveKit built-in TURN
```

- `MEDIA_MODE` (api env, from `deploy/.env` / `.env.hetzner`) selects adapters at startup; `GetRtcConfig` tells the
  browser which transport to build.
- LiveKit room = the pseudonymous room id; participant identity = the participant id SignalR already uses, so tile
  mapping is identical in both modes.

### Protocol (SignalR)

`GetRtcConfig` becomes tagged by provider:
- `{ provider: "cloudflare", … }` — today's payload unchanged (ICE servers, SFU session).
- `{ provider: "livekit" }` — nothing secret.

Relay (LiveKit mode only; refused in Cloudflare mode):

| Direction | Message | Purpose |
|---|---|---|
| client → server | `OpenMediaRelay(relayId, path, query)` | open the upstream WebSocket |
| client → server | `SendMediaRelay(relayId, bytes)` | one signaling message upstream |
| client → server | `CloseMediaRelay(relayId)` | close it |
| server → client | `MediaRelayReceived(relayId, bytes)` | one message downstream |
| server → client | `MediaRelayClosed(relayId, code)` | upstream closed (`livekit-client` sees a WebSocket close and reconnects) |

`OpenMediaRelay` (the **browser picks the relay id** — 16 hex chars, checked for format and uniqueness — and registers
the socket before calling, buffering messages until `open`: LiveKit's join response arrives before the call returns):
1. Caller must be **admitted** to the room (knocking guests get nothing — same gate as the Cloudflare session).
2. Path must be `/rtc/v1` (or `/rtc`); query reduced to an allowlist (`join_request` — base64 protobuf, opaque —
   protocol version, auto-subscribe, reconnect/`sid`, SDK info); the client's placeholder `access_token` is dropped.
3. The api creates a LiveKit JWT: room = room id, identity = participant id, 10 min, publish/subscribe/data; connects
   to `ws://livekit:7880/rtc`.
4. Bytes copied both ways, never parsed, **never logged** (they contain SDP).

Limits: ≤ 2 relays per connection (live + reconnecting), 64 KiB per message, per-connection rate cap; relays close
when the SignalR connection drops, the participant is removed, or the room ends. Validation via FluentValidation,
errors via `HubExceptionFilter`.

### Server-side ports (api)

- `ISfu` stays the Cloudflare negotiation port (unchanged).
- New `IMediaRoom` (both providers): remove participant, end room. Cloudflare: close sessions (today's behaviour);
  LiveKit: `RoomService.RemoveParticipant` / `DeleteRoom` over LiveKit's server API with
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` (server-side only), plus closing that participant's relay.
- New `IMediaRelay` (LiveKit): upstream WebSocket management, token creation (`ILiveKitTokens`).
- Hubs stay thin: one Mediator command per method.

### Browser

`MediaTransport` (in `core/media/`):

```ts
interface MediaTransport {
  connect(cfg: TransportConfig): Promise<void>;
  publish(source: TrackSource, track: MediaStreamTrack, opts: PublishOptions): Promise<RTCRtpSender>;
  unpublish(source: TrackSource): Promise<void>;
  setRemoteSize(key: TrackKey, layer: 'f' | 'h' | 'q'): void;
  openFileChannel(peerId: string | undefined, name: string): Promise<FileChannel>;
  stats(): Promise<RTCStatsReport[]>;
  disconnect(): Promise<void>;
  readonly events: Observable<TransportEvent>;   // remote track added/removed (+ receiver), state, reconnecting
}
```

- `MediaService` keeps tiles, mute, cameras, quality/codec choice, usage-guard limits, diagnostics, encryption wiring.
- `CloudflareTransport`: today's single-connection code moved out of `MediaService`, behaviour unchanged.
- `LiveKitTransport`:
  - publish: `publishTrack(ourTrack, { videoCodec: vp9|vp8, simulcast: true, … })` — VP8 goes out as simulcast, VP9 as
    LiveKit's SVC (one encoding with spatial layers); layer selection works the same for both (spike);
  - receive: auto-subscribe; LiveKit's adaptive stream off; `f/h/q` → `VideoQuality.HIGH/MEDIUM/LOW`;
  - files: `FileChannel` over reliable data messages addressed to the receiver; the same 16 KiB chunks as Cloudflare
    (`livekit-client` rejects packets over 64,000 bytes);
  - signaling: a WebSocket stand-in, active only for an internal placeholder URL, carrying messages over
    `SignalingService` relay methods.

### Encryption (e2ee-media checklist)

- Keys, frame format and the cryptor in our worker are unchanged; keys come from `CryptoService` only.
- **No frame may leave unencrypted.** No LiveKit E2EE machinery is needed (spike): attach **our** transform
  - sender: in `livekit-client`'s public `LocalSenderCreated` event, emitted synchronously after the sender is created
    and before negotiation — measured: every encoded frame went through the transform, also across reconnects;
  - receiver: in `TrackSubscribed`.
- Transform API per engine, the same split LiveKit itself makes (`isScriptTransformSupportedForWorker` excludes
  Chromium): **Chromium → encoded streams** with `encodedInsertableStreams: true` on every peer connection
  `livekit-client` creates (constructor and `setConfiguration`), which also fails closed — no frame flows until our
  streams are piped; **Safari/WebKit → `RTCRtpScriptTransform`**. On Chromium, script transforms on LiveKit's receivers
  were silently bypassed (frames decoded without passing the transform) and threw `InvalidState` — never use them there
  in LiveKit mode.
- Receive side: frames before the transform are undecodable — at most a glitch, never plaintext.

### Deployment

- Compose profile `livekit`: service `livekit` (`livekit/livekit-server`, pinned) on the compose network — api reaches
  `livekit:7880`, which is **not published**. Single-port media: publishes `7882/udp`, `7881/tcp`, `3478/udp`,
  `443/tcp`.
- `deploy/livekit/livekit.yaml` (Ansible-templated): `node_ip` = public IPv4, built-in TURN for
  `turn-beta.alexfix.dev` (TLS on 443, UDP 3478) with the certificate files, rooms auto-created and closed soon after
  the last participant leaves, quiet logging.
- Keys: `scripts/secrets.sh` generates `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` into `deploy/.env.hetzner` (like
  `TELEMETRY_SECRET`). In LiveKit mode `CF_SFU_*` / `CF_TURN_*` are optional.
- Certificate: one-time DNS-only record `turn-beta.alexfix.dev → <server IPv4>`, a Cloudflare token limited to
  Zone → DNS → Edit on `alexfix.dev` (`CF_DNS_API_TOKEN` in `.env.hetzner`). New Ansible role `certs`: certbot with the
  Cloudflare DNS plugin (container) issues and renews on a nightly timer; LiveKit restarts after a renewal in the
  04:30 UTC window. Port 80 stays closed.
- Firewall: Terraform `media_mode` adds `443/tcp`, `3478/udp`, `7881/tcp`, `7882/udp` from anywhere in LiveKit mode;
  SSH unchanged; ufw mirrors it.
- Ansible: `cipheroom_mode: cloudflare | livekit`; LiveKit mode adds `certs`, the `livekit` profile, the config and
  `MEDIA_MODE` in the server's `.env`.

### Usage guard on Hetzner traffic

- New usage source next to the Cloudflare GraphQL poller: `GET https://api.hetzner.cloud/v1/servers/{id}` →
  `outgoing_traffic` / `included_traffic` for the current billing period.
- Same levels (saving / audio-only / paused at the configured percentages) on that ratio; banners unchanged; Grafana's
  "Free tier" panel shows "Traffic allowance" in this mode.
- Needs a **read-only** Hetzner token (`HCLOUD_READ_TOKEN`) and the server id (Terraform output → Ansible → `.env`).
- Counts all outgoing traffic of the server (Grafana, updates) — conservative. Browser-reported estimates remain the
  fallback.

### Failure modes

| Case | Behaviour |
|---|---|
| SignalR drops | Relays close → `livekit-client` reconnects; once SignalR is back the stand-in opens a new relay with a fresh token |
| LiveKit down/restarting | `OpenMediaRelay` fails clearly; existing reconnecting state + rejoin. No switch to Cloudflare |
| Participant removed / call ended | api closes the relay and calls `RemoveParticipant` / `DeleteRoom`; browsers enforce the signed removal as today |
| Guest not admitted | No relay, no token, no media |
| UDP blocked | TCP 7881, then TURN-TLS 443; diagnostics drawer shows the path |
| Certificate missing/expired | LiveKit runs without TURN-TLS; the deploy check fails loudly; renewal well before expiry |
| Encryption transform not ready | Never publish; existing "can't encrypt" path |
| Hetzner traffic API unreachable | Guard falls back to browser estimates |

## Protocol changes

- `GetRtcConfig` result: tagged union by `provider` (`cloudflare` payload unchanged; `livekit` payload empty).
- New client → server: `OpenMediaRelay(relayId, path, query)`, `SendMediaRelay(relayId, bytes)`, `CloseMediaRelay(relayId)`.
- New server → client: `MediaRelayReceived(relayId, bytes)`, `MediaRelayClosed(relayId, code)`.
- Updated together: C# hub + `IRoomClient`, `signaling.types.ts` + `SignalingService`, `docs/signaling-protocol.md`,
  functional tests. Rule 3 wording: note that LiveKit's signaling rides inside SignalR in LiveKit mode.

## Security notes

- Rule 3 holds: the browser talks only to the tunnel hostname over SignalR; LiveKit's 7880 is internal.
- The LiveKit token never reaches the browser; the api grants it only to admitted participants, per room, 10 min.
- Relay contents are SDP/ICE (no keys) and are never logged; limits stop abuse of the relay as a pipe.
- Metadata: LiveKit (on our server) sees pseudonymous ids, IPs, timing; names stay encrypted; Cloudflare sees no media
  metadata.
- Frame encryption must be in place before the first encoded frame (spike gate); otherwise LiveKit mode doesn't ship.
- New secrets: `LIVEKIT_API_KEY/SECRET`, `CF_DNS_API_TOKEN` (DNS edit, one zone), `HCLOUD_READ_TOKEN` (read-only) —
  all in gitignored env files, `no_log` in Ansible, added to `scripts/security-check.sh`'s secret patterns.
- Public attack surface added: LiveKit media ports and TURN (authenticated per participant by LiveKit).

## Testing

- Backend: functional tests for the relay methods (admitted only, limits, close on removal/room end, refused in
  Cloudflare mode) against a fake upstream WebSocket; unit tests for the LiveKit token + room client and the Hetzner
  usage poller.
- Browser: `MediaTransport` contract tests for both transports (stubbed `livekit-client` / peer connections);
  `CloudflareTransport` must pass the existing `MediaService` tests unchanged; tests for the stand-in, layer mapping,
  `FileChannel` over data messages.
- Two-browser e2e (headless shell + WebKit, fake media, never real devices) against a local LiveKit container: call,
  layer switch, screen share, file transfer, removal, reconnect; the same script in Cloudflare mode.
- Real check (user): beta in LiveKit mode, Mac Chrome + iPhone on mobile data, one forced-relay call over TURN-TLS;
  home stays on Cloudflare.

## Spike results (2026-10-11)

Local LiveKit 1.13.9 (single-port), `livekit-client` 2.22.4, a minimal SignalR relay, two browsers with canvas video +
oscillator audio (no devices); a marker transform stamped every outgoing frame and the receiver counted frames without
the stamp. Code: `artifacts/spikes/livekit/` (gitignored).

| Gate | Chromium (headless shell) | WebKit |
|---|---|---|
| 1. Signaling through the SignalR stand-in | ✅ connect; resume after LiveKit drops the socket; resume after the SignalR connection restarts | ✅ same |
| 2. No frame unencrypted (sender: encoded vs stamped; receiver: unstamped) | ✅ VP8 2,082/2,082, VP9 2,685/2,685 incl. reconnects; 0 unstamped received | ✅ VP8 2,032/2,032, VP9 2,502/2,502; 0 unstamped |
| Layer switching under encryption | ✅ VP8 simulcast and VP9 SVC: 720p → 180p → 360p → 720p, all frames stamped, decoding continuous | — |
| 3. Files over reliable data messages | ✅ 20 MiB complete, ≈ 100–160 Mbps on localhost (14–32 KiB chunks); limit 64,000 bytes per packet | ✅ ≈ 120–140 Mbps |

Changes to the design from the spike:
- Relay ids are chosen by the browser; early messages are buffered (the join response beat the `OpenRelay` result).
- No LiveKit E2EE hooks/worker protocol: our transform via `LocalSenderCreated` / `TrackSubscribed`; Chromium uses
  encoded streams (flag injected into LiveKit's peer connections), WebKit uses script transforms.
- VP9 is SVC in LiveKit (VP8 simulcast); same layer API.
- Files keep 16 KiB chunks.
- `livekit-client` probes `https://<placeholder>/rtc/v1/validate` after a failed connect; it fails harmlessly
  (`ERR_NAME_NOT_RESOLVED`) and the retry goes through the relay.

## Implementation notes (PR 2, 2026-10-11)

- **AnnounceTracks** (new hub method, not in the original design): in LiveKit mode publishing happens on LiveKit, so
  the browser tells the room which sources it published; `Room.Announce` records them without a media session (the
  source name stands in for a mid). Tiles, mute state and the usage guard keep reading the room as on Cloudflare.
- Providers are picked when services are resolved (`Media:Provider`); Cloudflare-only methods answer
  `Not available in this media mode.` via `UnavailableSfu`; LiveKit settings are validated at startup only in LiveKit
  mode (Cloudflare's stay checked at deploy: `scripts/up.sh`, Ansible).
- `SendMediaRelay` has its own rate bucket (200 burst / 100 per second); the general 5/s would cut a connect's ICE
  burst.
- `livekit-client` is a lazy chunk (≈127 KB gzipped), loaded only when a LiveKit call starts.
- Files over LiveKit: reliable data messages to the recipients only (`FileChannel`), the same 16 KiB sealed chunks.
- `scripts/dev.sh --livekit` runs a local LiveKit container with throwaway keys.
- Verified on the dev stack in LiveKit mode: three-person call with four codec changes and rejoins (everyone receives
  everyone), encrypted files (20 MB in 9 s; 100 MB twice, no stall), a mixed Chromium + WebKit call (each decrypts the
  other). Known noise: livekit-client logs "error reading from signal stream" when a rejoin tears down the old session.

## Implementation notes (PR 3, 2026-10-11)

- **TURN relay ports**: LiveKit's built-in TURN relays through UDP 30000-40000; in Docker's bridge network LiveKit's
  replies to a relay address on the public IP need those ports published. Narrowed to 30000-30100
  (`relay_range_start/end`), published by compose and opened by Terraform. Verified that LiveKit 1.13.9 starts TURN
  with the rendered config and a certificate in certbot's layout.
- The media mode comes from `MEDIA_MODE` in the env files everywhere (Terraform via `provision.sh`, Ansible, compose);
  `cipheroom_mode` is gone. TURN is optional (`LIVEKIT_TURN_DOMAIN`); the DNS record is created by hand.
- Usage guard: `HetznerRealtimeUsage` (server's `outgoing_traffic` / `included_traffic`) takes over when configured;
  the reported allowance replaces the free tier and is persisted, so a restart never measures terabytes against 1 TB.
- Grafana's panel keeps the name "Free tier" (it shows the allowance in either mode).

## Open questions

- Does LiveKit reload renewed certificates without a restart? (Otherwise the 04:30 restart stays.) — check in PR 3.
- The Cloudflare path uses `RTCRtpScriptTransform` on Chromium today and works (receivers attached in `ontrack`);
  given LiveKit's warning about Chromium's script transforms, keep an eye on `InvalidState` reports there.

## Implementation steps

PR 0 — spike ✅ done (results above)
1. ~~Stand-in over SignalR + reconnect~~ 2. ~~Transform before the first frame (Chromium, WebKit)~~ 3. ~~File throughput~~

PR 1 — provider abstraction, no behaviour change
4. Browser: `MediaTransport` interface; move today's code into `CloudflareTransport`; existing tests pass unchanged.
5. api: `IMediaRoom` (Cloudflare adapter = today's behaviour); tagged `GetRtcConfig` (+ TS types, protocol doc).

PR 2 — LiveKit mode
6. api: `MEDIA_MODE` options + DI; `ILiveKitTokens`; LiveKit `IMediaRoom` adapter.
7. api: relay hub methods + `IMediaRelay` (limits, admission gate, close on removal/end) + functional tests.
8. Browser: WebSocket stand-in + relay methods in `SignalingService`.
9. Browser: `LiveKitTransport` (publish/receive/layers/stats/events).
10. Browser: transforms via `LocalSenderCreated` / `TrackSubscribed` (encoded streams + flag on Chromium, script
    transforms on WebKit) + e2ee-media checklist review.
11. Browser: `FileChannel` over LiveKit data messages.
12. Compose profile `livekit`, `deploy/livekit/livekit.yaml`, `secrets.sh` keys; local two-browser e2e.

PR 3 — server and docs
13. Terraform `media_mode` firewall rules.
14. Ansible: `certs` role, `cipheroom_mode: livekit`, LiveKit config template.
15. Usage guard: Hetzner traffic source (`HCLOUD_READ_TOKEN`, server id), Grafana panel label.
16. `security-check.sh` patterns; docs: `deployment-hetzner.md`, README deployment modes, `architecture.md`,
    CLAUDE.md, `media` / `docker-deploy` / `e2ee-media` / `signaling-protocol` skills.
17. Switch the beta to LiveKit; real-device check.
