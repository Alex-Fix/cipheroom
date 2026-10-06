---
name: docker-deploy
description: Docker Compose stack for Cipheroom (api, web/nginx, livekit, cloudflared), env config, Cloudflare Realtime TURN, free-tier usage guard, ports, and Cloudflare Tunnel limits. Use when editing deploy/, Dockerfiles, compose services, or troubleshooting self-hosted deployment.
---

# Deployment

Constraints: **runs at home, no public IP, $0 running cost, no rented VMs.** See `docs/architecture.md` → "NAT / TURN".

## Services (`deploy/docker-compose.yml`)
| Service | Image | Ports | Notes |
|---|---|---|---|
| `api` | `src/Cipheroom.Api/Dockerfile` | 8080 internal | env from `.env` (`LiveKit__*`, `Turn__*`) |
| `web` | `web/Dockerfile` | 8080 internal (`${WEB_PORT}` on host for local) | nginx, proxies `/api` + `/hubs` to api, `/livekit/` to livekit |
| `livekit` | `livekit/livekit-server` | 7880 internal (signaling), `50000-50100/udp`, `7881/tcp` on host | config `deploy/livekit/livekit.yaml`, `LIVEKIT_KEYS="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"` |
| `cloudflared` | `cloudflare/cloudflared` | none | profile `tunnel`; `tunnel run --token ${TUNNEL_TOKEN}` |


## Tunnel hostnames (Cloudflare dashboard → Tunnel → Public hostnames)
- Single hostname `${PUBLIC_HOST}` (cipheroom.alexfix.dev) → `http://web:8080`. nginx routes `/api`, `/hubs` → api and
  `/livekit/` → livekit:7880 (prefix stripped), so `LIVEKIT_URL=wss://${PUBLIC_HOST}/livekit`.
- Keep it a **first-level** subdomain: Cloudflare's free Universal SSL doesn't cover `a.b.alexfix.dev`.
Cloudflare Tunnel does **not** carry media; that's what TURN is for.

## TURN setup
Cloudflare dashboard → Realtime → TURN → create key; put `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` in `.env`.
Clients relay all media via Cloudflare TURN (1 TB/mo free). If the connectivity spike fails, see contingencies in
`docs/architecture.md` — don't add paid services or rented VMs without approval.

## Usage guard
api tracks monthly relay usage from LiveKit webhooks; `TURN_MONTHLY_SOFT_LIMIT_GB` / `TURN_MONTHLY_HARD_LIMIT_GB`.
Also enable Cloudflare billing notifications.

## Docker Desktop on macOS
Publish LiveKit UDP range explicitly (no host networking). Keep the range small (100 ports) — Docker Desktop
is slow with large UDP ranges.

## Commands
- `scripts/secrets.sh` — create `deploy/.env` from example, generate LiveKit key/secret
- `scripts/up.sh [--tunnel]`, `scripts/down.sh`, `scripts/logs.sh livekit`
- Validate: `docker compose -f deploy/docker-compose.yml config`
