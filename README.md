# Cipheroom

Self-hosted, open-source video calls with end-to-end encrypted media. It runs on a home machine with no public IP
and costs nothing to run: a .NET 10 + SignalR API, an Angular frontend, the LiveKit SFU, Cloudflare Tunnel for
ingress and Cloudflare Realtime TURN for media relay.

> **Status:** connectivity spike. Calls work, but **E2EE is not enabled yet** (see `docs/architecture.md`).

## Local development

```bash
scripts/doctor.sh      # check toolchain
scripts/dev.sh         # LiveKit (docker) + API :5080 + Angular :4200
```
Open http://localhost:4200 in two browser windows and join the same room.

## Self-host (home, no public IP)

1. `scripts/secrets.sh`. This creates `deploy/.env` and generates the LiveKit key/secret.
2. Cloudflare dashboard:
   - **Realtime → TURN**: create a key and put `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` in `deploy/.env`.
   - **Zero Trust → Networks → Tunnels**: create a tunnel (Cloudflared, "Docker" environment) and copy its token into
     `TUNNEL_TOKEN`. Add one public hostname: `cipheroom.alexfix.dev` → service `HTTP` `web:8080`.
3. Check `PUBLIC_HOST` and `LIVEKIT_URL` in `deploy/.env` (default: `cipheroom.alexfix.dev`, `wss://cipheroom.alexfix.dev/livekit`).
4. `scripts/up.sh --tunnel`

### Relay connectivity test (spike #1)
1. Join a room from a laptop, and from a phone on **mobile data** (Wi-Fi off).
2. Open **Diagnostics** in the call. Both directions should show `relay ⇄ …` with the home router's public IP.
3. If the call never connects, run `scripts/logs.sh livekit`. Then see the contingencies in `docs/architecture.md`.

## Docs
- `docs/architecture.md`: components, encryption model, NAT/TURN
- `docs/signaling-protocol.md`: SignalR messages
- `CLAUDE.md` and `.claude/skills/`: conventions for contributors and AI agents
