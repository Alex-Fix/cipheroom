---
name: security-audit
description: Procedure for a full security audit of Cipheroom — the application (E2EE invariant, hub/API, frontend, supply chain, deploy config) and a live server (read-only over SSH plus an outside port scan) — and how to write the report in docs/security/audits/. Use when the user asks for a security audit, a pre-release security pass, "audit the server", or a periodic re-audit. The rules being checked live in the `security` and `e2ee-media` skills; load both.
---

# Security audit

`security` is the rulebook (what must be true), `e2ee-media` the crypto checklist. This skill is the **procedure**:
how to check, from the repo and on a running server, that the rules actually hold — and how to write it down so the
next audit can repeat it and compare.

## Ground rules
- **Read-only on servers.** No installs, no edits, no restarts over SSH. Fixes go through `deploy/ansible/` (or the
  repo) and reach the server with `scripts/deploy.sh`, after asking the user. Ask before any command that changes state.
- **Never print secrets.** Don't `cat` `.env` files, tokens, keys or certs — locally or remotely. Report presence,
  file modes, owners and lengths only (`stat`, `wc -c`, `grep -c '^KEY='`). Claude Code may not read `deploy/.env`.
- **SSH only with pinned host keys**: `-o UserKnownHostsFile=deploy/ansible/known_hosts -o StrictHostKeyChecking=yes
  -o BatchMode=yes -i ~/.ssh/id_cipheroom`, user and host from `deploy/ansible/inventory.ini`.
- **A Critical on a live server** (exposed port, secret readable by others, unauthenticated admin surface): stop,
  tell the user right away, before the report.
- **The report is public.** Describe findings that are still open and exploitable at the class level (what kind of
  weakness, where) — no working exploit steps — until they're fixed.

## Passes
Do them in order and keep notes as you go: each check is either a finding or a line in "Checked and passed".

### A. E2EE invariant (`web/src/app/core/crypto/`, `src/`)
- Walk the `e2ee-media` checklist item by item against the code, not the docs.
- Grep the api for anything that could carry key material or plaintext in a non-envelope field: hub DTOs,
  `IRoomClient`, REST endpoints, SFU/LiveKit requests, logs (`[LoggerMessage]` templates), telemetry tags.
- Frontend: no `console.*`/storage/network path for keys, `location.hash`, names or plaintext; join refused when
  `e2eeSupported` fails or the worker can't attach; every sender/receiver gets the transform.

### B. Backend (`src/`)
- Every hub method: a validator exists (null + length + format), authorisation (member / admitted / host) happens in
  the handler or `Room` aggregate, rate limit applies, relays are targeted (no `Clients.All`, no connection ids out).
- `HubExceptionFilter`: generic messages only. `MaximumReceiveMessageSize`, room caps, `AllowedHosts` in production.
- SFU proxy / LiveKit relay: secrets only server-side, every operation checked against the caller's room, SDP never
  logged, errors sanitised. TURN / LiveKit tokens: only for admitted participants, TTL, minimal grants.
- Logging and telemetry: no request values, names, IPs, SDP, tokens (`TelemetryTests`, `PrivacyProcessor`).
- Endpoints outside the hub (health, metrics, usage) — what's reachable through nginx from the internet.

### C. Frontend (`web/`)
- No `innerHTML`, `bypassSecurityTrust*`, `[innerHTML]` with user data; file/image previews from blobs only.
- CSP in `deploy/nginx/default.conf`: `script-src 'self'`, no `unsafe-inline`/`unsafe-eval` for scripts,
  `connect-src` minimal (LiveKit mode adds its media host only), `frame-ancestors 'none'`.
- No third-party origins (fonts, CDNs, analytics). Nothing sensitive in `localStorage`/`sessionStorage`/IndexedDB
  beyond the non-extractable keys and encrypted backups.

### D. Supply chain
- `scripts/security-check.sh` (secret scan, `.env` hygiene, NuGet + npm audit).
- Images pinned to versions (or digests) in `deploy/docker-compose.yml` and Dockerfiles; no `latest`.
- `.github/workflows/`: actions pinned (prefer commit SHAs), `permissions:` minimal, no secrets in logs, no
  `pull_request_target` with checkout of untrusted code.
- Lockfiles committed (`package-lock.json`, `.terraform.lock.hcl`, central NuGet versions); Ansible collections pinned.

### E. Deploy configuration (`deploy/`, `scripts/`)
- nginx: headers at server level, HSTS (or at Cloudflare), blocked internal paths, rate limits, body size limits.
- Compose, per service: non-root `user`, `read_only` where possible, `cap_drop: [ALL]` + only needed caps,
  `no-new-privileges`, no `privileged`, no Docker socket mounts (note any that exist and why), published ports only on
  `127.0.0.1`, resource limits, healthchecks.
- Grafana hardening (see `security` → Telemetry and Grafana), cloudflared token handling, LiveKit config (keys from
  env, signaling port not published, TURN TLS).
- Terraform: firewall rules vs. what must be reachable; SSH only from the operator; token only via env.
- Ansible: `no_log` on every task touching secrets, file modes, sshd/ufw/fail2ban/unattended-upgrades, host-key
  handling in `scripts/provision.sh` / `deploy.sh`.

### F. Live server (read-only)
Run over SSH (with `sudo` where needed) and from the operator's machine:

| Check | Command (examples) | Expect |
|---|---|---|
| OS and patches | `lsb_release -d`, `apt list --upgradable`, `ls /var/run/reboot-required` | Supported LTS, no security backlog, no pending reboot for days |
| SSH | `sudo sshd -T \| grep -Ei 'permitrootlogin\|passwordauth\|kbdinteractive\|allowusers\|maxauthtries\|x11\|forwarding'` | Matches `sshd.conf.j2` |
| Users | `getent passwd \| awk -F: '$3>=1000'`, `getent group sudo docker` | Only the admin user; nobody in `docker` |
| Firewall | `sudo ufw status verbose` | Default deny in; only 22 (+ LiveKit ports in LiveKit mode) |
| Listening | `sudo ss -tulpn` | Only sshd and expected container ports; web/api/Grafana on 127.0.0.1 or the Docker network |
| fail2ban | `sudo fail2ban-client status sshd` | Active |
| Updates | `systemctl status unattended-upgrades`, `/etc/apt/apt.conf.d/*` | Enabled, reboot window set |
| Docker | `sudo docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'`, `sudo docker inspect` (User, ReadonlyRootfs, CapDrop, Privileged, Mounts) | Matches compose intent; pinned images |
| Daemon | `cat /etc/docker/daemon.json`, `ls -l /var/run/docker.sock` | Log rotation; socket root:docker 660 |
| Secrets on disk | `sudo stat -c '%a %U:%G %n' /opt/cipheroom/.env /etc/cipheroom /etc/cipheroom/* /etc/letsencrypt/live` | 600/700 root |
| Timers | `systemctl list-timers` | Cert renewal (LiveKit + TURN domain), apt timers |
| Outside view | `nmap -Pn -sS -p- <ip>` and `nmap -Pn -sU -p 3478,7882 <ip>` from the laptop (sudo) | Only the firewall's ports |
| TLS + headers | `scripts/security-check.sh https://<PUBLIC_HOST>` | All green |

## Severity
| Level | Meaning |
|---|---|
| Critical | Breaks the E2EE invariant, exposes a secret, or gives an outsider control of a server — fix now |
| High | Realistic path to quota abuse, metadata leak beyond the documented set, or privilege escalation on the host |
| Medium | Defence-in-depth gap with a plausible attack path, or a hardening rule from `security` not met |
| Low | Hardening nice-to-have, unlikely or low-impact path |
| Info | Observation, accepted design trade-off, or documentation gap |

## Fixing
Fix in the same change when Critical/High/Medium **and** contained (config, validator, header, Ansible task, compose
option) **and** no protocol or crypto design change. One commit per finding (`Fix SA-YYYY-MM-DD-NN: …`), with a test
where one fits. Anything touching the E2EE design or the signaling contract → `brainstorming` first. Server fixes:
Ansible → `scripts/deploy.sh` (ask) → repeat pass F. If a fix adds a rule, add it to the `security` skill too.

## Report
Write `docs/security/audits/YYYY-MM-DD.md` from this template; link it from `docs/security/audits/README.md`.

```markdown
# Security audit — YYYY-MM-DD
Scope: commit <sha> (branch), server <name> (<type>, <location>, MEDIA_MODE=<mode>), <PUBLIC_HOST>
Auditor: <who> · Method: .claude/skills/security-audit (passes A–F)

## Summary
| Severity | Found | Fixed | Follow-up | Accepted |
|---|---|---|---|---|

## Findings
### SA-YYYY-MM-DD-NN · <Severity> · <title>
- **Where:** `path:line` / server component
- **Evidence:** what was observed (redacted)
- **Impact:** against the threat model (`security` skill)
- **Fix:** what was or should be done
- **Status:** fixed in <commit> · follow-up · accepted risk (why)

## Checked and passed
- A. …  (one line per check, so the next audit knows what was covered)

## Follow-ups
## Not covered
```
