# Media modes

One setting, `MEDIA_MODE` in `deploy/.env` (or `deploy/.env.hetzner`), picks the media server for a deployment.
Encryption is identical in both modes: frames are encrypted in the browser, and the media server never gets a key.

| | **Cloudflare** (default) | **LiveKit** |
|---|---|---|
| Media server | Cloudflare Realtime SFU | [LiveKit](https://livekit.io), self-hosted on the same machine |
| Needs a public IP | No: works at home behind NAT/CGNAT | Yes, so a rented server (or open ports at home) |
| TURN | Cloudflare TURN | LiveKit's built-in TURN (optionally TLS on 443 with a Let's Encrypt certificate) |
| Traffic limit | Cloudflare's free 1 TB/month, enforced by the usage guard | The server's own allowance (on Hetzner, 20 TB/month included) |
| Who sees media metadata | Cloudflare | Only your server |
| Signaling | The api relays negotiation to Cloudflare over HTTPS | LiveKit's signaling is relayed by the api over SignalR; its port 7880 is never public |

## When to use which

- **At home, free:** Cloudflare. Nothing to open, no server to rent.
- **On a rented server, or to keep media off Cloudflare:** LiveKit. On Hetzner, `provision.sh` opens the ports
  (`7882/udp`, `7881/tcp`, and for TURN `3478/udp`, `443/tcp`, `30000-30100/udp`) and `deploy.sh` writes LiveKit's
  configuration and certificate. Details:
  [LiveKit mode](https://github.com/Alex-Fix/cipheroom/blob/main/docs/deployment-hetzner.md#livekit-mode-media-on-your-server).
- **Development:** `scripts/dev.sh` uses a local LiveKit container with throwaway keys by default;
  `scripts/dev.sh --cloudflare` uses your Cloudflare credentials.

Switching is a settings change plus `provision.sh` and `deploy.sh` on a server, or `up.sh` at home. No data needs
migrating: rooms live in memory only.
