"""
Generates the provisioned Grafana dashboards: Overview, Call quality, Free tier, Host & containers.
Edit this file, then regenerate the JSON (it's what Grafana loads; dashboards are read-only in the UI):

    python3 deploy/observability/grafana/build_dashboards.py deploy/observability/grafana/dashboards

Metric names are the Prometheus ones (see docs/plans/2026-10-07-observability-design.md → "What gets recorded").
"""
import json, os, sys

OUT = sys.argv[1]
PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}
TEMPO = {"type": "tempo", "uid": "tempo"}
RI = "$__rate_interval"


class Board:
    def __init__(self, uid, title, description, variables=()):
        self.uid, self.title, self.description = uid, title, description
        self.panels, self.y, self.next_id = [], 0, 1
        self.variables = list(variables)

    def row(self, title):
        self.panels.append({"type": "row", "title": title, "id": self._id(), "collapsed": False,
                            "gridPos": {"h": 1, "w": 24, "x": 0, "y": self.y}, "panels": []})
        self.y += 1

    def add(self, panels, h):
        x = 0
        for p in panels:
            w = p.pop("_w")
            p["id"] = self._id()
            p["gridPos"] = {"h": h, "w": w, "x": x, "y": self.y}
            x += w
            self.panels.append(p)
        self.y += h

    def _id(self):
        self.next_id += 1
        return self.next_id - 1

    def json(self):
        return {
            "uid": self.uid, "title": self.title, "description": self.description,
            "tags": ["cipheroom"], "timezone": "browser", "editable": False, "graphTooltip": 1,
            "time": {"from": "now-6h", "to": "now"}, "refresh": "1m", "schemaVersion": 41, "version": 1,
            "templating": {"list": self.variables}, "annotations": {"list": []},
            "links": [{"title": "Cipheroom", "type": "dashboards", "tags": ["cipheroom"], "asDropdown": True}],
            "panels": self.panels,
        }


def target(expr, legend="", ref="A", instant=False):
    t = {"refId": ref, "datasource": PROM, "expr": expr, "legendFormat": legend}
    if instant:
        t["instant"], t["range"] = True, False
    return t


def series(title, exprs, w=12, unit="short", description="", stack=False, min0=True, decimals=None):
    fc = {"unit": unit, "custom": {"fillOpacity": 15 if stack else 8, "lineWidth": 2,
                                   "stacking": {"mode": "normal" if stack else "none"}}}
    if min0:
        fc["min"] = 0
    if decimals is not None:
        fc["decimals"] = decimals
    return {"_w": w, "type": "timeseries", "title": title, "description": description, "datasource": PROM,
            "targets": [target(e, l, chr(65 + i)) for i, (e, l) in enumerate(exprs)],
            "fieldConfig": {"defaults": fc, "overrides": []},
            "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}}


def stat(title, expr, w=4, unit="short", description="", thresholds=None, mappings=None, decimals=None, no_value="—"):
    steps = thresholds or [{"color": "green", "value": None}]
    fc = {"unit": unit, "noValue": no_value, "thresholds": {"mode": "absolute", "steps": steps},
          "mappings": mappings or []}
    if decimals is not None:
        fc["decimals"] = decimals
    return {"_w": w, "type": "stat", "title": title, "description": description, "datasource": PROM,
            "targets": [target(expr, instant=True)],
            "fieldConfig": {"defaults": fc, "overrides": []},
            "options": {"colorMode": "value", "graphMode": "none", "reduceOptions": {"calcs": ["lastNotNull"]}}}


def gauge(title, expr, w=6, description=""):
    return {"_w": w, "type": "gauge", "title": title, "description": description, "datasource": PROM,
            "targets": [target(expr, instant=True)],
            "fieldConfig": {"defaults": {"unit": "percent", "min": 0, "max": 100, "decimals": 2,
                                         "thresholds": {"mode": "absolute", "steps": [
                                             {"color": "green", "value": None}, {"color": "orange", "value": 70},
                                             {"color": "red", "value": 90}]}}, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "showThresholdMarkers": True}}


def pie(title, expr, legend, w=6, description=""):
    return {"_w": w, "type": "piechart", "title": title, "description": description, "datasource": PROM,
            "targets": [target(expr, legend, instant=True)],
            "fieldConfig": {"defaults": {"unit": "percentunit"}, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "pieType": "donut",
                        "legend": {"displayMode": "list", "placement": "right", "values": ["percent"]}}}


def logs(title, expr, w=12, description=""):
    return {"_w": w, "type": "logs", "title": title, "description": description, "datasource": LOKI,
            "targets": [{"refId": "A", "datasource": LOKI, "expr": expr, "queryType": "range"}],
            "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending",
                        "enableLogDetails": True}}


def traces(title, query, w=12, description=""):
    return {"_w": w, "type": "table", "title": title, "description": description, "datasource": TEMPO,
            "targets": [{"refId": "A", "datasource": TEMPO, "queryType": "traceql", "query": query, "limit": 20}],
            "options": {"showHeader": True}}


def var(name, label, query):
    return {"name": name, "label": label, "type": "query", "datasource": PROM,
            "query": {"query": query, "refId": "v"}, "definition": query, "refresh": 2,
            "includeAll": True, "multi": True, "allValue": ".*", "current": {"text": "All", "value": "$__all"}}


UP = [{"type": "special", "options": {"match": "null", "result": {"text": "Down", "color": "red"}}},
      {"type": "range", "options": {"from": 1, "to": 1e9, "result": {"text": "Up", "color": "green"}}}]
GB = 1e9

# ── Overview ────────────────────────────────────────────────────────────────────────────────────────────────────
b = Board("cipheroom-overview", "Cipheroom · Overview",
          "Is the api up, what are people doing, and is Cloudflare answering. Room and participant ids are only in "
          "traces and logs (pseudonymous), never in these metrics.")
b.add([
    stat("API", "count(cipheroom_rooms_active)", 4, mappings=UP,
         description="Up while the api exports metrics (every 30 s).", no_value="Down",
         thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}]),
    stat("Rooms", "sum(cipheroom_rooms_active)", 4),
    stat("Participants", "sum(cipheroom_participants_active)", 4),
    stat("SignalR connections", "sum(signalr_server_active_connections)", 4),
    stat("Hub errors (1 h)", 'sum(increase(cipheroom_hub_calls_total{outcome="failed"}[1h])) or vector(0)', 4, decimals=0,
         thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
    stat("SFU failures (1 h)", 'sum(increase(cipheroom_sfu_request_duration_seconds_count{outcome="failed"}[1h])) or vector(0)', 4,
         decimals=0, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
], 4)
b.row("Signaling")
b.add([
    series("Hub calls by method", [(f"sum by (method) (rate(cipheroom_hub_calls_total[{RI}]))", "{{method}}")], 12, "reqps"),
    series("Rejected, failed, cancelled", [(f'sum by (outcome) (rate(cipheroom_hub_calls_total{{outcome!="ok"}}[{RI}]))', "{{outcome}}")], 6, "reqps",
           "rejected = refused with a client message (bad input, not in a room…); failed = unexpected error; cancelled = the client went away."),
    series("Rate-limited calls", [(f"sum by (method) (rate(cipheroom_hub_rate_limited_total[{RI}]))", "{{method}}")], 6, "reqps"),
], 8)
b.add([
    series("Rooms and participants", [("sum(cipheroom_rooms_active)", "rooms"), ("sum(cipheroom_participants_active)", "participants")], 12),
    series("Key envelopes relayed", [(f"sum(rate(cipheroom_key_envelopes_relayed_total[{RI}]))", "envelopes/s")], 12, "short",
           "E2EE key rotations: one envelope per recipient, on every join and leave."),
], 7)
b.row("Cloudflare SFU")
b.add([
    series("SFU latency p95 by operation", [(f"histogram_quantile(0.95, sum by (le, operation) (rate(cipheroom_sfu_request_duration_seconds_bucket[{RI}])))", "{{operation}}")], 12, "s"),
    series("SFU requests by outcome", [(f"sum by (outcome) (rate(cipheroom_sfu_request_duration_seconds_count[{RI}]))", "{{outcome}}")], 12, "reqps"),
], 8)
b.row("Logs and traces")
b.add([
    logs("Api warnings and errors", '{service_name="cipheroom-api"} | severity_number >= 13', 12,
         "Severity Warning and above. Room ids appear only as keyed hashes."),
    traces("Recent failed hub calls", '{resource.service.name="cipheroom-api" && status = error}', 12,
           "Click a trace id to open it in Tempo; its logs are linked from there."),
], 10)
overview = b

# ── Call quality ────────────────────────────────────────────────────────────────────────────────────────────────
F = 'platform=~"$platform", path=~"$path"'
b = Board("cipheroom-call-quality", "Cipheroom · Call quality",
          "What browsers report every 15 s (numbers only): bitrate, loss, jitter, RTT, freezes, resolution, and "
          "end-to-end encryption health.",
          [var("platform", "Platform", "label_values(cipheroom_call_bytes_total, platform)"),
           var("path", "Path", "label_values(cipheroom_call_bytes_total, path)")])
b.add([
    stat("Reporting browsers", f"sum(rate(cipheroom_call_reports_total{{platform=~\"$platform\"}}[2m])) * 15", 4, decimals=0,
         description="≈ browsers in a call right now (each reports every 15 s)."),
    stat("Packet loss (received)", f'sum(rate(cipheroom_call_packets_lost_total{{{F}}}[5m])) / (sum(rate(cipheroom_call_packets_lost_total{{{F}}}[5m])) + sum(rate(cipheroom_call_packets_total{{direction="received", {F}}}[5m])))', 4, "percentunit", decimals=2,
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.02}, {"color": "red", "value": 0.05}]),
    stat("RTT p95", f'histogram_quantile(0.95, sum by (le) (rate(cipheroom_call_rtt_seconds_bucket{{{F}}}[5m])))', 4, "s",
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.15}, {"color": "red", "value": 0.3}]),
    stat("Video frozen", f'sum(rate(cipheroom_call_freeze_duration_seconds_total{{platform=~"$platform"}}[5m])) / (sum(rate(cipheroom_call_reports_total{{platform=~"$platform"}}[5m])) * 15)', 4, "percentunit", decimals=2,
         description="Share of received-video time spent frozen.",
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.01}, {"color": "red", "value": 0.05}]),
    stat("Decrypt failures", 'sum(rate(cipheroom_e2ee_frames_total{result="failed"}[5m])) / sum(rate(cipheroom_e2ee_frames_total{result=~"decrypted|failed"}[5m]))', 4, "percentunit", decimals=3,
         description="Frames that failed authentication: should be ~0 (tampering, corruption, or a key mix-up).",
         thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 0.001}]),
    stat("Relayed (TURN)", f'(sum(rate(cipheroom_call_bytes_total{{path="relay", platform=~"$platform"}}[15m])) or vector(0)) / sum(rate(cipheroom_call_bytes_total{{platform=~"$platform"}}[15m]))', 4, "percentunit", decimals=1,
         description="Share of media going through Cloudflare TURN instead of straight to the SFU."),
], 4)
b.row("Media")
b.add([
    series("Received bitrate", [(f'sum by (kind) (rate(cipheroom_call_bytes_total{{direction="received", {F}}}[{RI}])) * 8', "{{kind}}")], 12, "bps", stack=True),
    series("Sent bitrate", [(f'sum by (kind) (rate(cipheroom_call_bytes_total{{direction="sent", {F}}}[{RI}])) * 8', "{{kind}}")], 12, "bps", stack=True),
], 8)
b.add([
    series("Packet loss by platform", [(f'sum by (platform) (rate(cipheroom_call_packets_lost_total{{{F}}}[{RI}])) / (sum by (platform) (rate(cipheroom_call_packets_lost_total{{{F}}}[{RI}])) + sum by (platform) (rate(cipheroom_call_packets_total{{direction="received", {F}}}[{RI}])))', "{{platform}}")], 8, "percentunit", decimals=2),
    series("Jitter p95", [(f'histogram_quantile(0.95, sum by (le, kind) (rate(cipheroom_call_jitter_seconds_bucket{{{F}}}[{RI}])))', "{{kind}}")], 8, "s"),
    series("RTT to Cloudflare", [(f'histogram_quantile(0.5, sum by (le, path) (rate(cipheroom_call_rtt_seconds_bucket{{{F}}}[{RI}])))', "p50 {{path}}"), (f'histogram_quantile(0.95, sum by (le, path) (rate(cipheroom_call_rtt_seconds_bucket{{{F}}}[{RI}])))', "p95 {{path}}")], 8, "s"),
], 8)
b.add([
    series("Received video height (median)", [(f'histogram_quantile(0.5, sum by (le, platform) (rate(cipheroom_call_video_height_bucket{{platform=~"$platform"}}[{RI}])))', "{{platform}}")], 8, "none",
           "Median of the tallest received stream per report (simulcast layer actually delivered)."),
    series("Received frame rate (median)", [(f'histogram_quantile(0.5, sum by (le, platform) (rate(cipheroom_call_video_fps_per_second_bucket{{platform=~"$platform"}}[{RI}])))', "{{platform}}")], 8, "none"),
    series("Video frozen per minute", [(f'sum by (platform) (rate(cipheroom_call_freeze_duration_seconds_total{{platform=~"$platform"}}[{RI}])) * 60', "{{platform}}")], 8, "s"),
], 8)
b.row("End-to-end encryption")
b.add([
    series("Frames by result", [(f"sum by (result) (rate(cipheroom_e2ee_frames_total[{RI}]))", "{{result}}")], 8, "short",
           "encrypted / decrypted = normal; missing_key = dropped while waiting for someone's key; failed = authentication failure."),
    series("Time spent “Securing…”", [(f'sum(rate(cipheroom_e2ee_securing_duration_seconds_total{{platform=~"$platform"}}[{RI}])) * 60', "seconds per minute")], 8, "s",
           "Summed over everyone waiting for a key — spikes on joins are normal, long plateaus are not."),
    series("Key envelopes dropped by browsers", [(f"sum(rate(cipheroom_e2ee_envelopes_dropped_total[{RI}]))", "dropped/s")], 8, "short",
           "Should stay ~0: rejected signatures, wrong recipient, replays."),
], 8)
quality = b

# ── Free tier ───────────────────────────────────────────────────────────────────────────────────────────────────
USED = "sum(cipheroom_realtime_egress_bytes)"
LIMIT = "max(cipheroom_realtime_free_tier_bytes)"
ELAPSED = "(day_of_month() - 1 + hour() / 24 + minute() / 1440)"
b = Board("cipheroom-free-tier", "Cipheroom · Free tier",
          "Cloudflare Realtime egress this calendar month (UTC), as Cloudflare counts it. SFU and TURN share 1 TB/month "
          "free; past that it's $0.05/GB. Polled every 15 minutes.")
b.add([
    gauge("Free tier used", f"{USED} / {LIMIT} * 100", 6),
    stat("Egress this month", USED, 4, "decbytes", decimals=2),
    stat("Projected month end", f"{USED} / {ELAPSED} * days_in_month()", 4, "decbytes", decimals=1,
         description="Straight-line projection from the month so far.",
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 700 * GB}, {"color": "red", "value": 1000 * GB}]),
    stat("SFU", 'sum(cipheroom_realtime_egress_bytes{service="sfu"})', 3, "decbytes", decimals=2),
    stat("TURN", 'sum(cipheroom_realtime_egress_bytes{service="turn"})', 3, "decbytes", decimals=2),
    stat("Last poll", "time() - max(cipheroom_realtime_polled_seconds)", 4, "s", decimals=0,
         description="Age of the newest usage figure. Empty: no Cloudflare analytics token — see the estimate below.",
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 3600}, {"color": "red", "value": 7200}]),
], 6)
b.add([
    series("Egress this month", [('sum by (service) (cipheroom_realtime_egress_bytes)', "{{service}}"), (LIMIT, "free tier")], 12, "decbytes", stack=False),
    series("Egress in the last 24 h", [(f"clamp_min({USED} - sum(cipheroom_realtime_egress_bytes offset 1d), 0)", "last 24 h")], 6, "decbytes",
           description="Resets with the month."),
    series("Usage polls", [("sum by (outcome) (increase(cipheroom_realtime_polls_total[1h]))", "{{outcome}}")], 6, "short"),
], 8)
b.row("Without a Cloudflare analytics token")
b.add([
    stat("Estimate from browser reports (last 7 days)", 'sum(increase(cipheroom_call_bytes_total{direction="received"}[7d]))', 8, "decbytes", decimals=2,
         description="What browsers say they received ≈ SFU egress (TURN not included). Prometheus keeps 7 days, so this can't cover a whole month."),
    series("Received by browsers per hour", [('sum(increase(cipheroom_call_bytes_total{direction="received"}[1h]))', "received")], 16, "decbytes"),
], 6)
free = b

# ── Host & containers ───────────────────────────────────────────────────────────────────────────────────────────
C = 'name=~"cipheroom-.+"'
b = Board("cipheroom-host", "Cipheroom · Host & containers",
          "The machine and every container, including the observability stack itself. On Docker Desktop (macOS) "
          "\"host\" is the Linux VM that runs the containers.")
b.add([
    stat("CPU", '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))', 4, "percent", decimals=0,
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 70}, {"color": "red", "value": 90}]),
    stat("Memory used", "100 * (1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))", 4, "percent", decimals=0,
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 80}, {"color": "red", "value": 92}]),
    # Linux host: "/"; Docker Desktop: the VM disk holding images and volumes.
    stat("Docker disk used", '100 * (1 - min(node_filesystem_avail_bytes{mountpoint=~"/|/var/lib/docker"}) / max(node_filesystem_size_bytes{mountpoint=~"/|/var/lib/docker"}))', 4, "percent", decimals=0,
         description="The disk holding Docker images and volumes (incl. all telemetry).",
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 80}, {"color": "red", "value": 90}]),
    stat("Uptime", "time() - max(node_boot_time_seconds)", 4, "s", decimals=0),
    stat("Containers", f'count(container_last_seen{{{C}}})', 4),
    stat("Prometheus storage", "sum(prometheus_tsdb_storage_blocks_bytes)", 4, "decbytes", decimals=1, description="Capped at 5 GB / 7 days."),
], 4)
b.row("Host")
b.add([
    series("CPU", [('100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[' + RI + '])))', "busy")], 8, "percent"),
    series("Memory", [("sum(node_memory_MemTotal_bytes) - sum(node_memory_MemAvailable_bytes)", "used"), ("sum(node_memory_MemTotal_bytes)", "total")], 8, "bytes"),
    series("Network", [(f'sum(rate(node_network_receive_bytes_total{{device!~"lo|veth.*|docker.*|br-.*"}}[{RI}])) * 8', "in"), (f'sum(rate(node_network_transmit_bytes_total{{device!~"lo|veth.*|docker.*|br-.*"}}[{RI}])) * 8', "out")], 8, "bps"),
], 7)
b.row("Containers")
b.add([
    series("CPU by container", [(f"sum by (name) (rate(container_cpu_usage_seconds_total{{{C}}}[{RI}]))", "{{name}}")], 12, "percentunit"),
    series("Memory by container (working set)", [(f"sum by (name) (container_memory_working_set_bytes{{{C}}})", "{{name}}")], 12, "bytes"),
], 8)
b.add([
    series("Memory vs limit", [(f'sum by (name) (container_memory_working_set_bytes{{{C}}}) / sum by (name) (container_spec_memory_limit_bytes{{{C}}} > 0)', "{{name}}")], 12, "percentunit",
           "Containers with a mem_limit (the observability stack). Near 100 % they get killed and restarted."),
    series("Network by container", [(f"sum by (name) (rate(container_network_receive_bytes_total{{{C}}}[{RI}]) + rate(container_network_transmit_bytes_total{{{C}}}[{RI}])) * 8", "{{name}}")], 12, "bps"),
], 8)
b.row("Telemetry pipeline and api runtime")
b.add([
    series("Collector: received per signal", [(f"sum(rate(otelcol_receiver_accepted_spans[{RI}]))", "spans"), (f"sum(rate(otelcol_receiver_accepted_metric_points[{RI}]))", "metric points"), (f"sum(rate(otelcol_receiver_accepted_log_records[{RI}]))", "log records")], 8, "short"),
    series("Collector: refused or failed", [(f"sum(rate(otelcol_receiver_refused_spans[{RI}])) + sum(rate(otelcol_receiver_refused_metric_points[{RI}])) + sum(rate(otelcol_receiver_refused_log_records[{RI}]))", "refused"), (f"sum(rate(otelcol_receiver_failed_spans[{RI}])) + sum(rate(otelcol_receiver_failed_metric_points[{RI}])) + sum(rate(otelcol_receiver_failed_log_records[{RI}]))", "failed")], 8, "short",
           "Should stay at 0."),
    series("Api runtime", [('sum(dotnet_gc_last_collection_heap_size_bytes{service_name="cipheroom-api"})', "GC heap"), ('sum(dotnet_process_memory_working_set_bytes{service_name="cipheroom-api"})', "working set")], 8, "bytes"),
], 7)
host = b

os.makedirs(OUT, exist_ok=True)
for board, name in [(overview, "overview"), (quality, "call-quality"), (free, "free-tier"), (host, "host")]:
    with open(os.path.join(OUT, f"{name}.json"), "w") as f:
        json.dump(board.json(), f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(name, len(board.panels), "panels")
