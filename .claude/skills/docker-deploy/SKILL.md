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

## Usage guard (planned)
SFU and TURN share **1,000 GB/month** of free egress (traffic from Cloudflare to clients); 4K video is ~3.6 GB per
viewer-hour. Limits go in `REALTIME_MONTHLY_SOFT_LIMIT_GB` / `REALTIME_MONTHLY_HARD_LIMIT_GB`; the guard itself isn't
built yet. Until then keep a Cloudflare billing notification on. Don't add paid services or rented VMs without
approval.

## Commands
- `scripts/secrets.sh` — create `deploy/.env` from example, list required values that are still empty
- `scripts/up.sh [--tunnel]` (also removes containers of services that were dropped), `scripts/down.sh`,
  `scripts/logs.sh [api|web|cloudflared]`
- `scripts/dev.sh` — api + Angular natively, SFU/TURN credentials read from `deploy/.env`
- Validate: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env config`
