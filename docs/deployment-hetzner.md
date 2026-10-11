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

**It costs money.** A `cx23` (2 vCPU, 4 GB RAM) plus its IPv4 address is about €4–5 a month while it exists, billed
by Hetzner. GHCR and GitHub Actions are free for this public repository. Cloudflare Realtime stays inside its free
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

Tools on your machine: `terraform` and `ansible` (`brew install terraform ansible`; `scripts/doctor.sh` checks), an SSH
key (`~/.ssh/id_ed25519.pub` by default) and a working `deploy/.env` (`scripts/secrets.sh`).

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
   writes `deploy/ansible/inventory.ini` and pins the server's SSH host keys in `deploy/ansible/known_hosts`.

5. **Deploy.**
   ```bash
   scripts/deploy.sh                    # or: scripts/deploy.sh --observability
   ```
   Deploys the images of the last pushed commit that changed the app. Before touching the server it checks that both
   images exist in GHCR and are public. The playbook then hardens the server, installs Docker, copies the compose
   files and the merged `.env` (mode 600, never printed), starts the stack and checks that
   `https://<PUBLIC_HOST>/` answers through the tunnel.

6. **Check it.** Open the hostname, start a meeting, join from a phone on mobile data. Then:
   ```bash
   scripts/security-check.sh https://cipheroom-beta.alexfix.dev
   ```

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

## Day to day

- **Security updates** install by themselves; when one needs a reboot the server reboots at 04:30 UTC
  (`base_reboot_time` in `deploy/ansible/group_vars/all.yml`). Containers come back on their own and people in a call
  rejoin automatically.
- **Your IP changed?** SSH (and so `deploy.sh`) can't connect. Run `scripts/provision.sh` again: it updates the
  firewall to your new address.
- **Logs:** `ssh cipheroom@<ip>` then `sudo docker compose --project-directory /opt/cipheroom logs -f api`.
  With `--observability`, Grafana is at `https://<PUBLIC_HOST>/grafana/`.
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
| `deploy/ansible/site.yml` | playbook: roles `base`, `docker`, `cipheroom`; `cipheroom_mode` reserves room for the self-hosted modes |
| `deploy/.env.hetzner.example` | template for the server's own keys (tunnel, hostname) |
| `scripts/provision.sh` | Terraform wrapper (`--destroy`) |
| `scripts/deploy.sh` | Ansible wrapper (`--tag`, `--observability`, `--yes`) |
