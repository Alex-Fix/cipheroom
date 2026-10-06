# Cipheroom

Self-hosted, open-source video calling (Zoom / Telegram-video style) with **end-to-end encrypted media**.
The server must never be able to see or hear call content. Treat that as the product's core invariant.

## Stack

| Layer | Tech |
|---|---|
| Backend | .NET 10, ASP.NET Core, SignalR (signaling, presence, room state) |
| Frontend | Angular (standalone components, signals), plain WebRTC browser APIs |
| Media | LiveKit SFU (self-hosted container), `livekit-client` in the browser |
| E2EE | LiveKit frame encryption + **our** key management: device identities (Ed25519/X25519), sender keys in signed envelopes over SignalR, rotation on join/leave, safety codes |
| NAT traversal | No public IP: Cloudflare Realtime TURN (free 1 TB/mo); contingencies in `docs/architecture.md` |
| Runtime | Docker Compose; Cloudflare Tunnel (`cloudflared`) for HTTPS/WSS ingress |

Hard constraints: runs at home, **no public IP**, **$0 running cost** (free tiers only, usage guard, no rented VMs).

## Layout (target — create projects here, don't invent new top-level dirs)

```
Cipheroom.sln
src/
  server/Cipheroom.Api/          ASP.NET Core host, SignalR hubs, REST endpoints
  server/Cipheroom.Api.Tests/    xUnit tests (incl. hub integration tests via WebApplicationFactory)
  web/                           Angular app (npm)
deploy/
  docker-compose.yml             api, web (nginx), livekit, cloudflared
  livekit/ nginx/ cloudflared/   service config
scripts/                         dev/ops scripts (bash, run from repo root)
docs/                            architecture + protocol docs; plans/ holds approved feature designs
```

## Commands

All scripts run from the repo root.

- `scripts/doctor.sh` — check required toolchain
- `scripts/dev.sh` — LiveKit (docker, `deploy/docker-compose.dev.yml`) + API :5080 (`dotnet watch`) + Angular :4200
- `scripts/test.sh` — backend + frontend tests (`--server` / `--web` to run one side)
- `scripts/lint.sh` — `dotnet format --verify-no-changes` + `ng lint` (if configured)
- `scripts/up.sh` / `scripts/down.sh` — docker compose stack in `deploy/`
- `scripts/logs.sh [service]` — follow compose logs
- `scripts/secrets.sh` — create `deploy/.env`, generate LiveKit API key/secret
- `scripts/security-check.sh [url]` — secret scan, `.env` hygiene, NuGet/npm audit, live security headers
- `scripts/certs.sh` — local HTTPS certs via mkcert (needed to test cameras from another LAN device)

## Non-negotiable rules

1. **Keys never touch a server.** api, LiveKit and TURN only ever see public keys and signed, encrypted envelopes. No key material in SignalR plaintext fields, REST, logs, analytics, error reports or LiveKit metadata.
2. **All servers are untrusted for content.** Don't add features needing plaintext media/chat on a server (recording, transcription) without an explicit design change. Never fall back to unencrypted if E2EE setup fails.
3. **Signaling contract is shared.** SignalR = app signaling (lobby, key envelopes, chat); LiveKit = media signaling. Any hub method / client event change must update C# (`IRoomClient`, hub), TS (`signaling.types.ts`) and `docs/signaling-protocol.md` in the same change. See the `signaling-protocol` skill.
4. **No secrets in git.** `.env`, TURN secrets, tunnel credentials, certs stay out of the repo (`.gitignore` covers them).
5. **Stay free and open.** Only open-source components and free tiers; any paid dependency needs explicit approval.

## Conventions

- C#: nullable enabled, file-scoped namespaces, records for DTOs, strongly-typed hubs (`Hub<IRoomClient>`), minimal APIs, `TimeProvider` for time. Validate every hub input — clients are untrusted.
- Angular: standalone components, signals for state, `inject()` over constructor DI. Services `SignalingService` / `LiveKitService` / `CryptoService` are the boundaries — components never touch LiveKit `Room` or keys directly.
- Tests: xUnit for backend; Angular default test runner for frontend. Hub behaviour gets integration tests.
- Keep crypto in one place (`web/src/app/core/crypto/`). WebCrypto only; frame crypto is LiveKit's, we never write our own.

## Skills in this repo

- `security` — threat model, per-layer hardening rules, review checklist (use with `e2ee-media` for crypto)
- `brainstorming` — turn a feature idea into an approved design doc in `docs/plans/` before coding
- `livekit-media` — LiveKit client/server integration, tokens, ICE/TURN modes, connectivity spike
- `e2ee-media` — identities, sender keys, envelopes, rotation, key provider, review checklist
- `signaling-protocol` — how to add/change SignalR messages end to end
- `dotnet-backend` — backend project conventions and scaffolding
- `angular-frontend` — frontend conventions and scaffolding
- `docker-deploy` — compose services, Cloudflare TURN, tunnel hostnames, usage guard

Details: `docs/architecture.md`.
