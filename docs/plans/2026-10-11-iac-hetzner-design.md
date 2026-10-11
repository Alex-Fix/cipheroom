# Infrastructure as code (Hetzner) — design
Status: approved · Date: 2026-10-11

## Problem

Cipheroom runs only at home, set up by hand with `scripts/up.sh`. The roadmap promises infrastructure as code so an
operator can stand up the stack on a rented server reproducibly. Only the Cloudflare deployment mode exists today, so
the first IaC change deploys that mode — Cloudflare Tunnel + Cloudflare Realtime SFU/TURN — onto a Hetzner VM, built so
the self-hosted modes can plug in later.

## Goals / Non-goals

Goals
- GitHub Actions builds the api and web images and publishes them to GHCR, tagged by commit.
- Terraform creates a firewalled Hetzner VM (only SSH from allowed IPs inbound).
- An idempotent Ansible playbook hardens the VM, installs Docker and runs the existing compose stack from GHCR images,
  with secrets taken from the operator's local `deploy/.env` (+ an optional overlay).
- One-command update and rollback by image tag; documented costs and pitfalls.
- Roadmap cleanup: remove MLS, drop AWS (IaC targets Hetzner only).

Non-goals
- Deployment modes 2/3 (self-hosted SFU/TURN) — the playbook only reserves a `cipheroom_mode` variable.
- arm64 images, remote Terraform state, CI-driven deploys, a CI test workflow.
- DNS / tunnel automation via the Cloudflare Terraform provider (the second tunnel is created by hand).

## Constraints check

| Constraint | This feature |
|---|---|
| E2EE invariant | Unchanged — the same containers on another host; no new code path touches media or keys. |
| $0 running cost | **Knowingly relaxed, opt-in.** Hetzner VM + primary IPv4 ≈ €4–5/month. GHCR and Actions are free for public repos. The default home mode stays $0. Docs state the cost. |
| No public IP | The VM has one, but the app doesn't use it: ingress stays the tunnel, media stays Cloudflare. Only 22/tcp from allowed IPs is open. |
| Self-hostable + open source | Terraform `hcloud` provider (MPL), Ansible (GPL), Docker. Actions/GHCR are build-time conveniences; images can still be built locally with `up.sh`. |
| Untrusted server | Hetzner now hosts the api: no content access (E2EE), but it can observe the same metadata the api sees (IPs, timing, room ids). Documented. |
| Browser support | No change. |
| Signaling | No change — no hub methods or events. |

## Chosen approach

Terraform (Hetzner VM + firewall) → Ansible (harden, Docker, compose) → the same `deploy/docker-compose.yml`, running
images prebuilt by GitHub Actions in GHCR, secrets copied from the local `deploy/.env`.

- Why not cloud-init only: runs once at boot; updates and re-runs are awkward. Ansible is idempotent and is what the
  roadmap names.
- Why not build on the VM: slower deploys on a small VM; GHCR keeps the VM to `pull` + `up` and makes rollback a tag.
- Why not Ansible Vault: a second copy of every secret to keep in sync; the local `deploy/.env` stays the one source.
- Why not SSH through the tunnel: needs Cloudflare Access, which the user rejected for Grafana.

## Design

### Repo layout

```
.github/workflows/images.yml      build + push api and web images to GHCR
deploy/
  docker-compose.yml              + image: on api/web (build: stays for home use)
  terraform/hetzner/              versions.tf, variables.tf, main.tf, outputs.tf, cloud-init.yaml,
                                  terraform.tfvars.example, .terraform.lock.hcl (committed)
  ansible/
    ansible.cfg, inventory.example.ini
    site.yml                      entry playbook; cipheroom_mode: cloudflare (only value for now)
    group_vars/all.yml            image tag, profiles, reboot time
    roles/base/                   SSH hardening, swap, fail2ban, ufw, unattended-upgrades
    roles/docker/                 Docker Engine + compose plugin, log rotation
    roles/cipheroom/              ship compose files + .env, pull, up, verify, prune
scripts/
  provision.sh [--destroy]        terraform in deploy/terraform/hetzner, writes inventory + known_hosts
  deploy.sh [--tag <tag>] [--observability] [--yes]   runs the playbook
docs/deployment-hetzner.md        operator guide
```

### Image pipeline (`.github/workflows/images.yml`)

- Triggers: push to `main` (path filters skip docs-only changes), `v*` tags, manual dispatch.
- Buildx, `linux/amd64` only. Images `ghcr.io/alex-fix/cipheroom-api` and `ghcr.io/alex-fix/cipheroom-web`.
- Tags: `sha-<full sha>`, `main` (on main), the git tag (on tags).
- Web build args: `SOURCE_URL` = repository URL, `SOURCE_COMMIT` = `github.sha` — the AGPL §13 Source link always
  opens the exact commit.
- Auth: built-in `GITHUB_TOKEN`, permissions `contents: read`, `packages: write` only. Third-party actions pinned by SHA.
- One-time manual step: set both GHCR packages to public so the VM pulls anonymously.

### Compose change

`api` and `web` gain `image: ghcr.io/alex-fix/cipheroom-<svc>:${CIPHEROOM_TAG:-local}` next to `build:`. Home use is
unchanged (`up.sh` builds and tags `local`); on the VM Ansible sets `CIPHEROOM_TAG` and runs `pull` +
`up --no-build`.

### Terraform (`deploy/terraform/hetzner/`)

- Provider `hetznercloud/hcloud`, version pinned, lock file committed. Token only via `HCLOUD_TOKEN` env var.
- `hcloud_ssh_key` from `ssh_public_key_path` (default `~/.ssh/id_ed25519.pub`).
- `hcloud_firewall`: inbound 22/tcp from `allowed_ssh_cidrs` (required, no default); nothing else inbound (no
  80/443, no ICMP); outbound open.
- `hcloud_server`: Ubuntu 26.04 LTS (looked up via `data "hcloud_image"`, so a wrong name fails at plan);
  `server_type` = `cx23` (smallest shared x86); `location` default `nbg1`; public IPv4 on (GHCR has no IPv6); no Hetzner backups;
  `delete_protection` / `rebuild_protection` from a variable, default `true`.
- cloud-init: create sudo user `cipheroom` with the key, disable root and password SSH. Everything else is Ansible.
- Outputs: `ipv4`, `ssh_command`.
- State local (`terraform.tfstate`, IPs and ids only), gitignored with `.terraform/` and `terraform.tfvars`.

`scripts/provision.sh`: checks `HCLOUD_TOKEN`, fills `allowed_ssh_cidrs` with the current public IP from
`https://1.1.1.1/cdn-cgi/trace` (already a dependency) unless set in tfvars, runs `init` + `apply`, writes
`deploy/ansible/inventory.ini` and `deploy/ansible/known_hosts` (`ssh-keyscan`), prints the monthly cost reminder.
`--destroy` requires typing the server name and only works once `delete_protection=false` has been applied.

### Ansible

Runs from the laptop as `cipheroom` with `become`; strict host key checking against `deploy/ansible/known_hosts`.

`base`: apt upgrade; timezone UTC; 2 GB swap; sshd drop-in (no root, no passwords, no keyboard-interactive,
`AllowUsers cipheroom`, no X11/agent forwarding); fail2ban sshd jail; ufw deny incoming + allow 22 (second layer —
`web` publishes only on `127.0.0.1:8080`, so Docker's ufw bypass exposes nothing); unattended-upgrades for security
updates with automatic reboot at `04:30` UTC (variable).

`docker`: Docker's official apt repo (pinned key), Engine + compose plugin; `daemon.json` json-file log rotation
(10 MB × 3). `cipheroom` is not in the docker group (root-equivalent).

`cipheroom`:
1. Fail unless `cipheroom_mode == "cloudflare"` ("mode not implemented yet" otherwise).
2. Copy `docker-compose.yml`, `nginx/`, `observability/` to `/opt/cipheroom/` (root-owned).
3. Env: read local `deploy/.env`, overlay optional `deploy/.env.hetzner` (only differing keys — typically
   `TUNNEL_TOKEN`, `PUBLIC_HOST`), add `CIPHEROOM_TAG`, write `/opt/cipheroom/.env` mode 600 — every task touching
   values has `no_log: true`. Preflight fails without `TUNNEL_TOKEN`, or with `--observability` and no 12+ character
   `GRAFANA_ADMIN_PASSWORD`.
4. `docker compose pull`, then `up -d --no-build --remove-orphans` with `--profile tunnel` (+ `observability`).
5. Verify: `--wait` for `api` and `web` healthy, `http://127.0.0.1:8080/` on the VM, then `https://PUBLIC_HOST/`
   through the tunnel; on failure print the last 50 lines of `compose logs` (no env values), name the last good tag
   to roll back to, and fail.
6. Record good tags in `/opt/cipheroom/deployed-tags` (current + previous different one); prune all other app images.

`scripts/deploy.sh`: tag defaults to `sha-<local HEAD>`; checks anonymously that both images exist in GHCR before
running (unpushed commit, CI not done, or package still private → clear message). Without `deploy/.env.hetzner` it
warns that the VM would share the home tunnel and asks for typed confirmation (`--yes` skips).

### Operator flow

1. Push to `main`; Actions publishes images; make both GHCR packages public (once).
2. Zero Trust: create a second tunnel, hostname e.g. `vm.cipheroom.alexfix.dev` → `http://web:8080`; put its token and
   `PUBLIC_HOST` into `deploy/.env.hetzner`.
3. `export HCLOUD_TOKEN=…` → `scripts/provision.sh`.
4. `scripts/deploy.sh [--observability]`.

Update: push, wait for Actions, `scripts/deploy.sh`. Rollback: `scripts/deploy.sh --tag sha-<old>`.

### Failure modes

| Case | Behaviour |
|---|---|
| Image for the commit not in GHCR | `deploy.sh` stops before Ansible runs: push / wait for Actions |
| GHCR package private | Same check fails: "make the package public" |
| Operator IP changed | SSH fails; message says rerun `provision.sh` |
| Same tunnel token as home | Cloudflare would balance across two apis with separate in-memory rooms → warning + typed confirmation |
| api unhealthy after `up` | Play fails with sanitized logs; previous image kept for rollback |
| Reboot / Docker restart | `restart: unless-stopped`; clients auto-rejoin |
| Home + VM share the free tier | Each usage guard estimates alone; docs recommend `CF_ANALYTICS_API_TOKEN` on both (account-wide figure) |

### Data and state

The VM keeps only Docker volumes: `api-data` (usage-guard estimate) and the observability volumes. No database,
consistent with the amnesiac-server decision. Terraform state stays on the operator's laptop.

## Protocol changes

None.

## Security notes

- Secrets: `HCLOUD_TOKEN` from the environment only; `deploy/.env` (+ overlay) copied with `no_log`, mode 600,
  root-owned. **`.gitignore` must add `.env.*` (keeping `!*.env.example`)** — today `deploy/.env.hetzner` is not
  ignored. Also ignore `*.tfstate*`, `.terraform/`, `terraform.tfvars`, `deploy/ansible/inventory.ini`,
  `deploy/ansible/known_hosts`.
- Attack surface: only 22/tcp from allowed IPs (Hetzner firewall + ufw), key-only, no root, fail2ban, automatic
  security updates. App ingress only via the outbound tunnel.
- Supply chain: CI uses `GITHUB_TOKEN` with least privilege, actions pinned by SHA; images tagged by immutable commit
  SHA; deploys pin a tag (never implicitly `latest`).
- Metadata: Hetzner, as host, can observe what the api observes (IPs, timing, pseudonymous room activity) — never
  media, chat, files or keys. Stated in `docs/deployment-hetzner.md`.
- `scripts/security-check.sh` keeps working; run it against the VM hostname after the first deploy.

## Testing

- `terraform fmt -check` + `terraform validate`; `ansible-playbook --syntax-check` + `ansible-lint`; `shellcheck` on
  new scripts — wired into `scripts/lint.sh` when the tools are installed (skipped with a note otherwise).
- `scripts/doctor.sh`: optional `terraform` / `ansible` checks (warnings only).
- CI: the image workflow must build both images on a PR branch run (manual dispatch) before merge.
- Real run (user): provision, deploy, two-device call through the VM hostname (Mac Chrome + iPhone); re-run
  `deploy.sh` (no changes reported); rollback to an older SHA; reboot the VM and confirm calls recover;
  `security-check.sh https://<vm host>`; destroy unless kept.

## Open questions

- Whether the user keeps the VM running after verification (affects only cost, not design).

## Implementation notes (2026-10-11)

Decided or learned while building it:
- **Ubuntu 26.04 LTS** (user's choice) instead of 24.04; Docker's apt repo serves `resolute`. Server type `cx23`.
- Beta hostname: **`cipheroom-beta.alexfix.dev`** (first-level, covered by the free certificate) —
  `deploy/.env.hetzner.example`; `.gitignore` gained `.env.*` (the overlay wasn't ignored before).
- A full run against a systemd Ubuntu 26.04 container (local registry instead of GHCR) found:
  `compose up --wait` passes while cloudflared crash-loops on a bad token → the deploy now checks
  `https://PUBLIC_HOST/` through the tunnel and `--wait`s only for api/web; reading the "previous" tag from `.env`
  let a failed deploy prune the rollback image → good tags live in `deployed-tags`; swap creation wasn't resumable
  → each step checks its own state (`base_swap_mb: 0` = none); `gpg` isn't guaranteed → `gnupg` installed.
- Verified there: idempotent re-runs (`changed=0`), failed deploy → hint names the last good tag, retry, rollback,
  pruning, observability on/off, no secret value in any Ansible output.
- `scripts/security-check.sh` also checks `deploy/.env.hetzner` and that Terraform state/inventory are ignored; the
  secret scan knows `HCLOUD_TOKEN`.

## Implementation steps

1. `.gitignore`: `.env.*` (keep examples), Terraform state/vars, Ansible inventory/known_hosts.
2. Compose: `image:` with `${CIPHEROOM_TAG:-local}` on api and web; confirm `up.sh` unchanged at home.
3. `.github/workflows/images.yml`: build + push both images to GHCR with SHA tags and Source-link build args.
4. Terraform module `deploy/terraform/hetzner/` (key, firewall, server, cloud-init, outputs, tfvars example).
5. `scripts/provision.sh` (IP detection, apply, inventory + known_hosts, `--destroy`).
6. Ansible skeleton (`ansible.cfg`, `site.yml`, `group_vars`) + `base` role.
7. `docker` role.
8. `cipheroom` role (files, env merge with overlay + preflight, pull/up, verify, prune).
9. `scripts/deploy.sh` (tag default, GHCR manifest check, overlay warning).
10. Lint/doctor wiring (`terraform validate`, `ansible-lint`, `shellcheck`).
11. Docs: `docs/deployment-hetzner.md`, `docker-deploy` skill, CLAUDE.md layout (`deploy/terraform`, `deploy/ansible`,
    `.github/`), README (remove MLS, drop AWS, tick IaC for Hetzner, link the guide).
