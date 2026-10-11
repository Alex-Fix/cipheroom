# IaC tidy-up, cx43 resize, security audit, docs and wiki — design
Status: approved · Date: 2026-10-11

> **Changed during implementation:** cx43 had no capacity in any location (the first resize failed with the server
> left powered off), so the server type is **cpx42** (8 AMD vCPU / 16 GB), and `scripts/provision.sh` now checks
> availability before a resize and powers the server back on after a failed apply.

## Problem
The Hetzner server (cx23, 2 vCPU / 4 GB) is tight for the api, LiveKit and the observability stack. The Terraform and
Ansible code has small inaccuracies left over from adding LiveKit mode. The `security` skill states the rules, but
nothing lays out how to audit the application and the live server against them, and no audit has been done yet.
The only documentation is `docs/`, which is written for contributors. There are no reader-facing guides (wiki).

## Goals / Non-goals
Goals:
- Tidy Terraform and Ansible: fix naming and comments, pin collections, close small gaps.
- Resize the Hetzner server to **cx43** (8 vCPU / 16 GB) in place, keeping the disk so the change stays reversible.
- Add a `security-audit` skill: a repeatable procedure and a report template.
- Audit the application and the live server. Write the report and fix contained Critical/High/Medium findings in the same PR.
- Update the docs. Write the GitHub Wiki pages (sources in `docs/wiki/`), and publish them after the merge.

Non-goals: a wiki sync workflow, agents such as `lynis` installed on the server, testing Cloudflare's own services,
changes to the E2EE protocol or the signaling contract, a bigger disk.

## Constraints check
| Constraint | Answer |
|---|---|
| E2EE invariant | Unchanged. The audit verifies it (pass A). Any finding against it is a design change and gets its own brainstorming round. |
| $0 running cost | The home default is unaffected. The opt-in Hetzner path costs more: cx43 is about €10–12/mo plus IPv4 (cx23 was about €4–5). This knowingly relaxes cost, as `docs/deployment-hetzner.md` already does. |
| No public IP | Unchanged at home. On Hetzner the firewall stays as it is (SSH from the operator's IP only; LiveKit ports only in LiveKit mode). |
| Self-hostable + open source | No new dependencies. `nmap` runs only on the operator's laptop and is optional. GitHub Wiki is free. |
| Untrusted server | The audit checks metadata exposure in logs and telemetry, and the server's attack surface. |
| Browser support | Not affected. |
| Signaling | No hub or event changes. If a fix needs one, it's out of scope (it becomes a follow-up). |

## Chosen approach
One branch, `chore/hardening-audit`. Tidy-up → resize → skill → audit plus fixes → docs → wiki sources. The wiki is
published manually after the merge.
- Server: **cx43** over cpx42 (twice the price, limited locations) and ccx33 (dedicated vCPUs and 32 GB, not needed).
- A **new** `security-audit` skill rather than extending `security`: keeps the rulebook and the procedure separate.
  A separate audit script was left out because the skill's commands are enough for now.
- **Report, then fix in the same PR**: findings are fixed while the context is fresh. The report records each one's
  status, so it stays an honest snapshot.
- Wiki **sources in the repo**, pushed once by hand. The pages get reviewed in PRs, and no token with write access
  is needed in Actions.

## Design

### 1. Terraform / Ansible tidy-up
- Rename the firewall from `${name}-ssh-only` to `${name}-server` (an in-place update; the name is wrong in LiveKit mode).
- New variable `keep_disk` (default `true`), passed to `hcloud_server.keep_disk`.
- `server_type`: default `cx43`. The description lists cx23 / cx33 / cx43. Update `terraform.tfvars.example` to match.
- `requirements.yml`: pin the exact versions of `community.general` and `ansible.posix` (instead of `>=` ranges).
- Swap: keep 2 GB as a safety net and fix the "4 GB server" comment.
- Close gaps if they exist: Docker daemon log rotation (`daemon.json`), committed `.terraform.lock.hcl`.
- No refactor beyond these.

### 2. Resize to cx43
- Run `scripts/provision.sh` and show the plan. It must update in place only (`hcloud_server` server type, firewall
  name). If the plan shows a replace, stop.
- Expected downtime: about 1–2 minutes of power-off. The IP stays the same, the disk is kept (40 GB).
- `scripts/deploy.sh` afterwards to confirm the stack is healthy through the tunnel.
- Rollback: `server_type = "cx23"`, which works because the disk wasn't enlarged.
- Ask before each `provision.sh` / `deploy.sh` run.

### 3. `security-audit` skill (`.claude/skills/security-audit/SKILL.md`)
A procedure that loads `security` and `e2ee-media` as references. Six passes:

| Pass | Checks |
|---|---|
| A. E2EE invariant | No key material in SignalR plaintext fields, REST, logs, telemetry, SFU/LiveKit requests. No unencrypted fallback. Frame worker against the `e2ee-media` checklist. |
| B. Backend | Validation, per-room authorisation, rate limits on every hub method. `HubExceptionFilter`. Logging never includes request values. `AllowedHosts`. SFU/LiveKit secrets stay server-side. Token TTLs. |
| C. Frontend | No `innerHTML` / `bypassSecurityTrust*`. Strict CSP. No third-party origins. Nothing sensitive in storage or console. |
| D. Supply chain | `scripts/security-check.sh` (NuGet/npm audit, secret scan). Pinned images and actions. Lockfiles. GHCR workflow permissions. |
| E. Deploy config | nginx headers. Compose: non-root, read-only, `cap_drop`, only `127.0.0.1` published. Grafana. cloudflared. LiveKit config. Terraform firewall. Ansible roles. |
| F. Live server (read-only) | `sshd -T`, ufw / Hetzner firewall against `ss -tulpn`, fail2ban, unattended-upgrades and pending reboots, Docker (users, ports, socket, daemon config), modes of `/opt/cipheroom/.env` and `/etc/cipheroom`, cert timer. From outside: `nmap` of the public IP, TLS and headers via `security-check.sh <url>`. |

Rules: read-only on the server (fixes go through Ansible only). Never print secrets: only presence, modes and lengths.
Severities Critical / High / Medium / Low / Info. Each finding has id `SA-YYYY-MM-DD-NN`, location, redacted
evidence, impact against the threat model, fix, and status (fixed in `<commit>` / follow-up / accepted risk).
Report template → `docs/security/audits/YYYY-MM-DD.md`: scope, summary table, findings, checked-and-passed list.

### 4. Running the audit and fixing
- Run after the resize. Passes A–E in the repo; F over SSH with the pinned `known_hosts`; `nmap` from the laptop.
- Fixed in this PR when Critical/High/Medium, contained (config, validator, header, Ansible task, compose option),
  and needing no protocol or crypto design change. One commit per finding, referencing its id, with a test where one
  fits.
- Server fixes: Ansible roles → one `scripts/deploy.sh` (after asking) → repeat pass F to confirm.
- Low/Info or larger work → "Follow-ups" in the report. Anything touching E2EE or signaling → its own brainstorming round.
- A Critical finding on the live server (exposed port, readable secret) → stop and tell the user right away, before the report.

### 5. Docs
- `docs/deployment-hetzner.md`: cx43 default and cost, resizing and going back, firewall name, link to audits.
- `docs/architecture.md`: a short "Security assurance" paragraph (skills, `security-check.sh`, audit reports).
- `CLAUDE.md`: `security-audit` in the skills list, `docs/security/audits/` in the layout.
- `security` skill: pointer to `security-audit`, plus any new rules from fixes.
- README: links to the wiki and the latest audit.

### 6. Wiki
Sources in `docs/wiki/` (GitHub Wiki names): `Home`, `Self-hosting`, `Hetzner-deployment`, `Media-modes`,
`Security-model`, `Development`, `Troubleshooting`, `_Sidebar`. The pages are guides that link to `docs/` for the
details instead of copying them.
Publishing after the merge:
1. The user enables Wikis in the repo settings and creates a first page in the UI (this initialises `cipheroom.wiki.git`).
2. Clone `git@github-personal:Alex-Fix/cipheroom.wiki.git` into the scratchpad, copy `docs/wiki/*`, show the diff,
   and push once the user approves.

## Protocol changes
None.

## Security notes
- The audit touches the live server read-only over SSH, with a host-key-pinned connection. No secret values are
  printed or written to the report.
- The report is public (repo and wiki). It must not hand attackers a recipe: findings that are still open and
  exploitable are described at the class level until fixed.
- Pinning the Ansible collections reduces supply-chain drift. Changing the firewall name doesn't change any rules.
- Metadata exposure (IPs, timing, room activity visible to the api/Hetzner/Cloudflare) is restated in
  `Security-model`; it isn't hidden.

## Testing
- `terraform validate` / `fmt`, `ansible-lint`, `scripts/lint.sh`, `scripts/test.sh` all green.
- After the resize: the Terraform plan is a no-op, `deploy.sh` health check passes, a call works.
- Each code fix has a test where one fits (hub functional test, Angular spec, telemetry privacy test).
- Pass F repeated after the fix deploy, and `scripts/security-check.sh https://<host>` passes.

## Open questions
- Exact cx43 monthly price at the time of the change (put the figure into the docs from Hetzner's price list).
- Whether the audit finds anything that needs a design change (would become a follow-up design).

## Implementation steps
1. Terraform: firewall rename, `keep_disk`, `server_type` default cx43 and description, tfvars example, lock file.
2. Ansible: pinned collections, swap comment, Docker log rotation if missing.
3. Resize: `provision.sh` (plan reviewed, in place only) → `deploy.sh` → check that it's healthy.
4. `security-audit` skill and report template.
5. Audit passes A–F → `docs/security/audits/2026-10-11.md` (findings, passed checks).
6. Fixes, one commit per finding, with tests. Server fixes via Ansible → `deploy.sh` → repeat pass F.
7. Report statuses finalised (fixed / follow-up / accepted).
8. Docs: deployment-hetzner, architecture, CLAUDE.md, security skill, README.
9. Wiki sources in `docs/wiki/`.
10. PR (prefilled link). After the merge: enable the wiki, push the pages, update roadmap memory.
