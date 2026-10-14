# Running Cipheroom on a Hetzner server

The default way to run Cipheroom is at home, free, with nothing reachable from the internet (README → Self-hosting).
This guide puts the **same stack** on a rented Hetzner Cloud server instead — useful for a second instance (e.g. a
beta at `cipheroom-beta.alexfix.dev`) or when there's no machine at home to leave running.

Design: [`plans/2026-10-11-iac-hetzner-design.md`](plans/2026-10-11-iac-hetzner-design.md).

## What you get

```
GitHub Actions ──push──▶ GHCR (ghcr.io/alex-fix/cipheroom-api, -web; tagged sha-<commit>)
                              │ pull
Your laptop ── terraform ──▶ Hetzner VM (Ubuntu 26.04, SSH from your IP only)
            ── ansible ────▶   Docker: api, web, cloudflared (+ observability)
                                 │ outbound only
Browser ──HTTPS/WSS──▶ Cloudflare Tunnel ──▶ web ──▶ api ──▶ Cloudflare Realtime SFU / TURN
```

- Deployment mode: **Cloudflare** by default — Cloudflare Tunnel for HTTPS/WSS, Cloudflare Realtime SFU and TURN for
  media. The server's public IP serves nothing; only SSH is open, and only to the addresses you allow. Two opt-in
  modes put more on the server: [LiveKit mode](#livekit-mode-media-on-your-server) (media) and
  [direct mode](#direct-mode-no-cloudflare-no-domain) (everything, no Cloudflare, no domain).
- Several servers side by side: [named servers](#more-than-one-server).
- Terraform (`deploy/terraform/hetzner/`) creates the server, an SSH key and a firewall. Ansible (`deploy/ansible/`)
  hardens the server, installs Docker and runs `deploy/docker-compose.yml` with images built by
  `.github/workflows/images.yml`.

## Before you start

**It costs money.** The default `cpx42` (8 AMD vCPU, 16 GB RAM) plus its IPv4 address is billed by Hetzner while it
exists — check the current figure in Hetzner's price list. Smaller and cheaper types work too (`server_type` in
`terraform.tfvars`, see Resizing): `cx23` (2 vCPU, 4 GB) runs the app and observability for a handful of people. GHCR and GitHub Actions are free for this public repository. Cloudflare Realtime stays inside its free
tier through the usage guard, as at home.

**Know what Hetzner can see.** Hosting the api means Hetzner could observe what the api observes: IP addresses,
timing, pseudonymous room activity. Media, chat, files and keys stay end-to-end encrypted — no server can read them.

**One tunnel per deployment.** If the server and your home stack both run `cloudflared` with the same tunnel token,
Cloudflare balances requests between them. Each api keeps its own in-memory rooms, so people land in different
"copies" of a call and it breaks at random. Give the server its own tunnel (step 3); `scripts/deploy.sh` refuses to
share one unless you confirm.

**One free tier for both.** Home and server draw on the same Cloudflare account's 1 TB/month, but each usage guard
counts only its own estimate. Set `CF_ACCOUNT_ID` and `CF_ANALYTICS_API_TOKEN` (README → Self-hosting) so both use
Cloudflare's account-wide figure.

Tools on your machine: `terraform` and `ansible` (`brew install terraform ansible`; `scripts/doctor.sh` checks) and a
working `deploy/.env` (`scripts/secrets.sh`). The server accepts one SSH key, used only for it: `~/.ssh/id_cipheroom`,
which `scripts/provision.sh` creates on the first run (choose a passphrase; `CIPHEROOM_SSH_KEY` points elsewhere).

## First deploy

1. **Images.** Push to `main`. The *images* workflow (GitHub → Actions) builds `cipheroom-api` and `cipheroom-web`
   and publishes them to GHCR. The first time only: GitHub → your profile → **Packages** → each package → **Package
   settings** → **Change visibility** → **Public**, so the server can pull without credentials.

2. **Hetzner API token.** Hetzner Cloud console → your project → **Security** → **API tokens** → generate one with
   *Read & Write*. Keep it out of files:
   ```bash
   export HCLOUD_TOKEN=…
   ```

3. **A tunnel for the server.** Cloudflare Zero Trust → Networks → Tunnels → **Create** (Cloudflared). Add a public
   hostname, e.g. `cipheroom-beta.alexfix.dev` → **HTTP** `web:8080` (a first-level subdomain, so the free certificate
   covers it). Then:
   ```bash
   cp deploy/.env.hetzner.example deploy/.env.hetzner   # gitignored
   ```
   and put that tunnel's token into `TUNNEL_TOKEN` there. `deploy/.env.hetzner` only lists what differs from
   `deploy/.env`; everything else (SFU and TURN keys, usage guard, …) is taken from `deploy/.env`.

4. **Create the server.**
   ```bash
   scripts/provision.sh
   ```
   Shows Terraform's plan and asks before creating anything. SSH is allowed from this machine's current public IP
   (to allow more, set `allowed_ssh_cidrs` in `deploy/terraform/hetzner/terraform.tfvars` — see the `.example`). It
   writes `deploy/ansible/inventory.ini` and pins the server's SSH host keys in `deploy/ansible/known_hosts` — once per
   server: later runs only check that the server still shows those keys, and stop if not (possibly someone in the
   middle; if you rebuilt the server yourself, delete that file and re-run).

5. **Deploy.**
   ```bash
   scripts/deploy.sh                    # with Grafana; --no-observability for the app only
   ```
   Deploys the images of the last pushed commit that changed the app. Before touching the server it checks that both
   images exist in GHCR and are public. The playbook then hardens the server, installs Docker, copies the compose
   files and the merged `.env` (mode 600, never printed), starts the stack — including the observability stack
   (needs `GRAFANA_ADMIN_PASSWORD`, 12+ characters, in `deploy/.env` or `deploy/.env.hetzner`) — and checks that
   `https://<PUBLIC_HOST>/` answers through the tunnel.

6. **Check it.** Open the hostname, start a meeting, join from a phone on mobile data. Then:
   ```bash
   scripts/security-check.sh https://cipheroom-beta.alexfix.dev
   ```
   For a full audit of the app and the server, see [`security/audits/`](security/audits/README.md) (the
   `security-audit` skill).

## LiveKit mode: media on your server

By default the server uses Cloudflare Realtime for media, like home. With `MEDIA_MODE=livekit` it runs its own
[LiveKit](https://livekit.io) SFU instead (deployment mode 2): media goes from browsers straight to this server's
public IP and never touches Cloudflare; the website and signaling still go through the tunnel — LiveKit's own
signaling is relayed by the api over SignalR, so its port (7880) is never reachable from outside. Encryption is the
same (keys never reach LiveKit). Traffic counts against the server's included 20 TB a month (about €1 per extra TB),
not Cloudflare's 1 TB; with `HCLOUD_READ_TOKEN` set, the usage guard follows that allowance.

1. **(Optional) TURN over TLS** — for networks that allow only HTTPS. In Cloudflare DNS add an **A** record
   `turn-beta` → the server's IPv4 with the proxy **off** (grey cloud: TURN can't go through Cloudflare's proxy).
   Create a Cloudflare API token with only *Zone → DNS → Edit* on `alexfix.dev` (Let's Encrypt's DNS check; port 80
   stays closed).
2. **(Recommended) Usage guard** — Hetzner Cloud console → Security → API tokens → a **Read** token.
3. In `deploy/.env.hetzner`:
   ```
   MEDIA_MODE=livekit
   LIVEKIT_TURN_DOMAIN=turn-beta.alexfix.dev   # only with step 1
   CF_DNS_API_TOKEN=…                          # only with step 1
   HCLOUD_READ_TOKEN=…                         # step 2
   ```
   `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` come from `scripts/secrets.sh` (in `deploy/.env`).
4. `scripts/provision.sh` — opens LiveKit's ports in the Hetzner firewall: `7882/udp` + `7881/tcp` (media), and for
   TURN `3478/udp`, `443/tcp` and the relay ports `30000-30100/udp`. SSH stays restricted to your IP.
5. `scripts/deploy.sh` — writes `livekit.yaml` (with TURN when a domain is set), issues the certificate the first time,
   starts LiveKit and the `edge` proxy, and checks the site through the tunnel.

TURN over TLS on 443 is terminated by `edge` (the same proxy as in direct mode), which holds the certificate and passes
TURN on to LiveKit as plain TCP; LiveKit never handles TLS. The certificate renews at 04:30 UTC (systemd timer
`cipheroom-cert-renew`) and edge reloads it without dropping calls.

LiveKit runs in the server's own network (`network_mode: host`, LiveKit's recommended Docker setup), not behind Docker's
port mapping: its TURN relay has to reach LiveKit's media port at the public IP, and through Docker's mapping those
packets never came back, so calls that needed the relay failed. Its media is limited to the public IP; its API (7880)
listens only on loopback and the `livekit` Docker bridge, and ufw plus the Hetzner firewall keep 7880 and 5349 closed
from outside. Because it shares the host's network, it runs as an unprivileged user (uid 10002, no capabilities), and
ufw rejects new connections from that user to private address ranges: it can't reach the api, Grafana or the
telemetry services (audit SA-2026-10-14-02). `scripts/up.sh` on a machine without Ansible doesn't add that rule.
Check with `artifacts/e2e/repro/relay-tls-e2e.mjs` (`SCHEME=turns` or `turn`): a call whose guests may
only use TURN.
Back to Cloudflare: `MEDIA_MODE=cloudflare` (or remove it) in `deploy/.env.hetzner`, `scripts/provision.sh` (closes the
ports), `scripts/deploy.sh` (stops LiveKit). Try it locally first: `scripts/dev.sh` (LiveKit is the dev default).

## Direct mode: no Cloudflare, no domain

Deployment mode 3: on top of LiveKit mode, the server also serves the website and signaling itself, at
`https://<its IPv4>`, with a free Let's Encrypt certificate **for the IP address** — no domain, no tunnel, nothing at
Cloudflare. Design: [`plans/2026-10-14-direct-ingress-design.md`](plans/2026-10-14-direct-ingress-design.md).

```
Browser ──TCP 443──▶ edge (nginx) ─┬─ HTTPS (browsers offer ALPN) ─▶ web ─▶ api
                                   └─ TURN over TLS (no ALPN)     ─▶ LiveKit TURN (plain TCP inside)
Browser ──TCP 80───▶ edge: Let's Encrypt's check, otherwise a redirect to HTTPS
Browser ──UDP 7882 / TCP 7881 / UDP 3478 / UDP 30000-30100──▶ LiveKit
```

What to know first:
- **The address is the site.** People open `https://49.13.x.x`. Browsers keep device keys, contacts and verified marks
  per address, so the IP must not change: Terraform keeps it as a separate *Primary IP* that survives a rebuilt server
  (`--destroy` deletes it too). Re-provisioning elsewhere = a new address and new contacts for everyone.
- **Certificates live 6 days.** Let's Encrypt issues IP certificates only short-lived (160 hours) and only through the
  HTTP check, so port 80 is open (it answers the check and redirects). A timer renews twice a day from about half-way;
  the host dashboard shows how long is left (orange under 3 days, red under 2), and `deploy.sh` warns under 2 days.
  If renewals fail for ~3 days, browsers refuse the site.
- **Firefox and TURN over TLS.** Port 443 carries TURN over TLS for networks that allow nothing but HTTPS. Chrome and
  Safari use it; Firefox ignores TURN over TLS to an IP address, so Firefox on such a network can't connect (it still
  relays over UDP 3478 everywhere else).
- **HTTPS clients must offer ALPN.** That's how port 443 tells the site from TURN: browsers, curl and most HTTP
  libraries do; a client that doesn't (Ansible's `uri` module, some scanners) lands on TURN and gets no answer.
- **No Cloudflare in front.** Nothing absorbs floods or scans; `edge` limits connections and request rates per
  address. Cloudflare no longer sees who visits.

Set up (here as a second server named `direct`, next to a tunnel-mode one — see [named servers](#more-than-one-server)):

1. `deploy/.env.hetzner.direct`:
   ```
   MEDIA_MODE=livekit
   INGRESS_MODE=direct
   HCLOUD_READ_TOKEN=…        # recommended: the usage guard follows this server's traffic
   ```
   No `TUNNEL_TOKEN`, `PUBLIC_HOST` or `LIVEKIT_TURN_DOMAIN` (the address is the IP).
2. Optional `deploy/terraform/hetzner/terraform.direct.tfvars`, e.g. `server_type = "cx23"` (falls back to the shared
   `terraform.tfvars`, then the defaults).
3. `scripts/provision.sh --server direct` — creates `cipheroom-direct`, its Primary IP and a firewall with 80/443 and
   LiveKit's ports.
4. `scripts/deploy.sh --server direct` — starts the stack with a placeholder certificate, gets Let's Encrypt's through
   port 80, then checks `https://<ip>/` from your machine with full certificate validation.

**Any other Linux machine** with a public IPv4 (a home router can forward the ports, but the address must be static):
set `MEDIA_MODE=livekit` and `LIVEKIT_NODE_IP=<public IPv4>` in `deploy/.env`, forward 80/tcp, 443/tcp, 7881/tcp,
7882/udp, 3478/udp and 30000-30100/udp, then `scripts/up.sh --direct` and `scripts/ip-cert.sh`. Add `ip-cert.sh` to
cron twice a day (the line is in its header).

## More than one server

`scripts/provision.sh` and `scripts/deploy.sh` take `--server <name>`; without it they mean `default`, the first
server, with the file names used everywhere above. Each name has its own:

| What | `default` | `--server <name>` |
|---|---|---|
| Hetzner server, firewall, SSH key entry | `cipheroom` | `cipheroom-<name>` |
| Terraform state | `terraform.tfstate` | workspace `<name>` (`terraform.tfstate.d/<name>/`) |
| Settings over `deploy/.env` | `deploy/.env.hetzner` | `deploy/.env.hetzner.<name>` (required) |
| Terraform variables | `terraform.tfvars` | `terraform.tfvars`, then `terraform.<name>.tfvars` |
| Inventory, pinned host keys | `deploy/ansible/inventory.ini`, `known_hosts` | `inventory.<name>.ini`, `known_hosts.<name>` |
| SSH key | `~/.ssh/id_cipheroom` | `~/.ssh/id_cipheroom-<name>` (Hetzner refuses one key twice) |

Tunnel-mode servers each need their own tunnel; `deploy.sh` compares against home and every other server's file.
All of these files are gitignored.

## Updating and rolling back

```bash
git push                                  # wait for the images workflow to finish
scripts/deploy.sh                         # deploys sha-<that commit>
scripts/deploy.sh --tag sha-<older>       # roll back (any tag still in GHCR)
scripts/deploy.sh --tag main              # the newest build of main
```

The server keeps the images of the current and the previous good deploy, so rolling back one step needs no download.
A deploy that fails its checks says which tag to roll back to and shows the last log lines (no settings).

Re-running `scripts/deploy.sh` is safe: it changes only what differs. Changing a secret = edit `deploy/.env` or
`deploy/.env.hetzner`, run it again.

## Resizing

Set `server_type` in `deploy/terraform/hetzner/terraform.tfvars` and run `scripts/provision.sh`. Hetzner resizes the
same server in place — same IP, same disk contents — after powering it off for a minute or two; containers come back by
themselves.

- **Capacity.** Hetzner sometimes has no room for a type in a location (cheap `cx` types especially). A resize that
  can't be placed fails *after* the server was powered off, so `provision.sh` first asks Hetzner whether the type is
  available there and refuses if not; if Terraform fails anyway, it powers the server back on.
- **Going back down.** `keep_disk = true` (the default) keeps the disk at its size, so any type with at least that disk
  works later. With `keep_disk = false` the disk grows with the type and Hetzner never shrinks it.
- The firewall (`<name>-server`) and everything Ansible set up stay as they are; no `deploy.sh` needed.

## Day to day

- **Security updates** install by themselves; when one needs a reboot the server reboots at 04:30 UTC
  (`base_reboot_time` in `deploy/ansible/group_vars/all.yml`). Containers come back on their own and people in a call
  rejoin automatically.
- **Your IP changed?** SSH (and so `deploy.sh`) can't connect. Run `scripts/provision.sh` again: it updates the
  firewall to your new address.
- **Logs:** `ssh -i ~/.ssh/id_cipheroom cipheroom@<ip>` then `sudo docker compose --project-directory /opt/cipheroom logs -f api`.
  Grafana is at `https://<PUBLIC_HOST>/grafana/` (user `admin`); `--no-observability` removes the telemetry services,
  keeping their data volumes.
- **What's on the server:** `/opt/cipheroom` (compose file, observability config, `.env`, `deployed-tags`) and
  Docker volumes — the usage guard's estimate and, with observability, 7 days of telemetry. No database; nothing
  needs backing up.

## Hardening applied

| Layer | What |
|---|---|
| Hetzner firewall | inbound 22/tcp from `allowed_ssh_cidrs` only (never `0.0.0.0/0`); LiveKit's ports in LiveKit mode, 80/443 in direct mode; everything else dropped |
| SSH | key only, no root, `AllowUsers cipheroom`, no forwarding, fail2ban (5 failures → 1 h ban) |
| Host firewall | ufw: deny incoming, allow 22 (second layer; `web` listens on 127.0.0.1 only) |
| Updates | unattended security upgrades, nightly reboot window |
| Docker | Docker's own apt repo (signing key fingerprint checked), log rotation, admin user not in the `docker` group |
| Secrets | `HCLOUD_TOKEN` from the environment only; `.env` root-owned, mode 600; Ansible never prints values |
| Images | built by CI from the public repository, tagged by commit; deploys pin a tag; the Source link opens that commit |

## Removing the server

```bash
# 1. in deploy/terraform/hetzner/terraform.tfvars:  protection = false
scripts/provision.sh            # applies the change
scripts/provision.sh --destroy  # asks you to type the server name
```

A named server: set `protection = false` in `terraform.<name>.tfvars` and add `--server <name>` to both commands (a
direct-mode server's Primary IP goes too).

Then delete the server's tunnel in Cloudflare Zero Trust if you don't need it any more. Terraform's state
(`deploy/terraform/hetzner/terraform.tfstate`) lives only on your machine; keep it while the server exists.

## Files

| Path | What |
|---|---|
| `.github/workflows/images.yml` | builds and publishes the images (`sha-<commit>`, `main`, release tags) |
| `deploy/terraform/hetzner/` | server, firewall, SSH key, cloud-init; `terraform.tfvars.example` |
| `deploy/ansible/site.yml` | playbook: roles `base`, `docker`, `cipheroom` (includes `certs`: a TURN domain via DNS, or the IP certificate in direct mode); modes from `MEDIA_MODE` and `INGRESS_MODE` in `.env` |
| `deploy/nginx/edge.conf` | direct mode's edge proxy (443 split, TLS, port 80) |
| `scripts/up.sh --direct`, `scripts/ip-cert.sh` | direct mode on a machine without Ansible |
| `deploy/.env.hetzner.example` | template for the server's own keys (tunnel, hostname) |
| `scripts/provision.sh` | Terraform wrapper (`--server`, `--destroy`) |
| `scripts/deploy.sh` | Ansible wrapper (`--server`, `--tag`, `--no-observability`, `--yes`) |
