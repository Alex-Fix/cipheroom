# Connection diagnostics — design
Status: approved · Date: 2026-10-10

## Problem

Since the move to Cloudflare Realtime SFU (#6) the connection diagnostics drawer is hidden and only shows the ICE path.
When a call is bad, a participant can't tell whether the problem is their own network, and the operator has to open
Grafana (optional stack, ~15 s granularity, no per-browser view) to find out. Testing from a phone on mobile data or a
restrictive network has no quick in-call answer either.

## Goals / Non-goals

Goals
- Every participant can open **Connection** from the call's "More" menu: a plain verdict plus details about their own
  link to the SFU (path, network numbers, what they send and what limits it, encryption health).
- A small amber **"Poor connection"** chip in the header when one's own connection stays bad (~10 s).
- **Copy report**: a plain-text snapshot (no IPs, names, room id or participant ids) to paste to whoever helps.

Non-goals
- Per-remote-participant receive stats, quality bars on tiles.
- A force-relay toggle in the UI (stays a server setting, `ForceRelay`).
- Sending anything new to the server; changing call-quality telemetry.

## Constraints check

| Constraint | This feature |
|---|---|
| E2EE invariant | ✅ Reads only the browser's `getStats()` and `CryptoService` counters. Encryption section shows counts and the key epoch, never key material. |
| $0 running cost | ✅ No new services or traffic. |
| No public IP | ✅ Unchanged. |
| Open source | ✅ Existing ng-zorro components only. |
| Untrusted server | ✅ Server learns nothing new. The copied report leaves out IPs, names, room id and participant ids and goes only where the user pastes it. |
| Browser support | ⚠️ `qualityLimitationReason` and per-layer `active` are Chrome/Safari only: Firefox shows "—" and the rules that need them are skipped. |
| Signaling | ✅ No hub or protocol changes. |

## Chosen approach

Client-only. A pure module `web/src/app/core/media/connection-health.ts` turns two stats snapshots (reusing
`statsSnapshot` / `selectedIcePath`) into a `ConnectionReport` and a verdict. `MediaService` exposes it as a
`connection` signal (replacing `diagnostics`) on the existing 2 s cadence; components stay presentational and never
touch the peer connection.

- *Why not server-side telemetry fed back:* an extra round trip, and the server would hand data back it never needs.

## Design

### User flow
- "More" menu → **Connection** (last item) opens a right drawer (360 px; full width on phones), updating live.
- When the verdict stays `poor` for 5 readings (~10 s), an amber **Poor connection** chip appears next to the
  Encrypted badge; tapping it opens the drawer. It hides after 5 good readings in a row (hysteresis). `relay` alone
  never shows the chip.

### Verdict (recomputed every 2 s over the last window; first match wins)

| Verdict | When | Text |
|---|---|---|
| `unknown` | Not connected / no selected candidate pair / reconnecting | "Connecting…" / "Reconnecting…" |
| `poor` | Loss ≥ 5% either way (over ≥ 50 packets), or RTT ≥ 300 ms, or the camera limited by `bandwidth`/`cpu` and sending below the chosen quality (screen shares ramp up slowly and often report `bandwidth` while fine, so only the camera counts) | "Poor connection" + reasons ("8% packet loss", "slow upload — sending 360p instead of 1080p") |
| `relay` | Through TURN, otherwise fine | "Connected through a relay (TLS)" — neutral note |
| `good` | Otherwise | "Good connection" |

Upload loss from `remote-inbound-rtp` (the SFU's view); download loss from `inbound-rtp`. Thresholds are named
constants, to be tuned after a mobile-data test.

### Drawer sections
1. **Verdict** — icon, sentence, reasons.
2. **Route** — "Direct to Cloudflare (UDP)" or "Via TURN relay (TCP/TLS)", RTT, "Relay forced by server: yes/no"
   (`RtcConfig.forceRelay`). The remote address (Cloudflare edge) is shown here but never in the copied report.
3. **Network** — upload / download kbps, loss % each way, jitter.
4. **Sending** — camera, screen, microphone: codec, resolution @ fps, kbps; for video the active simulcast layers and
   the quality limitation (bandwidth / CPU / —). Muted/off shown as such; "Video paused by usage guard" at
   audio-only/paused.
5. **Encryption** — "Keys from N of M people" (`secured`), key epoch, frames encrypted / decrypted / failed / missing
   key, dropped envelopes by reason (only when non-zero).
6. **Copy report** — browser/OS family (`callPlatform`), sections 1–5 as text. Toast "Report copied". (The app
   doesn't know its commit — only nginx's `/source` does — so the report leaves it out.)

### Components and boundaries
- `core/media/connection-health.ts` — pure: `connectionReport(prev, next, context)` → `ConnectionReport`
  (incl. `verdict`, `reasons`); `reportText(report)` for the clipboard; `PoorStreak` for the chip hysteresis.
- `MediaService` — `connection` signal (replaces `diagnostics`/`Diagnostics`); keeps its own previous snapshot;
  resets the baseline on reconnect / ICE restart.
- `CryptoService` — read-only access to the key epoch alongside existing `telemetry()` / `droppedEnvelopes` / `secured`.
- `features/room/connection-drawer/` — rebuilt from `diagnostics-drawer` (presentational: inputs `open`, `report`,
  `encryption`; output `closed`, `copy`).
- `call-controls` — "Connection" menu item; `call-header` — the chip; `room` — owns drawer state and the copy action.

### Data and state
Memory only, per call; nothing persisted, nothing sent.

### Failure modes
- Reconnect / ICE restart → `unknown` ("Reconnecting…"), baseline reset (no negative bitrates), chip streak reset.
- Tab throttled → interval > 10 s: re-baseline, show nothing for the gap.
- Missing stat → "—" and excluded from rules (Firefox has no `qualityLimitationReason`).
- Clipboard blocked → show the report text selected in a read-only box for manual copy.
- Usage guard audio-only/paused → missing video isn't a problem; verdict ignores it.

## Protocol changes

None.

## Security notes
- No key material anywhere in the report or UI; the epoch is a counter.
- Copied report: no IP addresses, display names, room id, participant ids or device keys (asserted by a unit test).
- Remote address in the drawer is the Cloudflare edge/TURN address; the local address is never shown.
- No new data reaches the api, Cloudflare or telemetry.

## Testing
- `connection-health.spec.ts` (pure, canned stats fixtures from Chrome, Safari, Firefox): each verdict rule and
  threshold, missing Firefox fields, counter reset after reconnect, long gaps, `reportText` contains no IP/id/name.
- Chip hysteresis (5 bad on / 5 good off) with a fake clock.
- `ConnectionDrawer` spec: each verdict, empty states, copy (clipboard stubbed + blocked fallback).
- `CallHeader` / `CallControls` specs: chip shows and opens the drawer; menu item present.
- No backend or protocol tests (nothing changes). No real devices: stubbed `getStats` only.

## Open questions
- Thresholds (5% loss, 300 ms RTT) — tune after testing a phone on mobile data.

## Implementation steps
Branch `feat/connection-diagnostics`, one commit each:
1. `connection-health.ts`: report + verdict + report text, with tests.
2. `MediaService`: `connection` signal on the 2 s cadence replacing `diagnostics`; resets on reconnect.
3. `ConnectionDrawer` (rebuild of `diagnostics-drawer`) wired into the "More" menu and `room`.
4. Encryption section from `CryptoService` counters and key epoch.
5. Copy report with the clipboard fallback.
6. "Poor connection" header chip with hysteresis.
7. Docs: README roadmap + Features, `media` skill debugging note.
