# Direct ingress (fully self-hosted mode) — design
Status: approved · Date: 2026-10-14

## Problem

Deployment mode 3 is the last unchecked roadmap item: run Cipheroom with **no Cloudflare dependency at all**. Today
even LiveKit mode needs a Cloudflare Tunnel (website + SignalR) and, for TURN over TLS, a domain whose DNS is at
Cloudflare. We want a server that answers HTTPS itself on its public IP — without a domain.

## Goals / Non-goals

Goals
- `INGRESS_MODE=direct` (with `MEDIA_MODE=livekit`): the app is served at `https://<public-ip>` with a Let's Encrypt
  **IP address certificate** (short-lived profile, 160 h), renewed automatically.
- TCP 443 shared by the website and LiveKit's TURN over TLS on one IPv4, split by ALPN.
- First-class on Hetzner via `provision.sh` / `deploy.sh`, which learn **named servers** so the current beta (tunnel +
  LiveKit) and a new `direct` server run side by side, permanently.
- The compose stack stays generic: `scripts/up.sh --direct` plus a guide for any Linux box with a public IP.

Non-goals
- Domains in direct mode (tunnel mode already covers domains); DNS-01 for IP certificates (impossible).
- IPv6 in the certificate (operator network has no IPv6; revisit later).
- Direct mode with `MEDIA_MODE=cloudflare` (refused — the point is no Cloudflare).
- Alerts (dashboards only, as decided for observability); fail2ban beyond SSH.
- Moving or replacing the existing beta.

## Constraints check

| Constraint | Answer |
|---|---|
| E2EE invariant | Unchanged. `edge` sees only TLS and opaque TURN (SRTP + our frame encryption); keys never leave browsers |
| $0 running cost | Knowingly relaxed (opt-in Hetzner path, second server billed while it exists). Primary IP free while assigned. Default home mode stays $0 |
| No public IP | Knowingly relaxed — this *is* the public-IP mode. Inbound: 80, 443/tcp; 7881/tcp, 7882/udp, 3478/udp, 30000–30100/udp |
| Self-hostable + open source | nginx, certbot, LiveKit, Let's Encrypt. No closed SDK or SaaS |
| Untrusted server | Same as tunnel + LiveKit. New: no Cloudflare edge in front (no DDoS absorption, direct scanning) → connection/rate limits in `edge` |
| Browser support | Needs the spike: TURN-TLS to an IP certificate with no SNI and no ALPN in Chrome, Safari, Firefox. HSTS is ignored for IP literals (harmless) |
| Signaling | No hub/protocol changes. Possibly an ICE-server rewrite in the api's LiveKit relay (see Design §2) — not a contract change |

## Chosen approach

**A new `edge` nginx service (compose profile `direct`) + certbot webroot renewal on a systemd timer.** It reuses the
tools and hardening we already have; the `web` image is unchanged.

- Why not Caddy + `layer4`: automatic IP certs are nice, but layer4 isn't in stock Caddy → we'd build and publish our
  own image and maintain a second web-server config next to the hardened nginx.
- Why not TURN-TLS on another port (5349): loses exactly the "only 443 allowed" networks TURN-TLS exists for. Kept as
  the fallback if the spike fails.
- Why not a second IPv4: costs money, needs a second certificate, doesn't help a home box with one IP.
- Why not switch the beta: the user chose a new server; the beta keeps running on the tunnel.
- Named servers: each gets its own SSH key (`~/.ssh/id_cipheroom-<name>`) — Hetzner refuses one key twice per project.

## Design

### 1. Operator flow

Hetzner:
1. `deploy/.env.hetzner.direct`: `INGRESS_MODE=direct`, `MEDIA_MODE=livekit`, `HCLOUD_READ_TOKEN`
   (`LIVEKIT_API_KEY/SECRET` come from `deploy/.env` as today).
2. `scripts/provision.sh --server direct`: Terraform workspace `direct`, server `cipheroom-direct` (cx23; cpx22 when
   Hetzner has no cx capacity), firewall with 80/443 + LiveKit ports, IPv4 as a managed `hcloud_primary_ip`
   (`auto_delete = false`, so re-provisioning keeps the IP and the origin). Writes `inventory.direct.ini`,
   `known_hosts.direct`; `PUBLIC_HOST` = the IPv4.
3. `scripts/deploy.sh --server direct`: writes `edge.conf` and `livekit.yaml` (TURN with `external_tls`, domain = IP),
   issues the first certificate (§3), starts `api`, `web`, `livekit`, `edge` (no `cloudflared`, no `TUNNEL_TOKEN`),
   then verifies `https://<ip>/` **with strict certificate validation**.

Anywhere else: `scripts/up.sh --direct` on a Linux box with a public IP and these ports forwarded; the guide gives the
certbot steps. A dynamic home IP makes this mode impractical (new IP = new certificate and new origin) — the docs say
so and point to tunnel mode.

Settings: `INGRESS_MODE=tunnel` (default, today) | `direct`. `direct` requires `MEDIA_MODE=livekit`; `up.sh` and
Ansible refuse otherwise. In direct mode LiveKit no longer publishes host 443 (a compose variable for that binding);
only `edge` does.

### 1a. Named servers

- `--server <name>` on `provision.sh` / `deploy.sh`; default `default` = today's beta, so nothing migrates (the
  existing local state is Terraform's `default` workspace).
- Per name: Terraform workspace `<name>`, `terraform.<name>.tfvars` (default keeps `terraform.tfvars`),
  `deploy/.env.hetzner.<name>` (default keeps `.env.hetzner`), `deploy/ansible/inventory.<name>.ini`,
  `known_hosts.<name>` — all gitignored. Resources are already named from `var.name`.
- Primary IP resource only when `ingress_mode = "direct"` → the beta's plan stays empty.
- The "one tunnel per deployment" check runs only for tunnel-mode servers.
- Usage guard: each server reads its own Hetzner traffic (`HETZNER_SERVER_ID` from that server's Terraform output).

### 2. The `edge` service

Stock `nginx` pinned by digest, profile `direct`, `cap_drop: ALL` + `no-new-privileges`, unprivileged ports inside
(8080→80, 8443→443), `default` network only (no route to telemetry networks). Config `deploy/nginx/edge.conf`:

```
Browser ──TCP 443──▶ edge stream (ssl_preread)
                       ├─ ALPN offered (h2/http1.1) ─▶ TLS ─▶ edge http ─▶ web:8080 ─▶ api (/hubs, /api)
                       └─ no ALPN (WebRTC TURN-TLS)  ─▶ TLS ─▶ livekit:5349 (plain TCP TURN, external_tls)
Browser ──TCP 80───▶ edge: /.well-known/acme-challenge/ only, everything else 301 → https
Browser ──UDP 7882 / TCP 7881 / UDP 3478 / UDP 30000-30100──▶ livekit (unchanged)
```

- `stream`: `map $ssl_preread_alpn_protocols` → empty = TURN upstream, else HTTPS upstream; both are local `ssl`
  listeners reached via `proxy_protocol` (real client address preserved); `limit_conn` per client IP.
- HTTPS server: TLS 1.2+ (Mozilla intermediate), session tickets off, proxies everything to `web:8080` with WebSocket
  upgrade for `/hubs/`; **overwrites** `CF-Connecting-IP` and `X-Forwarded-For` with the real address (the web
  nginx's Grafana login limit keeps working and can't be spoofed); `limit_req` on `/api/` and the `/hubs/` handshake.
- TURN server: terminates TLS with the same certificate, plain TCP to `livekit:5349` (`turn.external_tls: true`,
  `tls_port: 5349`, not published). LiveKit never holds the certificate.
- `server_tokens off`; access logs off (no visitor addresses on disk).
- `web`'s headers (CSP, Permissions-Policy, HSTS) are unchanged.
- api: `AllowedHosts = <ip>;localhost` (already derived from `PUBLIC_HOST`). No C# change expected; if LiveKit doesn't
  advertise `turns:<ip>:443?transport=tcp` for an IP `turn.domain`, the api's LiveKit relay rewrites the ICE servers
  in the join response (small, tested).

Fallback if the ALPN split fails the spike: TURN-TLS on 5349 (published by LiveKit, opened by Terraform), `edge` keeps
443 for HTTPS only, docs say HTTPS-only networks lose the relay.

### 3. Certificates

- One certificate, IPv4 only: certbot (the pinned 5.8.0 image) `certonly --cert-name cipheroom
  --preferred-profile shortlived --ip-address <ip> --webroot -w /acme-webroot --register-unsafely-without-email`
  (Let's Encrypt no longer sends expiry mails). `letsencrypt` volume / dir, `acme-webroot` volume shared with `edge`.
- First issuance: no cert yet → write a **self-signed placeholder** to the paths `edge` reads (`/tls/fullchain.pem`,
  `/tls/privkey.pem`), start `edge`, run certbot, the deploy hook copies the real cert over the placeholder and reloads
  `edge`. The strict final check means a placeholder never passes as deployed.
- Renewal: systemd timer `cipheroom-cert-renew` every 12 h (`RandomizedDelaySec=1h`) → `certbot renew` (renews around
  half-life and follows ARI) → deploy hook: copy, `docker compose exec edge nginx -s reload` (graceful; calls and TURN
  connections survive), write `cipheroom_cert_expiry_seconds` to node-exporter's textfile collector.
- Lives in the `certs` role as a second path chosen by `INGRESS_MODE`; tunnel + LiveKit keeps its DNS-01 path.
- `deploy.sh` warns when the live certificate expires in under 48 h; a cert-expiry panel goes on the server dashboard.

### 4. Failure modes

| Situation | What happens |
|---|---|
| Port 80 blocked / not forwarded | First issuance fails; deploy stops with a clear message; placeholder never accepted |
| Renewal keeps failing | ~3 days of slack (≈6 attempts); visible on the dashboard and in `deploy.sh`; after expiry browsers block the site |
| `edge` restarts | Media continues over UDP; SignalR and TURN-TLS users reconnect via existing auto-rejoin |
| A browser rejects TURN-TLS to an IP (Firefox always) | Only the TCP-443 relay path is lost; diagnostics drawer shows the route |
| `direct` with `MEDIA_MODE=cloudflare` | `up.sh` / Ansible refuse |
| No ALPN from a non-browser HTTPS client | Lands on LiveKit TURN, which drops non-TURN traffic; documented |
| Server IP changes (home) | New certificate and new origin (contacts reset); docs recommend tunnel mode for dynamic IPs |

## Protocol changes

None. If the ICE rewrite is needed it changes the content the api relays from LiveKit, not hub methods or events.

## Security notes

- Keys, plaintext media and chat never reach `edge`, LiveKit or the api — e2ee-media checklist unaffected.
- Lost: Cloudflare's edge shielding. Gained: Cloudflare no longer sees visitors or metadata.
- New exposure: 80/443 directly on the internet → `limit_conn`, `limit_req`, TLS 1.2+,
  `edge` isolated from telemetry networks, hardened container.
- Client-address headers are set only by `edge` (overwritten, never passed through); api trusts forwarded headers
  only from the compose network as today.
- IP certificates appear in CT logs (the IP is publicly listed as serving HTTPS) — expected for this mode.
- Secrets: nothing new; `.env.hetzner.<name>` follows the existing rules (gitignored, root-owned 600 on the server).
- After rollout: `scripts/security-check.sh https://<ip>` and a `security-audit` pass on the new server (outside nmap:
  only the listed ports open).

## Testing

Spike first, on the new `direct` server (scripts in `artifacts/e2e/spikes/direct/`, staging certificates first):
1. certbot 5.8.0 issues the IP certificate by webroot behind `edge` (staging, then production).
2. Chrome, Safari (WebKit), Firefox load `https://<ip>`; camera works (secure context).
3. With only TCP 443 allowed (forced relay + client firewall blocking UDP and other ports), each browser connects over
   TURN-TLS through the ALPN split with the IP certificate validated; the Connection drawer shows a TLS relay.
4. LiveKit advertises `turns:<ip>:443?transport=tcp` with an IP `turn.domain` — or the api rewrite is needed.
5. `nginx -s reload` during a call drops nothing.
If 3 fails in any browser → 5349 fallback, recorded in this doc.

### Spike results (local, 2026-10-14)

`artifacts/e2e/spikes/direct/` (compose: the real `edge.conf` + a coturn stand-in for LiveKit's plain TCP TURN +
a self-signed IP certificate; `turn.mjs` = two relay-only peer connections with only `turns:<ip>:443`). The split
logs `$ssl_preread_alpn_protocols` per connection.

| Browser | ALPN on TURN-TLS | Split | Result |
|---|---|---|---|
| Chromium | none | → TURN | relay over TLS through :443 connects (`relayProtocol: tls`) |
| WebKit | none | → TURN | TLS handshake runs, then the self-signed certificate is refused (as against coturn's own TLS) — confirm with the real certificate on the server |
| Firefox | — | never connects | **drops `turns:` URLs with an IP address** before ICE ("No TURN servers specified"); with a hostname it does try. UDP and plain TCP TURN work |
| Browsers' HTTPS | `h2,http/1.1` | → HTTPS | site loads over HTTP/2; `curl` too |

Decision (user): **accept and document** the Firefox limit — in direct mode Firefox keeps direct UDP, ICE-TCP 7881
and TURN/UDP 3478, and fails only on networks that allow nothing but HTTPS. No domain, no wildcard DNS. Still to
confirm on the server: WebKit with the Let's Encrypt IP certificate, LiveKit advertising `turns:<ip>:443`.

Also dropped during implementation: the `444` default server (the site is addressed by IP; the api's `AllowedHosts`
already rejects foreign hosts).

Automated: `scripts/lint.sh` gains `nginx -t` on `edge.conf` (in a container) and compose config with
`--profile direct`; terraform validate / ansible-lint / shellcheck as today. Backend tests only if the ICE rewrite is
needed (unit + a functional test that the relayed join carries `turns:<ip>`). E2E against `https://<ip>` with the
existing scripts (fake media only): 3-person call with codec rejoins, files 20/100 MB, mixed Chromium + WebKit,
forced relay. The beta gets a regression run after the named-servers change (its plan must be empty).

## Open questions

- Server type for `direct`: cx23 if available, else cpx22 — decided at provision time.
- IPv6 in the certificate / an IPv6 origin — later, if wanted.
- If the spike shows LiveKit refusing an IP as `turn.domain`, rewrite in the api vs a LiveKit config workaround.

## Implementation steps

1. **Spike** (no repo changes except `artifacts/`): provision the `direct` server by hand from a branch, run spike
   items 1–5, record results in this doc.
2. **Named servers**: `--server <name>` in `provision.sh` / `deploy.sh`, Terraform workspaces, per-name tfvars /
   overlay / inventory / known_hosts, `.gitignore`; beta (`default`) plan stays empty.
3. **Terraform**: `ingress_mode` variable, 80/443 firewall rules, `hcloud_primary_ip` (direct only); outputs.
4. **Compose + edge**: `edge` service (profile `direct`), `deploy/nginx/edge.conf`, variable LiveKit 443 binding,
   `livekit.yaml` TURN `external_tls`; lint (`nginx -t`, compose config).
5. **Certificates**: `certs` role IP path (placeholder, webroot issuance, 12 h timer, deploy hook, textfile metric);
   `deploy.sh` expiry warning.
6. **Ansible mode**: `INGRESS_MODE` checks (direct ⇒ livekit, no tunnel token required), skip `cloudflared`, strict
   `https://<ip>` verification.
7. **api (only if needed)**: ICE server rewrite in the LiveKit relay + tests.
8. **`up.sh --direct`** for generic hosts.
9. **Observability**: cert-expiry panel (generated dashboard).
10. **Docs**: `docs/deployment-hetzner.md` (direct mode, named servers), README roadmap tick + wording,
    `docs/architecture.md`, `CLAUDE.md`, `docker-deploy` skill, `.env.hetzner.example`; wiki re-sync.
11. **Rollout**: `provision.sh --server direct`, `deploy.sh --server direct`, E2E, `security-check.sh`, audit pass.
