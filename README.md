# Cipheroom

**Self-hosted, open-source video calls that your own server can't watch.**

Cipheroom is a Zoom / Telegram-style video calling app you run on your own machine. It's built for people who
want private calls without trusting a vendor, and it runs on a home computer with **no public IP and zero running cost**.

> [!WARNING]
> **Status: early development.** Calls work end to end, but **end-to-end encryption is not enabled yet**: media is
> protected in transit (DTLS-SRTP) but the media server can technically see it. Don't use Cipheroom for anything
> sensitive until E2EE lands. See the [roadmap](#roadmap).

## Features

- 🎥 Group video and audio calls via the [LiveKit](https://livekit.io) SFU (simulcast, adaptive quality)
- 🖥️ Screen sharing
- 🏠 Runs at home behind NAT: ingress via Cloudflare Tunnel, media via Cloudflare Realtime TURN
- 💸 Free to run: uses only free tiers, with a usage guard planned to keep you inside them
- 🔍 Built-in connection diagnostics (see whether media goes direct or via relay)
- 🔐 *(in progress)* End-to-end encryption that no server can break, with verifiable safety codes

## How it works

```
Browser ──HTTPS/WSS──▶ Cloudflare Tunnel ──▶ nginx ─┬─▶ .NET API (SignalR: rooms, keys, chat)
   │                                               └─▶ LiveKit (signaling, /livekit)
   └──media (UDP/TCP/TLS)──▶ Cloudflare TURN ◀──outbound── LiveKit (at home)
```

| Component | Tech |
|---|---|
| Backend | .NET 10, ASP.NET Core, SignalR |
| Frontend | Angular 22, `livekit-client` |
| Media server | LiveKit (self-hosted container) |
| Ingress | Cloudflare Tunnel (`cloudflared`) on one hostname |
| NAT traversal | Cloudflare Realtime TURN (free 1 TB/month) |
| Runtime | Docker Compose |

**Privacy model:** the API, LiveKit and the TURN relay are all treated as untrusted. With E2EE, every participant
encrypts media in the browser with keys exchanged as signed, encrypted envelopes. Servers only relay ciphertext.
Metadata (who, when, IP addresses) remains visible to the servers and Cloudflare. Details:
[`docs/architecture.md`](docs/architecture.md).

## Quick start (local development)

Requirements: .NET 10 SDK, Node.js (LTS), Docker.

```bash
scripts/doctor.sh      # check your toolchain
scripts/dev.sh         # LiveKit (Docker) + API on :5080 + Angular on :4200
```

Open http://localhost:4200 in two browser windows and join the same room.

## Self-hosting

You need a domain on Cloudflare (the free plan is fine) and a machine running Docker. No port forwarding.

1. **Generate secrets**
   ```bash
   scripts/secrets.sh     # creates deploy/.env and a LiveKit key/secret
   ```
2. **Cloudflare TURN**: Dashboard → Realtime → TURN Server → Create. Put the key ID and API token into
   `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` in `deploy/.env`.
3. **Cloudflare Tunnel**: Zero Trust → Networks → Tunnels → Create (Cloudflared, Docker).
   - Put the token into `TUNNEL_TOKEN`.
   - Add one public hostname, e.g. `call.example.com` → **HTTP** `web:8080`.
   - Use a *first-level* subdomain: the free Universal SSL certificate doesn't cover `a.b.example.com`.
4. **Hostname**: set `PUBLIC_HOST=call.example.com` and `LIVEKIT_URL=wss://call.example.com/livekit` in `deploy/.env`.
5. **Start**
   ```bash
   scripts/up.sh --tunnel
   scripts/security-check.sh https://call.example.com
   ```

To check it from real networks, join from a phone on mobile data and open **Diagnostics** in the call. Both
directions should show `relay`. If a network can't connect, see the contingencies in
[`docs/architecture.md`](docs/architecture.md#nat--turn--free-no-public-ip).

### Operations

| Command | What it does |
|---|---|
| `scripts/up.sh [--tunnel]` | Build and start the stack |
| `scripts/down.sh` | Stop everything |
| `scripts/logs.sh [service]` | Follow logs (`api`, `web`, `livekit`, `cloudflared`) |
| `scripts/test.sh [--server\|--web]` | Run tests |
| `scripts/lint.sh [--fix]` | Formatting and lint |
| `scripts/security-check.sh [url]` | Secret scan, dependency audit, security headers |
| `scripts/secrets.sh [--force]` | Generate (or rotate) LiveKit credentials |

## Roadmap

- [x] Group calls through LiveKit with Cloudflare TURN relay (no public IP)
- [x] Single-hostname deployment via Cloudflare Tunnel
- [ ] **End-to-end encryption**: device identities, sender keys, rotation on join/leave, safety codes
- [ ] Lobby and host admission
- [ ] End-to-end encrypted chat
- [ ] TURN usage guard (stay inside the free tier)
- [ ] "Source" link in the UI (AGPL §13)
- [ ] MLS-based group keys for large rooms

## Project layout

```
src/server/   .NET API + tests
web/          Angular app
deploy/       Docker Compose, nginx, LiveKit config
scripts/      dev and ops scripts
docs/         architecture, signaling protocol, design plans
.claude/      Claude Code skills and settings used to develop this project
```

## Contributing

Issues and pull requests are welcome. Before opening a PR:

- `scripts/test.sh` and `scripts/lint.sh` pass
- Protocol changes update C#, TypeScript and [`docs/signaling-protocol.md`](docs/signaling-protocol.md) together
- Nothing sends keys, plaintext media or chat to any server. See [`CLAUDE.md`](CLAUDE.md) for the
  non-negotiable rules.

New features start as a short design in [`docs/plans/`](docs/plans/).

## Security

Please **don't** open public issues for vulnerabilities. Report them privately via GitHub's
"Report a vulnerability" (Security tab) once the repository is public.

## License

Cipheroom is licensed under the [GNU Affero General Public License v3.0](LICENSE).
If you run a modified version as a network service, you must offer its source code to your users.

Third-party components keep their own licenses. Notably, LiveKit is Apache-2.0 and is used as an unmodified container.