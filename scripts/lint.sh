#!/usr/bin/env bash
# Verify formatting/lint. Pass --fix to apply fixes.
source "$(dirname "$0")/_common.sh"

if [[ "${1:-}" == "--fix" ]]; then
  dotnet format "$ROOT/Cipheroom.slnx"
else
  info "dotnet format"; dotnet format "$ROOT/Cipheroom.slnx" --verify-no-changes
fi

# Observability config (docs/observability.md): compose with the profile, Prometheus config, dashboards up to date.
info "observability config"
CF_SFU_APP_ID=lint CF_SFU_APP_SECRET=lint docker compose -f "$DEPLOY_DIR/docker-compose.yml" \
  --env-file "$DEPLOY_DIR/.env.example" --profile observability --profile tunnel config -q
if docker info >/dev/null 2>&1; then
  docker run --rm --entrypoint promtool -v "$DEPLOY_DIR/observability:/cfg:ro" prom/prometheus:v3.15.0 \
    check config /cfg/prometheus.yaml >/dev/null || die "deploy/observability/prometheus.yaml is invalid"
else
  warn "docker not running: skipped promtool"
fi
dashboards="$(mktemp -d)"
python3 "$DEPLOY_DIR/observability/grafana/build_dashboards.py" "$dashboards" >/dev/null
diff -rq "$dashboards" "$DEPLOY_DIR/observability/grafana/dashboards" >/dev/null \
  || die "dashboards are out of date: python3 deploy/observability/grafana/build_dashboards.py deploy/observability/grafana/dashboards"
rm -rf "$dashboards"

if [[ -d "$WEB_DIR" ]] && npm run --prefix "$WEB_DIR" 2>/dev/null | grep -q '^  lint$'; then
  info "ng lint"; npm run lint --prefix "$WEB_DIR" ${1:+-- --fix}
else
  warn "web lint not configured (ng add angular-eslint)"
fi
