# Observability: tracing, telemetry, logging, Grafana — design
Status: approved · Date: 2026-10-07

## Problem

The api only logs to the console; there are no metrics, no traces and no history. When a call misbehaves there's no
way to see what the api and Cloudflare did, how calls actually performed in browsers, how close we are to the
Cloudflare Realtime free tier (1 TB/month), or how the home machine is coping.

## Goals / Non-goals

Goals
- **Server:** structured logs, a trace per hub call (with the Cloudflare SFU/TURN requests inside it), metrics.
- **Call quality:** browsers report aggregated WebRTC stats and E2EE health.
- **Free-tier usage:** month-to-date Cloudflare Realtime egress against 1 TB.
- **Host & containers:** CPU, memory, disk, network.
- Self-hosted Grafana with provisioned dashboards, reachable at `https://cipheroom.alexfix.dev/grafana` behind
  Cloudflare Access.
- Pseudonymous telemetry: hashed room ids, no IPs, no names; 7-day retention.

Non-goals
- Alerting (dashboards only for now; Grafana alert rules can come later).
- The usage guard itself (refusing calls near the limit) — this only provides the numbers it will need.
- Browser-side distributed tracing / OpenTelemetry JS SDK.
- Grafana Cloud or any hosted telemetry backend.

## Constraints check

| Constraint | Answer |
|---|---|
| E2EE invariant | ✅ Telemetry never contains keys, envelopes, SDP, media or names. Browser reports are numbers only. |
| $0 | ✅ All open source, at home. Cloudflare Access (≤ 50 users) and the Analytics API are free. Cost: ~1–1.5 GB RAM, capped disk. |
| No public IP | ✅ Grafana via the existing tunnel and nginx at `/grafana/`; no new ports, no new hostname. |
| Open source | ✅ OpenTelemetry, Prometheus, Loki, Tempo, Grafana, node-exporter, cAdvisor. Cloudflare Access is SaaS, like the tunnel we already use. |
| Untrusted server / metadata | ⚠️ New metadata *at home*: call timing, coarse browser platform, quality numbers. Pseudonymous, 7 days, documented in the README privacy model. Grafana must never be reachable without Access. |
| Browser support | ✅ Only `getStats()` (already used). |
| Signaling | New hub method `ReportCallStats` (signaling-protocol skill), rate-limited, members only. |

## Chosen approach

**A — OpenTelemetry on the server; browsers send aggregated summaries over SignalR.** The api uses the
OpenTelemetry .NET SDK and exports OTLP to an OpenTelemetry Collector, which feeds Prometheus (metrics), Loki (logs)
and Tempo (traces); Grafana reads all three. Browsers send one small `ReportCallStats` every 15 s through the hub.

- Why not the OpenTelemetry JS SDK in the browser: ~60–100 KB more JS and a public `/otlp` ingest endpoint anyone
  could spam, bypassing the hub's room checks and rate limits.
- Why not Grafana Cloud: call metadata would leave the house (self-hosting and privacy model).
- Why not the all-in-one `grafana/otel-lgtm` image or the Aspire dashboard: dev-oriented, little control over
  retention/versions; Aspire has no persistence or dashboards.

## Design

### 1. Components and data flow

```
api ──OTLP (logs, traces, metrics)──▶ otel-collector ──▶ Prometheus (metrics, 7 d)
 ▲  ReportCallStats (SignalR)                       ├──▶ Loki      (logs, 7 d)
 │                                                  └──▶ Tempo     (traces, 7 d)
browsers                     node-exporter, cAdvisor ──▶ Prometheus (scrape)
api ──GraphQL poll (15 min)──▶ Cloudflare Analytics      Grafana ◀── reads all three
cloudflared ─▶ web (nginx) ─/grafana/─▶ Grafana          (Cloudflare Access on /grafana*)
```

**Backend (Clean Architecture)**
- **Api** — composition only: `AddTelemetry()` wires OpenTelemetry tracing (ASP.NET Core, SignalR hub invocations,
  HttpClient), metrics (runtime, ASP.NET Core, our meter) and logging, exported via OTLP. Without an OTLP endpoint
  configured nothing is exported; console logging is unchanged.
- **Application** — `CipheroomMetrics` (one `Meter`); the Mediator `LoggingBehaviour` also opens a span per command;
  port `IRealtimeUsage`.
- **Infrastructure** — `CloudflareAnalyticsClient` (typed HttpClient, GraphQL, source-generated JSON) and
  `RealtimeUsagePoller` (`BackgroundService`); room-id hashing and the attribute-stripping span processor.

**Frontend** — `MediaService` (already reading `getStats()` every 250 ms) aggregates 15 s windows and sends one
`ReportCallStats`; `CryptoService` contributes its counters. Components are not involved.

**Deploy** — compose profile `observability` with `otel-collector`, `prometheus`, `loki`, `tempo`, `grafana`,
`node-exporter`, `cadvisor`; config under `deploy/observability/`; no published ports; `mem_limit` per container
(total ≈ 1.5 GB). Grafana: provisioned data sources and dashboards (JSON in git), admin password from `deploy/.env`,
login required, anonymous off, `GF_SERVER_ROOT_URL=https://<PUBLIC_HOST>/grafana/`,
`GF_SERVER_SERVE_FROM_SUB_PATH=true`.

**nginx** — `location /grafana/` proxies to `grafana:3000` (incl. WebSocket upgrade for Grafana Live). The upstream
is resolved at request time (Docker DNS `resolver` + variable `proxy_pass`) so nginx starts without Grafana; with the
profile off `/grafana/` is a 502 and the call app is unaffected. This location sets its **own complete header set**
(Grafana-compatible CSP + `Referrer-Policy`, `X-Content-Type-Options`, `frame-ancestors 'none'`), because a
location-level `add_header` drops the server-level ones.

**Cloudflare Access** — one self-hosted application for `cipheroom.alexfix.dev/grafana` (path prefix, so everything
below it), policy: email one-time code for the owner's address. Set up once in the dashboard; documented, no code.

### 2. What gets recorded

**Never** (enforced in code and tests): keys, envelopes, SDP, ICE candidates, display names, IP addresses, plain room
ids, user agents. A span processor removes `client.address`, `url.full`, user agent and the SignalR connection id
that default instrumentation adds.

**Identifiers** — `room` = first 16 hex chars of `HMAC-SHA256(TELEMETRY_SECRET, roomId)`; `TELEMETRY_SECRET` is
random, in `deploy/.env`, created by `scripts/secrets.sh`. `participant` = the existing random per-call id. Both only
in logs and traces — never as metric labels (bounded Prometheus cardinality).

**Traces** — one span per hub call (`RoomHub/<Method>`) with `room`, `participant`, `outcome` (ok / rejected:
constant message / failed); child spans for the Mediator command and each Cloudflare request (method, status; no
URL). The hub spans come from our own `HubTelemetryFilter` (a new root per invocation); SignalR's built-in spans are
off (`EnableAspNetCoreSignalRSupport = false`) — they'd duplicate ours and parent to the long-lived connection.
Sampling happens in the collector (tail sampling: 100 % of errors, 25 % of the rest, configurable); the api records
every trace.

**Logs** — existing `[LoggerMessage]` logs to Loki with trace and span ids, Information and above (configurable).
Room ids in logs are hashed too (`TelemetryIds`). `System.Net.Http.HttpClient` logging is at Warning: its
Information logs carry full Cloudflare URLs (TURN key id, SFU app and session ids) — found by the step 2 tests.

**Metrics** (low-cardinality labels only)

| Metric | Labels |
|---|---|
| `cipheroom_rooms_active`, `cipheroom_participants_active` | — |
| `cipheroom_hub_calls_total` | `method`, `outcome` |
| `cipheroom_rate_limited_total` | `method` |
| `cipheroom_sfu_request_duration_seconds` | `operation`, `outcome` |
| `cipheroom_key_envelopes_relayed_total` | — |
| `cipheroom_realtime_egress_bytes` (month to date) | `service` (turn/sfu), `source` (cloudflare/estimate) |
| `cipheroom_call_*` (browser reports) | `platform`, `path` (direct/relay), `kind` (audio/video) |

Instruments are defined in `CipheroomMetrics` (Application, meter `Cipheroom`) with OpenTelemetry names
(`cipheroom.hub.calls`, `cipheroom.sfu.request.duration` in seconds, …); the collector's Prometheus exporter turns
them into the names above (`_total` for counters, unit suffix for histograms). Hub call outcomes:
`ok` / `rejected` / `failed` / `cancelled`; SFU operations: `create_session`, `publish`, `subscribe`, `renegotiate`,
`restart_ice`, `close_tracks`, `select_layer`.

**Browser report** (`ReportCallStats`, every 15 s, ≤ 1 KB): per direction and kind — bytes, packets lost, jitter,
RTT, frames decoded, frozen time, resolution, fps; ICE path (direct/relay); E2EE — frames encrypted / decrypted /
failed, envelopes dropped by reason, time spent "Securing…". `platform` is computed in the browser into ~6 buckets
(`ios-safari`, `android-chrome`, `desktop-chrome`, `desktop-safari`, `desktop-firefox`, `other`).

### 3. Usage poller and dashboards

**`RealtimeUsagePoller`** — every 15 min, Cloudflare GraphQL Analytics for month-to-date egress (calendar month,
from the 1st 00:00 UTC), account-wide (the free tier is per account):
- SFU: `callsUsageAdaptiveGroups { sum { egressBytes ingressBytes } }`
- TURN: `callsTurnUsageAdaptiveGroups { sum { egressBytes ingressBytes } }`

Both confirmed in step 1 (filter `date_geq` / `date_leq`, `viewer.accounts(filter: { accountTag })`). Token:
separate, *Account Analytics: Read* only, `CF_ANALYTICS_API_TOKEN` (+ `CF_ACCOUNT_ID`), never logged. Without a
token the api publishes no usage gauge; the Free tier dashboard falls back to an estimate from browser reports
(`cipheroom_call_bytes_total{direction="received"}` this month ≈ SFU egress) — a PromQL panel, not api code.
Gauges: `cipheroom_realtime_egress_bytes{service}` (month to date), `cipheroom_realtime_free_tier_bytes`,
`cipheroom_realtime_polled_seconds` (last good poll, Unix time), `cipheroom_realtime_polls_total{outcome}`. The
poller (Infrastructure, `BackgroundService`) resolves the usage source in a fresh scope per poll, so its typed
HttpClient's handler still rotates. Failures → status code logged once, exponential backoff, gauge keeps its last value. Free-tier limit
(1,000 GB) is configuration. The future usage guard will read the same numbers.

**Dashboards** (provisioned)
1. **Overview** — api up, active rooms / participants, hub calls/s and errors, rate-limit hits, SFU latency/failures.
2. **Call quality** — loss, RTT, jitter, freezes, resolution by platform and path; E2EE decrypt failures, time
   "Securing…".
3. **Free tier** — month-to-date egress vs 1 TB, daily burn, projected month end.
4. **Host & containers** — CPU, memory, disk, network; memory per container (incl. the observability stack).

Trace ↔ logs links in Grafana via trace id.

### 4. Data and state

All telemetry lives in named Docker volumes at home. Retention: 7 days in every store; Prometheus also has a 5 GB
size cap (Loki and Tempo only expire by time — their volume is small at our scale; the host dashboard shows disk).
The collector reports its own health (received / exported / failed per signal) to Prometheus. The api exports
metrics every 30 s (`OTEL_METRIC_EXPORT_INTERVAL`), matching the scrape interval. Images are pinned: collector-contrib
0.162.0, Prometheus v3.15.0, Loki 3.7.8, Tempo 2.10.8 (3.x later), Grafana 13.2.3, node-exporter v1.12.1, cAdvisor
v0.55.1. On Docker Desktop, cAdvisor needs the Docker and containerd sockets mounted explicitly
(`/var/run` resolves to macOS). Nothing survives beyond that; nothing leaves the machine except the Analytics API queries
(outbound, read-only, our own account's numbers).

### 5. Failure modes

| Situation | Behaviour |
|---|---|
| Profile off / collector down | OTLP exporter drops after a short timeout; api unaffected; `/grafana/` 502; calls unaffected. |
| Store disk filling | Time + size retention caps; host dashboard shows disk. |
| Analytics token missing/invalid | Logged once, backoff; `source=estimate`. |
| Junk browser stats | Validator rejects (`Invalid stats.`), rate limits apply, values capped — at worst skews graphs. |
| Observability stack RAM | `mem_limit` per container, ≈ 1.5 GB total. |
| Access misconfigured | Grafana login still required; `security-check.sh <url>` flags `/grafana/` answering without Access. |

## Protocol changes

| Direction | Method | Args | Returns |
|---|---|---|---|
| C→S | `ReportCallStats` | `CallStatsDto` (fixed shape, ≤ 1 KB, numbers finite / non-negative / capped, `platform` from a fixed list) | — |

Members only (`Join a room first.`), no broadcast, no reply data; invalid → `Invalid stats.`. Accepted and dropped
when telemetry is off, so clients never need to know. C# (`RoomHub`, contracts), TS (`signaling.types.ts`,
`SignalingService`) and `docs/signaling-protocol.md` change together.

## Security notes

- Grafana holds call metadata: only behind Cloudflare Access (path policy) **and** Grafana login; anonymous off.
- `/grafana/` gets its own, complete security-header set (Grafana needs inline scripts); the rest of the app keeps
  the strict CSP. `security-check.sh` verifies both.
- Pseudonymous by construction: keyed room-id hash, no IPs or user agents (stripped by a span processor — tested),
  no names; participant ids are random per call.
- New secrets in `deploy/.env` only: `TELEMETRY_SECRET`, `GRAFANA_ADMIN_PASSWORD`, `CF_ANALYTICS_API_TOKEN`
  (read-only analytics scope).
- E2EE checklist: no key material, envelopes or frame contents in any telemetry; browser reports carry counts only.
- Browser reports are untrusted input: validated, capped, rate-limited, never logged raw.

## Testing

- Backend unit: room-id hash (stable, keyed, input never present); span processor strips forbidden attributes;
  `ReportCallStats` validator; `CloudflareAnalyticsClient` against a stubbed handler (parsing, month window,
  failures, backoff).
- Functional: `ReportCallStats` valid / invalid / before joining; with an in-memory exporter, a hub call yields one
  span with hashed `room` and no forbidden attributes, and the Cloudflare request as a child span.
- Frontend: 15 s aggregation from `getStats()` samples; platform bucketing; reports stop when the call ends.
- Config: `docker compose --profile observability config` and `promtool check config` in `scripts/lint.sh`.
- Manual (home stack): dashboards fill during a two-device call; a `PublishTracks` trace shows the Cloudflare child
  span; `/grafana` from mobile data asks for the Access code; profile off → app unaffected.

## Open questions

- ~~Does Cloudflare's GraphQL Analytics expose Realtime SFU egress?~~ **Yes (step 1, 2026-10-07):**
  `callsUsageAdaptiveGroups` (SFU) and `callsTurnUsageAdaptiveGroups` (TURN), both with `sum { egressBytes
  ingressBytes }`, account-wide, daily `date` filters. Month to date at the time: SFU 0.180 GB, TURN 0.020 GB egress.
- Exact Grafana-compatible CSP for `/grafana/` (Grafana's `content_security_policy` template vs nginx) — settle in
  step 4.
- Host metrics on macOS Docker Desktop: node-exporter sees the Linux VM, not macOS itself — acceptable for now
  (document it).

## Implementation steps

On `feat/observability`, one commit each:

1. ~~**Spike:** query Cloudflare GraphQL for TURN and SFU usage with a real token; record the SFU answer here.~~
   Done — see Open questions.
2. **api telemetry plumbing:** OpenTelemetry SDK, OTLP export (off without endpoint), attribute-stripping processor,
   room-id hash, trace ↔ log correlation, sampling.
3. **Metrics + instrumentation:** `CipheroomMetrics`; hub calls, rooms/participants, rate limits, SFU latency,
   envelopes.
4. **Compose `observability` profile:** collector, Prometheus, Loki, Tempo, Grafana (sub-path), node-exporter,
   cAdvisor; limits and retention; nginx `/grafana/` with its own headers.
5. **`ReportCallStats` end to end:** protocol, validator, metrics, browser aggregation in `MediaService` /
   `CryptoService`.
6. **`RealtimeUsagePoller` + `CloudflareAnalyticsClient`.**
7. **Provisioned dashboards:** Overview, Call quality, Free tier, Host & containers.
8. **Scripts and docs:** `up.sh --observability`, `secrets.sh`, `security-check.sh`, `lint.sh`;
   `docs/observability.md` (access, Cloudflare Access setup, what's recorded), `architecture.md`, README privacy
   model, `docker-deploy` / `security` skills, protocol doc.
