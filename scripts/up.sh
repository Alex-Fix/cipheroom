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

# Media provider (MEDIA_MODE): each needs its own settings; checked here, values never printed.
env_value() { grep -E "^$1=" "$DEPLOY_DIR/.env" | tail -1 | cut -d= -f2- || true; }
case "$(env_value MEDIA_MODE)" in
  livekit)
    [[ -n "$(env_value LIVEKIT_API_KEY)" ]] && grep -Eq '^LIVEKIT_API_SECRET=.{32,}' "$DEPLOY_DIR/.env" \
      || die "MEDIA_MODE=livekit needs LIVEKIT_API_KEY and LIVEKIT_API_SECRET (32+ characters) — run scripts/secrets.sh"
    [[ -n "$(env_value LIVEKIT_NODE_IP)" ]] \
      || warn "LIVEKIT_NODE_IP is empty: LiveKit advertises 127.0.0.1 (fine on this machine only)"
    COMPOSE+=(--profile livekit) ;;
  ""|cloudflare)
    [[ -n "$(env_value CF_SFU_APP_ID)" && -n "$(env_value CF_SFU_APP_SECRET)" ]] \
      || die "set CF_SFU_APP_ID and CF_SFU_APP_SECRET in deploy/.env (see scripts/secrets.sh)" ;;
  *) die "MEDIA_MODE must be cloudflare or livekit" ;;
esac

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

# AGPL §13: the "Source code" link opens the commit the images are built from — only when nothing that goes into them
# (web/, src/, deploy/, build props) differs from it, untracked files included; otherwise the link opens the repository.
if [[ -z "$(git -C "$ROOT" status --porcelain -- web src deploy global.json 'Directory.*.props' 2>/dev/null)" ]]; then
  SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
  [[ -n "$(git -C "$ROOT" branch -r --contains HEAD 2>/dev/null)" ]] \
    || warn "commit $(git -C "$ROOT" rev-parse --short HEAD) isn't pushed yet: the Source link 404s until it is"
else
  SOURCE_COMMIT=
  warn "uncommitted changes: the Source link will point to the repository, not a commit"
fi
export SOURCE_COMMIT

# --remove-orphans: containers of services that were removed from the compose file (e.g. the old livekit) go too.
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
