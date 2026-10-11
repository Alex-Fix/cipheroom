---
name: docker-deploy
description: Docker Compose stack for Cipheroom (api, web/nginx, cloudflared), env config, Cloudflare Realtime SFU + TURN credentials, free-tier usage guard, ports, and Cloudflare Tunnel limits. Use when editing deploy/, Dockerfiles, compose services, or troubleshooting self-hosted deployment.
---

# Deployment

Constraints: **runs at home, no public IP, $0 running cost, no rented VMs.** See `docs/architecture.md` → "Media path".
Nothing at home needs to be reachable from the internet: ingress is the tunnel, media goes browser ⇄ Cloudflare
Realtime SFU, and the api only makes outbound HTTPS calls to Cloudflare.

## Services (`deploy/docker-compose.yml`)
| Service | Image | Ports | Notes |
|---|---|---|---|
| `api` | `src/Cipheroom.Api/Dockerfile` | 8080 internal | env from `.env`: `Sfu__Cloudflare__*` (required), `Turn__*` |
| `web` | `web/Dockerfile` | 8080 internal (`127.0.0.1:${WEB_PORT}` on host) | nginx, serves the app, proxies `/api` + `/hubs` to api |
| `cloudflared` | `cloudflare/cloudflared` | none | profile `tunnel`; `tunnel run --token ${TUNNEL_TOKEN}` |
| `otel-collector`, `prometheus`, `loki`, `tempo`, `grafana`, `node-exporter`, `cadvisor` | pinned images | none | profile `observability` (`scripts/up.sh --observability`): `deploy/observability/`, `mem_limit` each, 7-day retention, named volumes. Grafana via nginx `/grafana/`, protected by its own hardened login (nginx rate-limits `/grafana/login`). See `docs/observability.md`. |

No media server runs at home and no UDP ports are published.

## Tunnel hostname (Cloudflare dashboard → Tunnel → Public hostnames)
- Single hostname `${PUBLIC_HOST}` (cipheroom.alexfix.dev) → `http://web:8080`; nginx routes `/api`, `/hubs` → api.
- Keep it a **first-level** subdomain: Cloudflare's free Universal SSL doesn't cover `a.b.alexfix.dev`.
- The tunnel carries HTTP/WebSocket only — media never passes through it.

## Cloudflare Realtime setup
- **SFU** (required): dashboard → Realtime → SFU → create application → `CF_SFU_APP_ID` / `CF_SFU_APP_SECRET`.
  Compose refuses to start without them.
- **TURN** (fallback for restrictive networks): dashboard → Realtime → TURN → create key → `CF_TURN_KEY_ID` /
  `CF_TURN_API_TOKEN`. `TURN_FORCE_RELAY=true` forces relay to test that path.
- `scripts/secrets.sh` creates `deploy/.env` and lists what's still empty.

## Free tier and usage guard
SFU and TURN share **1,000 GB/month** of free egress (traffic from Cloudflare to clients); 4K video is ~3.6 GB per
viewer-hour. With `CF_ACCOUNT_ID` + `CF_ANALYTICS_API_TOKEN` (Account Analytics: Read) the api polls month-to-date
usage from Cloudflare (`RealtimeUsagePoller`) and the Grafana **Free tier** dashboard shows it. The **usage guard**
(`UsageGuard`, design `docs/plans/2026-10-09-usage-guard-design.md`) enforces the free tier: `REALTIME_SAVING_PERCENT`
(80, video capped), `REALTIME_AUDIO_ONLY_PERCENT` (95, no new calls, audio only), `REALTIME_PAUSED_PERCENT` (99, calls
end) of `REALTIME_FREE_TIER_GB` (1000); `REALTIME_GUARD_ENABLED=false` turns it off. Its estimate lives in the
`api-data` volume (`/data/usage.json`) — don't delete that volume mid-month without a Cloudflare analytics token.
To try it out, pin a level with `{"UsageGuard": {"ForceLevel": "Saving"}}` (or `AudioOnly`, `Paused`) in
`artifacts/dev/dev-settings.json` while `scripts/dev.sh` runs — Development only, applied live; `{}` puts it back.
Keep a Cloudflare billing notification on as a second net. Don't add paid services or rented VMs without approval.

## Source link (AGPL §13)
The app links to `/source`; nginx redirects it to `SOURCE_URL` (`deploy/.env`, default the GitHub repo) +
`/tree/<commit>`, both baked into the web image at build (`web/Dockerfile` validates them). `scripts/up.sh` passes the
commit only when web/, src/, deploy/ and the build props match it (untracked files included), and warns if that commit
isn't pushed. Forks running modified code must push it and set `SOURCE_URL` to their repository.

## Media mode (MEDIA_MODE)
`cloudflare` (default: Cloudflare Realtime SFU + TURN, no public IP needed) or `livekit` (profile `livekit`: the
`livekit` service, `deploy/livekit/livekit.yaml`, keys `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` from `scripts/secrets.sh`,
`LIVEKIT_NODE_IP` = the machine's public IPv4; publishes only 7881/tcp + 7882/udp — signaling 7880 stays internal and
is relayed by the api). `scripts/up.sh` checks the chosen mode's settings and adds the profile; the Cloudflare SFU
values are required only in Cloudflare mode. On the server (Ansible): `LIVEKIT_NODE_IP` is set to the server's IP;
with `LIVEKIT_TURN_DOMAIN` (+ `CF_DNS_API_TOKEN`, DNS-only record) the `certs` role issues Let's Encrypt via the DNS
check, `livekit.yaml` gets TURN (TLS 443, UDP 3478, relay ports 30000-30100 — published and opened by Terraform's
`media_mode`), renewal at 04:30 UTC restarts LiveKit only on change. `HCLOUD_READ_TOKEN` + the server id switch the
usage guard to Hetzner traffic. Design: `docs/plans/2026-10-11-livekit-media-mode-design.md`.

## Images and the Hetzner server (opt-in, costs money)
`api` and `web` carry `image: ${CIPHEROOM_IMAGE_PREFIX:-ghcr.io/alex-fix/cipheroom}-<svc>:${CIPHEROOM_TAG:-local}`
next to `build:` — home builds tag `local`; `.github/workflows/images.yml` pushes `sha-<commit>` / `main` / release
tags to GHCR (amd64, Source link = that commit). `scripts/provision.sh` (Terraform, `deploy/terraform/hetzner/`:
`cx23`, Ubuntu 26.04, firewall = 22/tcp from `allowed_ssh_cidrs` only) and `scripts/deploy.sh` (Ansible,
`deploy/ansible/`: roles base / docker / cipheroom, + certs for LiveKit TURN) run the same compose file there. Rules:
- Secrets: `deploy/.env` + `deploy/.env.hetzner` overlay (only differing keys), merged by Ansible with `no_log`;
  `HCLOUD_TOKEN` only from the environment. Never print values in tasks or scripts.
- The server needs **its own tunnel** (own `TUNNEL_TOKEN` + `PUBLIC_HOST`): two stacks behind one token split rooms.
- Observability is on by default on the server (`deploy.sh --no-observability` removes it, volumes stay).
- Deploys verify `https://PUBLIC_HOST/` through the tunnel (`up --wait` alone misses a crash-looping cloudflared) and
  record good tags in `/opt/cipheroom/deployed-tags` (current + previous, kept for rollback).
- New compose services that the server needs: nothing to add if they're in the compose file; files they mount must be
  copied by the `cipheroom` role. The mode is `cipheroom_media_mode`, taken from `MEDIA_MODE` in the merged `.env`.
- Validate: `scripts/lint.sh` (terraform validate, ansible syntax/lint, shellcheck). Guide: `docs/deployment-hetzner.md`.

## Commands
- `scripts/secrets.sh` — create `deploy/.env` from example, list required values that are still empty
- `scripts/up.sh [--tunnel] [--observability]` (also removes containers of services that were dropped; refuses
  `--observability` without `GRAFANA_ADMIN_PASSWORD`), `scripts/down.sh`, `scripts/logs.sh [service]`
- Observability env: `GRAFANA_ADMIN_PASSWORD`, `TELEMETRY_SECRET` (generated by `scripts/secrets.sh`),
  `CF_ACCOUNT_ID`, `CF_ANALYTICS_API_TOKEN`; the api exports only when up.sh sets `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Docker Desktop: cAdvisor needs `/var/run/docker.sock` and `/run/containerd/containerd.sock` mounted explicitly
  (`/var/run` resolves to macOS).
- `scripts/dev.sh` — api + Angular natively, media via a local LiveKit container; `--cloudflare` uses the SFU/TURN
  credentials from `deploy/.env` instead
- Validate: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env config`
