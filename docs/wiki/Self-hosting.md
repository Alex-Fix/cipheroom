# Self-hosting at home

The default way to run Cipheroom: on any machine with Docker, at home, **without port forwarding or a public IP**, and
on free tiers only. People reach it through a Cloudflare Tunnel; media flows between browsers and Cloudflare's edge, so
nothing at home needs to be reachable.

## What you need

- A domain on Cloudflare (the free plan is fine).
- A machine that stays on, with Docker.
- A clone of the repository. `scripts/doctor.sh` checks your tools.

## Setup

1. **`deploy/.env`**: run `scripts/secrets.sh`. It creates the file (mode 600, never committed) and lists the values
   that are still missing.
2. **Cloudflare Realtime SFU**: Dashboard → Realtime → SFU → Create application. Put the app ID and secret into
   `CF_SFU_APP_ID` / `CF_SFU_APP_SECRET`.
3. **Cloudflare TURN** (fallback for strict networks): Dashboard → Realtime → TURN Server → Create. Put the values into
   `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN`.
4. **Tunnel**: Zero Trust → Networks → Tunnels → Create (Cloudflared). Put the token into `TUNNEL_TOKEN`, and add one
   public hostname such as `call.example.com` → **HTTP** `web:8080`. Use a *first-level* subdomain: the free
   certificate doesn't cover `a.b.example.com`.
5. Set `PUBLIC_HOST=call.example.com`.
6. **Start and check**:
   ```bash
   scripts/up.sh --tunnel
   scripts/security-check.sh https://call.example.com
   ```

In Cloudflare, also set SSL/TLS to **Full**, turn on **Always Use HTTPS**, and set minimum TLS to 1.2. You can turn
on HSTS there too; nginx already sends it.

## Staying free: the usage guard

Cloudflare Realtime (SFU and TURN together) is free up to 1 TB of traffic a month. The usage guard keeps you inside
it: video quality is capped at 80% of the month's allowance, calls go audio-only at 95%, and they pause at 99% until
the month resets. With `CF_ACCOUNT_ID` and `CF_ANALYTICS_API_TOKEN` (a read-only analytics token), it uses
Cloudflare's own account-wide figure instead of its estimate. Keep a Cloudflare billing notification as a second
safety net. For scale: 4K video is roughly 3.6 GB per viewer-hour.

## Day to day

| Command | What it does |
|---|---|
| `scripts/up.sh [--tunnel \| --direct] [--observability]` | Build and start; `--observability` adds Grafana at `/grafana/`; `--direct` serves `https://<public IP>` without Cloudflare (LiveKit mode, a static public IP, then `scripts/ip-cert.sh`) |
| `scripts/down.sh` | Stop everything |
| `scripts/logs.sh [service]` | Follow logs |
| `scripts/security-check.sh [url]` | Secrets, `.env` hygiene, dependency advisories, live headers |

Observability is optional: pseudonymous traces, logs, metrics and call-quality numbers, kept 7 days, behind Grafana's
login. See [`docs/observability.md`](https://github.com/Alex-Fix/cipheroom/blob/main/docs/observability.md).

No machine at home to leave running? See [[Hetzner deployment]].
