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
| Runs as | – | In the server's own network (as LiveKit recommends), so its TURN relay can reach it; media only on the public IP |

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

## Ingress: tunnel or direct

A second setting, `INGRESS_MODE`, decides how browsers reach the website and signaling:

- **`tunnel`** (default): a Cloudflare Tunnel to a hostname you own. Nothing listens for the site on the server.
- **`direct`** (LiveKit mode only): no Cloudflare and no domain. The server answers at `https://<its IP>` with a free
  Let's Encrypt certificate for the IP address, renewed by itself every few days (port 80 stays open for that check).
  Port 443 carries both the site and TURN over TLS; an `edge` proxy tells them apart.
  Limits: the address *is* the site (browsers keep keys and contacts per address, so keep the IP); Firefox can't use
  TURN over TLS to an IP address; there's no Cloudflare in front to absorb floods.
  Details: [Direct mode](https://github.com/Alex-Fix/cipheroom/blob/main/docs/deployment-hetzner.md#direct-mode-no-cloudflare-no-domain).
