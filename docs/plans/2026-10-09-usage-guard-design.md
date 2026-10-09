# Usage guard — design
Status: approved, implemented · Date: 2026-10-09

## Problem

Cloudflare Realtime (SFU + TURN) is free up to 1,000 GB of egress per calendar month; beyond that, Cloudflare bills.
Cipheroom measures month-to-date usage (`RealtimeUsagePoller`, Grafana **Free tier** dashboard) but nothing acts on
it: a busy month — or a few long 4K calls — can cross the free tier. The $0 running-cost rule is only as good as the
operator watching a dashboard.

## Goals / Non-goals

Goals
- Never cross the free tier, enforced by the api (clients are untrusted), in three steps:
  - **Saving** (default 80%): received video held at the half simulcast layer, senders capped at 720p, banner.
  - **AudioOnly** (95%): no new calls; calls in progress continue audio-only; video forwarding stopped.
  - **Paused** (99%): every call ends; nothing starts until the month resets (1st, 00:00 UTC).
- Works without the Cloudflare analytics token: the api keeps its own estimate from browsers' call-quality reports,
  persisted across restarts.
- Everyone in a call sees why quality dropped or video stopped (percent and reset date only).
- Thresholds configurable in `deploy/.env`; an escape hatch to turn the guard off.

Non-goals
- Per-user or per-room quotas, billing alerts by email/push, predicting the month end in the app (Grafana already
  projects it).
- Changing what Cloudflare measures or bills; TURN-only accounting.
- A home-page indicator (home has no hub connection; people find out when they open a meeting).

## Constraints check

| Constraint | This feature |
|---|---|
| E2EE invariant | The api only counts bytes and decides which tracks the SFU forwards — never touches media or keys. |
| $0 running cost | This is the point of the feature. No new services; state is a small file in a Docker volume. |
| No public IP | Unchanged. |
| Open source | No new dependencies. |
| Untrusted server | The server could always refuse or end calls; nothing new it can abuse. Clients see a level, a percent and a reset date only — never Cloudflare account details; at `normal` not even the percent. **New risk:** browser reports feed the estimate, so an admitted participant with a modified client could over-report and trigger an early pause (denial of service, never cost). Mitigated by a per-report cap and Cloudflare's number taking precedence when fresh. |
| Browser support | No new browser APIs. |
| Signaling | One new server→client event (`UsageChanged`) and one new error (`Calls are paused.`); `SubscribeTracks` / `SelectVideoLayer` behave differently by level. |

## Chosen approach

**Enforce in the api** (`UsageGuard`), which controls what the SFU sends — and Cloudflare bills SFU/TURN egress.

- Why not let browsers cap themselves: clients are untrusted; a modified browser would ignore the cap.
- Why not warn only: doesn't guarantee $0.
- Why not hard-stop only: abrupt, no warning, and cutting calls mid-sentence when audio-only would cost ~1% of video.
- Why not fail closed without Cloudflare data: an analytics outage would block calls; the local estimate covers it.

## Design

### 1. What people see

- **Normal** (< 80%): nothing.
- **Saving** (80–95%): a small dismissible banner under the call header for everyone — "Saving bandwidth: 83% of
  this month's free traffic is used. Video is limited to 720p." The quality picker shows Auto / 1080p / 4K
  unavailable with that reason. Newcomers see it once in.
- **AudioOnly** (95–99%): a persistent banner in calls — "This month's free traffic is almost used. Calls are
  audio-only until 1 November." Video tiles show monograms (like a camera that's off); camera and screen-share
  buttons are disabled with the same explanation. Opening a meeting link or starting one shows "Calls are paused
  until 1 November" (lobby-style screen). Reconnects into a call already running still work, audio-only.
- **Paused** (≥ 99%): every call ends with "Calls are paused until 1 November — this month's free traffic is used
  up." Joining shows the same screen.
- **Month reset** (1st, 00:00 UTC): back to Normal; banners disappear in running calls; nothing reconnects by itself
  after Paused.

Text is constant except the percent and date, rendered by interpolation (never through `nz-message`).

### 2. How usage is measured and stored

Two sources:
1. **Cloudflare** — the existing poller: month-to-date SFU + TURN egress every 15 min, with the time of the last
   successful poll.
2. **The api's estimate** — each `ReportCallStats` (every 15 s per browser) carries the bytes that browser received
   (audio + video), i.e. what Cloudflare sent it. Per report: capped at `50 Mbit/s × interval`, counted only for
   admitted members, multiplied by `EstimateFactor` (default 1.1) for TURN relay overhead browsers don't see.

The figure the guard uses (calendar month, UTC):
- **Cloudflare fresh** (last successful poll ≤ 45 min ago): Cloudflare's total + the estimate of traffic from one
  hour before that poll until now (covers analytics delay; double-counts a little — on the safe side).
- **Otherwise**: the estimate for the whole month.

Persistence: `/data/usage.json` in a new volume `api-data` — `{ month, estimateBytes, buckets (5-min, last 24 h),
cloudflare: { bytes, at } }`. Written at most once a minute and on shutdown; loaded at startup; another month →
fresh start. No ids, names or rooms — numbers and timestamps only. The chiseled image needs `/data` created and owned
by the app user in the Dockerfile.

Levels: recomputed every minute and after every poll, against `SavingPercent` / `AudioOnlyPercent` / `PausedPercent`
of the existing `FreeTierGb`. Within a month the level only rises (a late Cloudflare figure can't make it flap); it
drops only at the reset.

Metrics: `cipheroom_usage_guard_level` (0–3), `cipheroom_usage_estimate_bytes`; Free tier dashboard panels for both.

### 3. Enforcement and protocol

Backend:
- Application ports `IUsageLedger` (record received bytes) and `IUsageGuard` (current level / percent / reset date);
  one Infrastructure service `UsageGuard` implements both (`BackgroundService`: minute timer, file, level changes).
- Options `UsageGuard`: `Enabled` (default true), `SavingPercent` 80, `AudioOnlyPercent` 95, `PausedPercent` 99,
  `EstimateFactor` 1.1, `MaxReportMbps` 50, `FreshPollMinutes` 45, `AnalyticsLagMinutes` 60, `DataPath`
  `/data/usage.json`, `ForceLevel` (Development only, for browser tests).
- `ReportCallStats` → `IUsageLedger.Record(receivedBytes, interval)` after its existing validation.

| Level | The api enforces |
|---|---|
| Saving | After `SubscribeTracks` adds a camera, select layer `h` (the SFU starts at `f`). `SelectVideoLayer` with `f` → `h`. On entering Saving: every existing camera subscription → `h`. |
| AudioOnly | `JoinLobby` → `Calls are paused.` unless it's a reconnect into a running call (a valid ticket, or a host proof into a room with people in it). `SubscribeTracks` drops camera and screen tracks silently (a client racing the change gets audio only, no error). On entering AudioOnly: close every video subscription at the SFU and drop them from room state. |
| Paused | End every call: all rooms and lobbies emptied (like `EndCall`), connections told via `UsageChanged`; `JoinLobby` → `Calls are paused.` |

Level transitions run in the hub's context via a small notifier (`IHubContext<RoomHub, IRoomClient>`) so the SFU
calls and broadcasts happen once per transition, not per request.

Frontend:
- `SignalingService.usage` signal from `UsageChanged`.
- `MediaService`: Saving → send capped at 720p (quality picker limited); AudioOnly/Paused → camera and screen share
  off (camera kept as a muted placeholder: no renegotiation), no video subscriptions, buttons disabled.
- `Room`: `usage-banner` component (Saving dismissible, AudioOnly persistent); lobby screen gains `paused` (refused
  join, or the end at Paused); on Paused the room tears down like a removal (no automatic rejoin).
- Home unchanged.

### 4. Failure modes

| Case | Behaviour |
|---|---|
| No analytics token | Estimate only (errs high via the factor); one startup log line. |
| Cloudflare API down > 45 min | Whole-month estimate until polls succeed again. |
| api restart | Estimate and last Cloudflare reading from the file; at most a minute of reports lost. |
| File missing / corrupt | Start from zero with a warning; the first Cloudflare poll corrects it (without a token, that month's estimate restarts — documented). |
| Volume not writable | Warning at startup; guard works in memory. |
| Over-reporting client | Per-report cap; worst case an early pause (DoS), never a bill; Cloudflare's number takes precedence when fresh. |
| Level changes mid-negotiation | `SubscribeTracks` filters server-side, so video never leaks past AudioOnly. |
| Month boundary | UTC everywhere; the level returns to Normal at the reset. |

## Protocol changes

| Direction | Method | Args | Notes |
|---|---|---|---|
| S→C | `UsageChanged` | `UsageDto { level: 'normal' \| 'saving' \| 'audio-only' \| 'paused', percent: number \| null, resetsAt: string }` | sent to each connection when it connects and to everyone on a level change (a server-wide broadcast); `percent` null at `normal`; `resetsAt` ISO-8601 UTC |

Changed behaviour: `JoinLobby` → `Calls are paused.` (AudioOnly for new calls, Paused for all); `SubscribeTracks`
drops video at AudioOnly+; `SelectVideoLayer` `f` → `h` at Saving.

New error: `Calls are paused.`

Updated together: `IRoomClient` + hub, `signaling.types.ts` + `SignalingService`, `docs/signaling-protocol.md`
(events table, errors table, a "Usage guard" section), functional tests.

## Security notes

- No key, media or name is involved; the guard sees byte counts from reports that already exist.
- Metadata: anyone who connects learns the level (and, above Normal, the percent and reset date) — how much this
  server is used this month. Nothing at Normal.
- Abuse: over-reporting can only bring a pause forward (DoS by an admitted participant); capped per report, and
  Cloudflare's number wins when fresh. Under-reporting can't lower the figure below Cloudflare's.
- The usage file holds numbers and timestamps only; not secret, not personal.
- `ForceLevel` is honoured only in the Development environment (never in the compose stack's Production).

## Testing

- Unit (FakeTimeProvider): level from usage and thresholds; rises only within a month; month reset; figure with fresh
  vs stale Cloudflare data and the one-hour overlap; per-report cap and factor; file round-trip, corrupt file, month
  change; Saving layer rewrite; AudioOnly video filtering; `JoinLobby` refusal vs reconnect (ticket / host into a
  running call).
- Functional (hub): `UsageChanged` on connect and on change; `Calls are paused.` for new calls; ticket reconnect
  allowed at AudioOnly; video dropped from `SubscribeTracks`; Paused ends calls (room and lobby).
- Frontend: banner per level (dismissible vs persistent), disabled camera/screen buttons, 720p cap, paused lobby
  screen, no rejoin after Paused.
- Browser (headless Chromium against `scripts/dev.sh`, which runs the api in Development so `ForceLevel` works):
  Saving → AudioOnly → Paused with two people; then a normal-level smoke run on the home stack.

## As built (deviations from the sections above)

- **Lobbies at audio-only:** `Admit` is refused too (`Calls are paused.`), and reaching audio-only empties every
  lobby — otherwise a host could still let a new person in, and guests would wait forever. A waiting guest's browser
  shows the paused screen.
- **Trying it out:** the guard reads its options through `IOptionsMonitor` and re-evaluates on change; in Development
  the api also loads the git-ignored `artifacts/dev-settings.json` (reloaded on change), so `ForceLevel` can move a
  live call between levels.
- **Start-up:** the guard loads its file in `StartAsync` (in .NET 10 `ExecuteAsync` runs in the background), so the
  first `JoinLobby` already sees the restored level.
- **Thresholds may have decimals** (0.01–100, e.g. `REALTIME_SAVING_PERCENT=0.1` to try saving out early); levels
  compare the exact share, and the percent shown is rounded down but at least 1 once anything is used.
- The call header hides connection and encryption state on the lobby-style screens (paused, removed, ended), which
  showed "Connecting… Securing…" there.

## Open questions

- Is 50 Mbit/s the right per-report cap? (4K VP9 at the top layer is ~20–25 Mbit/s; screen share can spike.)
- Cloudflare analytics delay: one hour assumed; check against real polls and adjust `AnalyticsLagMinutes`.

## Implementation steps

1. Options + `UsageGuardOptions` validation; Application ports `IUsageLedger`, `IUsageGuard`; level calculation as a
   pure function with unit tests.
2. Infrastructure `UsageGuard` (`BackgroundService`): ledger buckets, the usage figure (Cloudflare + estimate), file
   persistence, minute timer, poller hook; unit/integration tests.
3. `ReportCallStats` records received bytes (cap, factor, members only).
4. Enforcement: `JoinLobby` refusal rules, `SubscribeTracks` video filter, `SelectVideoLayer` cap, layer `h` after
   subscribing at Saving; unit + functional tests.
5. Transitions: notifier broadcasting `UsageChanged` (and on connect), Saving → move cameras to `h`, AudioOnly → close
   video subscriptions, Paused → end all calls; functional tests.
6. Deploy: `api-data` volume, `/data` in the Dockerfile, `.env` variables, `scripts/secrets.sh`; metrics + Free tier
   dashboard panels.
7. Frontend: `UsageChanged` in signaling types/service; `MediaService` caps (720p, audio-only); `usage-banner`; paused
   lobby screen; specs.
8. Docs (`signaling-protocol.md`, `architecture.md`, `observability.md`, `docker-deploy` skill, README roadmap) and a
   browser run through all levels with `ForceLevel`.
