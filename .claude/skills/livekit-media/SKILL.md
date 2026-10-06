---
name: livekit-media
description: LiveKit SFU integration for Cipheroom — livekit-client usage in Angular, access tokens from .NET, ICE/TURN config (Cloudflare Realtime TURN), livekit.yaml for running without a public IP, simulcast, screen share, webhooks. Use for anything touching calls/media, LiveKit config, or connectivity debugging.
---

# LiveKit media

Read `docs/architecture.md` ("Components", "NAT / TURN") first.

## Boundaries
- Frontend: `web/src/app/core/livekit/livekit.service.ts` owns the `Room`. Components consume signals
  (participants, tracks, active speaker, connection quality). No `RTCPeerConnection` code in this repo — LiveKit owns it.
- Backend: `Rtc/` feature — `LiveKitTokenService`, `IIceServerProvider` (+ `CloudflareIceServerProvider`,
  `LiveKitIceServerProvider`), `LiveKitWebhookEndpoint` (usage accounting).
- Media signaling = LiveKit WebSocket. App signaling = SignalR. Never mix them.

## Connecting (frontend)
```ts
const room = new Room({
  adaptiveStream: true,          // subscribe to resolution that fits the tile
  dynacast: true,                // stop publishing layers nobody watches
  e2ee: { keyProvider, worker: new Worker(new URL('livekit-client/e2ee-worker', import.meta.url)) },
});
await room.setE2EEEnabled(true);           // BEFORE publishing anything
await room.connect(cfg.livekitUrl, cfg.token, {
  rtcConfig: { iceServers: cfg.iceServers, iceTransportPolicy: cfg.forceRelay ? 'relay' : 'all' },
});
await room.localParticipant.enableCameraAndMicrophone();
```
- `keyProvider` is ours (see `e2ee-media`). If E2EE can't be enabled (unsupported browser), **don't join**.
- Screen share: `localParticipant.setScreenShareEnabled(true)`; prefer VP9/AV1 for screen content.
- Simulcast is on by default for camera — keep it.
- Handle `RoomEvent.Disconnected`/`Reconnecting`/`Reconnected`; refresh `RtcConfig` (token + TURN creds) on reconnect.
- Verify API names against the installed `livekit-client` version — it evolves.

## Access tokens (backend)
JWT HS256 signed with `LIVEKIT_API_SECRET`:
```json
{ "iss": "<LIVEKIT_API_KEY>", "sub": "<participantId>", "name": "<displayName>",
  "nbf": now, "exp": now+600,
  "video": { "room": "<roomId>", "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": false } }
```
- Issue only to admitted participants. `sub` must equal the participant id used for E2EE keys.
- Use the official LiveKit .NET server SDK if available on NuGet, otherwise `System.IdentityModel.Tokens.Jwt`.
- `canPublishData: false` — chat goes through SignalR encrypted; LiveKit data channels aren't covered by our key mgmt.

## ICE servers
`CloudflareIceServerProvider`: `POST https://rtc.live.cloudflare.com/v1/turn/keys/{CF_TURN_KEY_ID}/credentials/generate-ice-servers`
with `Authorization: Bearer {CF_TURN_API_TOKEN}`, body `{ "ttl": 14400 }`; pass `iceServers` through unchanged.
Cache per participant for the TTL; Cloudflare asks that >50% of issued credentials actually get used.
Always `forceRelay = true` — LiveKit at home is only reachable via the relay.
Refuse to issue credentials when the usage guard's hard limit is hit.

## livekit.yaml (home, behind NAT)
```yaml
port: 7880                      # signaling; nginx proxies https://<PUBLIC_HOST>/livekit/ here
rtc:
  port_range_start: 50000
  port_range_end: 50100
  tcp_port: 7881
  use_external_ip: true         # announce router's public address — Cloudflare TURN won't relay to private IPs
turn:
  enabled: false                # home mode uses Cloudflare TURN
keys: {}                        # injected via LIVEKIT_KEYS env
webhook:
  urls: [http://api:8080/api/livekit/webhook]
```

## Spike #1 — does home + Cloudflare TURN work?
1. `scripts/up.sh --tunnel`, LiveKit in home mode.
2. Join from laptop on Wi-Fi and phone on **mobile data** (Wi-Fi off), `forceRelay` on.
3. `chrome://webrtc-internals` → selected candidate pair should be `relay` ↔ LiveKit's public `srflx`/host.
4. If ICE fails consistently → see contingencies in `docs/architecture.md` (IPv6, port-forward, Cloudflare SFU).
   Record the result there.

## Debugging
- LiveKit logs: `scripts/logs.sh livekit` (ICE failures show as "ICE connection failed").
- `livekit-cli` load tests: `lk load-test` against a test room.
- getUserMedia needs a secure context: localhost is fine; LAN devices need `scripts/certs.sh`.
