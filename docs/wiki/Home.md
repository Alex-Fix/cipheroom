# Cipheroom

**Self-hosted, open-source video calls that your own server can't watch.**

Cipheroom is a Zoom / Telegram-style video calling app that you run yourself. Audio, video, chat and files are
**end-to-end encrypted** in the browser: the server you run, Cloudflare's media servers and the TURN relays only ever
carry ciphertext. It runs on a home computer with **no public IP and no running cost**, or on a rented server if you
prefer.

> **Early development.** The encryption is our own design on standard WebCrypto primitives and hasn't been
> independently audited. Compare the in-call safety code out loud when it matters.

## Pages

| Page | For |
|---|---|
| [[Self-hosting]] | Running it at home: Cloudflare account, tunnel, `deploy/.env`, start, the free-tier usage guard |
| [[Hetzner deployment]] | Running the same stack on a rented Hetzner server with Terraform and Ansible |
| [[Media modes]] | Cloudflare Realtime vs. self-hosted LiveKit: when to use which, ports, cost |
| [[Security model]] | What's encrypted, what servers can still see, safety codes, and the latest security audit |
| [[Development]] | Toolchain, local calls, tests, lint, how changes are designed |
| [[Troubleshooting]] | Calls that won't connect, poor quality, logs, deploy problems |

## In one picture

```
Browser ──HTTPS/WSS──▶ Cloudflare Tunnel ──▶ nginx ──▶ .NET api (SignalR: rooms, lobby, key envelopes, negotiation)
   │                                                    │
   └── media (WebRTC, encrypted frames) ──▶ SFU: Cloudflare Realtime or LiveKit on your server
```

The full technical picture is in [`docs/architecture.md`](https://github.com/Alex-Fix/cipheroom/blob/main/docs/architecture.md).
