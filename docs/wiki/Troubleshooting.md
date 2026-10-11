# Troubleshooting

## In a call

- **"This browser can't join encrypted calls."** The browser lacks encoded transforms or Ed25519/X25519 in WebCrypto.
  Update it, or use a current Chrome, Edge, Firefox or Safari. There's no unencrypted fallback, by design.
- **Poor quality or freezing.** Open **More → Connection**. It shows a verdict, the route (direct or through a relay),
  round trip, loss, what you send and what limits it, and encryption health. A "Poor connection" chip in the header
  opens the same view. **Copy report** gives a numbers-only summary to share (computed in your browser, nothing is
  sent anywhere).
- **Can't connect from a strict network** (corporate, hotel): media falls back to TURN. In LiveKit mode, TURN over TLS
  on 443 needs `LIVEKIT_TURN_DOMAIN` set (see [[Media modes]]).
- **Video got worse late in the month** (Cloudflare mode): the usage guard is saving the free tier. It caps quality at
  80%, goes audio-only at 95% and pauses at 99%. Grafana shows the numbers.
- **Someone's name shows a warning**: a contact you verified joined with a different key. Compare the safety code
  out loud before trusting them.

## At home

- **Site doesn't load:** `scripts/logs.sh cloudflared`. A bad `TUNNEL_TOKEN` makes it crash-loop. The tunnel's public
  hostname must point to **HTTP** `web:8080`.
- **Calls connect for some people only:** check that `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` are set; test with
  `TURN_FORCE_RELAY=true`.
- **Logs:** `scripts/logs.sh api` (or `web`, `livekit`, `grafana`, …). The api's logs never contain keys, names, SDP or IPs.

## On a Hetzner server

- **`provision.sh` / `deploy.sh` can't reach SSH:** your IP changed. Re-run `scripts/provision.sh`.
- **`provision.sh` refuses a resize:** Hetzner has no capacity for that type in that location right now. Try later
  or pick another type.
- **"host keys that aren't pinned":** stop. Delete `deploy/ansible/known_hosts` only if you rebuilt the server
  yourself.
- **Deploy failed its checks:** it prints the last log lines and the tag to roll back to
  (`scripts/deploy.sh --tag sha-<previous>`).
- **Logs on the server:**
  `ssh -i ~/.ssh/id_cipheroom cipheroom@<ip>`, then
  `sudo docker compose --project-directory /opt/cipheroom logs -f api`.

More: [`docs/deployment-hetzner.md`](https://github.com/Alex-Fix/cipheroom/blob/main/docs/deployment-hetzner.md).
