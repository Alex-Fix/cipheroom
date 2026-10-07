# Cipheroom

Self-hosted, open-source video calling (Zoom / Telegram-video style) with **end-to-end encrypted media**.
The server must never be able to see or hear call content. Treat that as the product's core invariant.

## Stack

| Layer | Tech |
|---|---|
| Backend | .NET 10, ASP.NET Core, SignalR (signaling, presence, room state) |
| Frontend | Angular (standalone components, signals), plain WebRTC browser APIs |
| Media | Cloudflare Realtime SFU (free tier, shared with TURN); plain WebRTC in the browser (`MediaService`), SFU calls proxied by the api |
| E2EE (planned) | **Our** frame encryption (one worker, AES-GCM via WebCrypto, encoded transforms) + **our** key management: device identities (Ed25519/X25519), sender keys in signed envelopes over SignalR, rotation on join/leave, safety codes |
| NAT traversal | No public IP needed: media goes browser ⇄ Cloudflare edge; Cloudflare TURN as fallback for restrictive networks |
| Runtime | Docker Compose; Cloudflare Tunnel (`cloudflared`) for HTTPS/WSS ingress |

Hard constraints: runs at home, **no public IP**, **$0 running cost** (free tiers only, usage guard, no rented VMs).

## Layout (target — create projects here, don't invent new top-level dirs)

```
Cipheroom.slnx                   solution (+ global.json, Directory.Build.props, Directory.Packages.props)
src/                             Clean Architecture — dependencies point inward only:
  Cipheroom.Domain/              entities, value objects, rules (no dependencies)
  Cipheroom.Application/         commands/queries (Mediator), FluentValidation, ports (interfaces)
  Cipheroom.Infrastructure/      adapters: room store, Cloudflare SFU + TURN clients, options
  Cipheroom.Api/                 ASP.NET Core host: SignalR hubs, filters, composition root (+ Dockerfile)
tests/                           xUnit v3, one project per layer (shared settings in tests/Directory.Build.props)
  Cipheroom.Domain.UnitTests/ .Application.UnitTests/ .Infrastructure.IntegrationTests/ .Api.FunctionalTests/
web/                             Angular app (npm, + Dockerfile); src/app/{core,shared,features}, design/ = logo masters
deploy/
  docker-compose.yml             api, web (nginx), cloudflared
  nginx/ cloudflared/            service config
scripts/                         dev/ops scripts (bash, run from repo root)
docs/                            architecture + protocol docs; plans/ holds approved feature designs
```

## Commands

All scripts run from the repo root.

- `scripts/doctor.sh` — check required toolchain
- `scripts/dev.sh` — API :5080 (`dotnet watch`, SFU/TURN credentials from `deploy/.env`) + Angular :4200
- `scripts/test.sh` — backend + frontend tests (`--server` / `--web` to run one side)
- `scripts/lint.sh` — `dotnet format --verify-no-changes` + `ng lint` (if configured)
- `scripts/up.sh` / `scripts/down.sh` — docker compose stack in `deploy/`
- `scripts/logs.sh [service]` — follow compose logs
- `scripts/secrets.sh` — create `deploy/.env`, list required Cloudflare values that are still empty
- `scripts/security-check.sh [url]` — secret scan, `.env` hygiene, NuGet/npm audit, live security headers
- `scripts/certs.sh` — local HTTPS certs via mkcert (needed to test cameras from another LAN device)

## Non-negotiable rules

1. **Keys never touch a server.** The api, Cloudflare's SFU and TURN only ever see public keys and signed, encrypted envelopes. No key material in SignalR plaintext fields, REST, logs, analytics, error reports or SFU requests.
2. **All servers are untrusted for content.** Don't add features needing plaintext media/chat on a server (recording, transcription) without an explicit design change. Never fall back to unencrypted if E2EE setup fails.
3. **Signaling contract is shared.** SignalR is the only signaling channel (rooms, media negotiation relayed to the SFU, later lobby, key envelopes, chat). Any hub method / client event change must update C# (`IRoomClient`, hub), TS (`signaling.types.ts`) and `docs/signaling-protocol.md` in the same change. See the `signaling-protocol` skill.
4. **No secrets in git.** `.env`, TURN secrets, tunnel credentials, certs stay out of the repo (`.gitignore` covers them).
5. **Stay free and open.** Only open-source components and free tiers; any paid dependency needs explicit approval.

## Conventions

- C#: Clean Architecture (see Layout and the `dotnet-backend` skill). Hubs stay thin: one Mediator command/query per
  method; all input validated by FluentValidation in the pipeline (clients are untrusted); errors mapped by
  `HubExceptionFilter`. Nullable, file-scoped namespaces, records, `[LoggerMessage]` logging (never request values),
  `TimeProvider` for time, versions only in `Directory.Packages.props`. No MediatR/AutoMapper (non-OSS licences).
- Angular: standalone components, signals for state, `inject()` over constructor DI. Every component is a folder
  with `.ts` + `.html` + `.less` + `.spec.ts` (no inline templates/styles); styles are Less only; features never
  import each other (shared code goes to `core/` or `shared/`). Services `SignalingService` / `MediaService` /
  `CryptoService` (planned) are the boundaries — components never touch the peer connection or keys directly.
- Tests: xUnit v3 (Microsoft Testing Platform) + NSubstitute for backend, one test project per layer; hub behaviour
  and client-visible messages get functional tests. Angular default test runner for frontend.
- Keep crypto in one place (`web/src/app/core/crypto/`). WebCrypto only, no custom ciphers; frame encryption is ours
  (one worker) and gets reviewed against the `e2ee-media` checklist.

## Skills in this repo

- `security` — threat model, per-layer hardening rules, review checklist (use with `e2ee-media` for crypto)
- `brainstorming` — turn a feature idea into an approved design doc in `docs/plans/` before coding
- `media` — calls on Cloudflare Realtime SFU: MediaService, SFU proxy, negotiation-order rules, quality, ICE/TURN, debugging
- `e2ee-media` — identities, sender keys, envelopes, rotation, frame transform, review checklist
- `signaling-protocol` — how to add/change SignalR messages end to end
- `dotnet-backend` — backend project conventions and scaffolding
- `angular-frontend` — frontend conventions and scaffolding
- `docker-deploy` — compose services, Cloudflare SFU/TURN credentials, tunnel hostname, usage guard

Details: `docs/architecture.md`.
