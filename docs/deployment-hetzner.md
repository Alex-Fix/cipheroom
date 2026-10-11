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

- Deployment mode: **Cloudflare** (the only one so far) — Cloudflare Tunnel for HTTPS/WSS, Cloudflare Realtime SFU
  and TURN for media. The server's public IP serves nothing; only SSH is open, and only to the addresses you allow.
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
   starts LiveKit and checks the site through the tunnel.

The certificate renews at 04:30 UTC (systemd timer `cipheroom-cert-renew`); LiveKit restarts only when it changed.
Back to Cloudflare: `MEDIA_MODE=cloudflare` (or remove it) in `deploy/.env.hetzner`, `scripts/provision.sh` (closes the
ports), `scripts/deploy.sh` (stops LiveKit). Try it locally first: `scripts/dev.sh` (LiveKit is the dev default).

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
| Hetzner firewall | inbound 22/tcp from `allowed_ssh_cidrs` only (never `0.0.0.0/0`); everything else dropped |
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

Then delete the server's tunnel in Cloudflare Zero Trust if you don't need it any more. Terraform's state
(`deploy/terraform/hetzner/terraform.tfstate`) lives only on your machine; keep it while the server exists.

## Files

| Path | What |
|---|---|
| `.github/workflows/images.yml` | builds and publishes the images (`sha-<commit>`, `main`, release tags) |
| `deploy/terraform/hetzner/` | server, firewall, SSH key, cloud-init; `terraform.tfvars.example` |
| `deploy/ansible/site.yml` | playbook: roles `base`, `docker`, `cipheroom` (includes `certs` for LiveKit TURN); the media mode comes from `MEDIA_MODE` in `.env` |
| `deploy/.env.hetzner.example` | template for the server's own keys (tunnel, hostname) |
| `scripts/provision.sh` | Terraform wrapper (`--destroy`) |
| `scripts/deploy.sh` | Ansible wrapper (`--tag`, `--no-observability`, `--yes`) |
