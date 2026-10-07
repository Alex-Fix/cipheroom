#!/usr/bin/env bash
# Build and start the compose stack.
#   --tunnel         also start cloudflared (public hostname)
#   --observability  also start the telemetry stack (Grafana at /grafana/) and make the api export to it
source "$(dirname "$0")/_common.sh"
require_env

OBSERVABILITY=false
for arg in "$@"; do
  case "$arg" in
    --tunnel) COMPOSE+=(--profile tunnel) ;;
    --observability) OBSERVABILITY=true ;;
    *) die "unknown option: $arg (use --tunnel, --observability)" ;;
  esac
done

if [[ "$OBSERVABILITY" == true ]]; then
  # Grafana would otherwise start with its default admin password. Checked, never printed.
  grep -Eq '^GRAFANA_ADMIN_PASSWORD=.{12,}' "$DEPLOY_DIR/.env" \
    || die "set GRAFANA_ADMIN_PASSWORD (12+ characters) in deploy/.env"
  COMPOSE+=(--profile observability)
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
else
  # The api must not try to export to a collector that isn't running.
  export OTEL_EXPORTER_OTLP_ENDPOINT=
fi

# --remove-orphans: containers of services that were removed from the compose file (e.g. the old livekit) go too.
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
