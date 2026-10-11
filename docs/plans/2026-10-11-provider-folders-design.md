# Provider folders and repo tidy-up — design
Status: approved · Date: 2026-10-11

## Problem

The repo matches the layout in `CLAUDE.md` at the top level, but the media-provider work (PRs #26–#28) left some drift:

- `src/Cipheroom.Infrastructure/Rtc/` mixes Cloudflare-only code (`CloudflareSfu`, `CloudflareMediaRoom`,
  `CloudflareIceServerProvider`, `Cloudflare*Options`, `PendingOffers`, `SdpCodecs`) with shared code, while LiveKit
  has its own `Rtc/LiveKit/`. `Usage/` mixes Cloudflare, Hetzner and the shared guard the same way. Tests mirror the
  flat layout.
- `artifacts/` (gitignored) holds .NET build output, dev runtime state (`usage.json`, `dev-settings.json`), logs,
  about 60 old `out-*` e2e runs, loop scripts and the `repro/` + `spikes/` scripts that skills refer to.
- Empty `.ansible/` (ansible-lint cache, not ignored) and `TestResults/` sit at the repo root.
- `CLAUDE.md`, skills and `docs/deployment-hetzner.md` describe `cipheroom_mode` (gone, now `cipheroom_media_mode`
  from `MEDIA_MODE`) and miss `deploy/livekit/`, the `certs` role, `tests/fixtures/` and the LiveKit/Hetzner adapters.

## Goals / Non-goals

Goals
- Rule: code used by one provider lives in `Rtc/<Provider>/` or `Usage/<Provider>/`; shared code stays at the top
  of the area. Tests follow the same layout.
- `artifacts/` = build output + `dev/` (runtime state, logs) + `e2e/` (scratch scripts and their runs).
- No untracked junk at the root.
- Docs, skills and memory describe the repo as it is after the move.

Non-goals
- No runtime behaviour, protocol, config key, image or dependency changes.
- No edits to dated records in `docs/plans/`.
- No tracking of the e2e scratch scripts (they stay local, under `artifacts/e2e/`).
- No moves in `web/` or `src/Cipheroom.Api` — they already follow the rules.

## Constraints check

| Constraint | Answer |
|---|---|
| E2EE invariant | Unaffected — moves and namespaces only. |
| $0 running cost | Unaffected. |
| No public IP | Unaffected. |
| Self-hostable + open source | Unaffected; no new dependencies. |
| Untrusted server | Unaffected. |
| Browser support | Unaffected; no frontend change. |
| Signaling | Unaffected; no hub method or event changes. |
| **Real risk: broken paths** | Namespaces/usings in DI and tests; dev paths in `Program.cs` and `appsettings.Development.json`; path mentions in skills, docs and memory. Each verified by build, tests, lint and a `git grep` for old paths. |

## Chosen approach

One branch `refactor/provider-folders`, one PR, one commit per area (backend folders → dev paths + `.gitignore` →
docs/skills). Moves via `git mv` so history survives. Local `artifacts/` cleanup is done alongside but is not part
of any commit.

- Why not one PR per area: several review/smoke cycles for a pure refactor; docs would be stale between merges.
- Why not track the e2e scripts (e.g. `tests/e2e/`): would add a tracked Node setup and turn a tidy-up into a
  feature; the user chose to keep them local.

## Design

### 1. Backend provider folders

```
src/Cipheroom.Infrastructure/
  Rtc/
    MediaOptions.cs                MEDIA_MODE choice (shared)
    UnavailableMedia.cs            UnavailableSfu, NoMediaRelay (shared)
    DirectIceServerProvider.cs     split out of IceServerProviders.cs
    Cloudflare/
      CloudflareSfuClient.cs  CloudflareTurnClient.cs        (already here)
      CloudflareSfu.cs  CloudflareMediaRoom.cs               ← from Rtc/
      CloudflareIceServerProvider.cs                         ← split out of IceServerProviders.cs
      CloudflareOptions.cs                                   ← RtcOptions.cs (Turn/Sfu options; only Cloudflare reads them)
      PendingOffers.cs  SdpCodecs.cs                         ← only CloudflareSfu uses them
    LiveKit/                                                 unchanged
  Usage/
    UsageGuard.cs  UsageGuardOptions.cs  RealtimeUsagePoller.cs  RealtimeUsageOptions.cs   (shared)
    Cloudflare/  CloudflareAnalyticsClient.cs  CloudflareRealtimeUsage.cs
    Hetzner/     HetznerTraffic.cs
```

- Namespaces follow folders: `Cipheroom.Infrastructure.Rtc.Cloudflare`, `.Usage.Cloudflare`, `.Usage.Hetzner`.
  `DependencyInjection.cs` and tests get the new usings.
- Config section names are unchanged (`Turn:Cloudflare:*`, `Sfu:Cloudflare:*`, `RealtimeUsage:Cloudflare:*`), so
  `.env`, compose, appsettings and Ansible templates don't change.
- Tests in `Cipheroom.Infrastructure.IntegrationTests`:
  `Rtc/Cloudflare/{CloudflareSfuTests, CloudflareMediaRoomTests, CloudflareIceServerProviderTests}.cs`,
  `Rtc/LiveKit/LiveKitTests.cs`, `Usage/Cloudflare/RealtimeUsageTests.cs` (it tests the Cloudflare analytics
  client), `Usage/Hetzner/HetznerTrafficTests.cs`; `UsageGuardTests.cs` stays in `Usage/`.

### 2. `artifacts/` and root leftovers

```
artifacts/
  bin/ obj/ publish/        .NET build output (ArtifactsPath; unchanged)
  dev/                      usage.json, dev-settings.json, *.log
  e2e/
    repro/                  ← artifacts/repro (keeps its node_modules)
    spikes/                 ← artifacts/spikes (__pycache__ dropped)
    loops/                  ← artifacts/loop-*.sh (cd ../repro, OUT=../runs/<name>-<n>, results in ../runs/)
    runs/                   e2e output: OUT=artifacts/e2e/runs/<name>
```

- Tracked changes: `Program.cs` dev-settings path → `../../artifacts/dev/dev-settings.json`;
  `appsettings.Development.json` `UsageGuard:DataPath` → `../../artifacts/dev/usage.json` (`UsageGuard` already
  creates a missing directory on save).
- Local moves: `usage.json` and `dev-settings.json` → `dev/` (keeps this month's usage estimate).
- Local deletes: `artifacts/out-*`, `*.result`, `dev-run.log`, `up.log`, `repro/out-*`. Contents and sizes are
  listed to the user before deleting.
- Root: delete empty `TestResults/` and `.ansible/`; add `.ansible/` to `.gitignore` (IaC section) since
  `scripts/lint.sh` recreates it.

### 3. Docs, skills, memory

| Where | Fix |
|---|---|
| `CLAUDE.md` layout | Add `deploy/livekit/`, `tests/fixtures/`, LiveKit + Hetzner adapters in Infrastructure; ansible roles `base / docker / cipheroom` + `certs` (LiveKit TURN), mode from `MEDIA_MODE` |
| `docs/deployment-hetzner.md:181`, docker-deploy skill | Drop "`cipheroom_mode` reserves room…"; describe `cipheroom_media_mode` from `MEDIA_MODE` and the `certs` role; `artifacts/dev/dev-settings.json` |
| dotnet-backend skill | New Infrastructure tree + the provider-folder rule |
| media skill | `artifacts/e2e/repro/`, runs under `artifacts/e2e/runs/` |
| `docs/architecture.md` | Check adapter names and paths still match |
| Claude memory | `artifacts/repro` → `artifacts/e2e/repro` |

## Protocol changes

None.

## Security notes

No change to data flow, keys, logging or exposed metadata. The `.gitignore` addition only widens what is ignored;
secret rules are untouched.

## Testing

- `scripts/lint.sh` green (`dotnet format`, ansible-lint — and `.ansible/` shows as ignored afterwards).
- `scripts/test.sh` green.
- `scripts/dev.sh` starts; usage guard writes `artifacts/dev/usage.json`; dev settings still apply live.
- `lobby-e2e.mjs` runs from `artifacts/e2e/repro/` against the dev stack.
- `docker compose -f deploy/docker-compose.yml config` unchanged.
- `git grep` finds no old paths (`Rtc/CloudflareSfu.cs`, `IceServerProviders`, `RtcOptions.cs`,
  `artifacts/repro`, `artifacts/dev-settings`, `cipheroom_mode`) outside `docs/plans/`.

## Open questions

None.

## Implementation steps

1. Branch `refactor/provider-folders` from `main`.
2. `git mv` Cloudflare Rtc files into `Rtc/Cloudflare/`; split `IceServerProviders.cs`; rename `RtcOptions.cs` →
   `Cloudflare/CloudflareOptions.cs`; update namespaces and usings; build + test. Commit.
3. `git mv` Usage files into `Usage/Cloudflare/` and `Usage/Hetzner/`; update namespaces and usings; build + test.
   Commit.
4. Move Infrastructure integration tests into the mirrored folders; test. Commit (or fold into 2–3).
5. Dev paths in `Program.cs` and `appsettings.Development.json`; `.ansible/` in `.gitignore`. Commit.
6. Local tidy: list `artifacts/` for the user, then move to `dev/` + `e2e/`, fix loop script paths, delete old runs,
   logs and the empty root dirs (not committed).
7. Update `CLAUDE.md`, skills, `docs/deployment-hetzner.md`, `docs/architecture.md`; `git grep` for old paths.
   Commit.
8. Update Claude memory paths.
9. Full verification (Testing section), then PR via prefilled GitHub link.
