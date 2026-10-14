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
  --env-file "$DEPLOY_DIR/.env.example" --profile observability --profile tunnel --profile livekit --profile edge --profile certs config -q
if docker info >/dev/null 2>&1; then
  # Each telemetry backend checks our config with the version in docker-compose.yml, so an image update that drops a
  # setting fails here, not on a server (Tempo 3 removed `compactor` and crash-looped on the beta).
  image_of() { awk -v svc="  $1:" '$0 == svc { f = 1 } f && /image:/ { print $2; exit }' "$DEPLOY_DIR/docker-compose.yml"; }
  obs="$DEPLOY_DIR/observability"
  docker run --rm -v "$obs/tempo.yaml:/c.yaml:ro" "$(image_of tempo)" -config.file=/c.yaml -config.verify=true >/dev/null 2>&1 \
    || die "deploy/observability/tempo.yaml is invalid for $(image_of tempo)"
  docker run --rm -v "$obs/loki.yaml:/c.yaml:ro" "$(image_of loki)" -config.file=/c.yaml -verify-config >/dev/null 2>&1 \
    || die "deploy/observability/loki.yaml is invalid for $(image_of loki)"
  docker run --rm -v "$obs/otel-collector.yaml:/c.yaml:ro" "$(image_of otel-collector)" validate --config=/c.yaml >/dev/null 2>&1 \
    || die "deploy/observability/otel-collector.yaml is invalid for $(image_of otel-collector)"
  docker run --rm --entrypoint promtool -v "$obs:/cfg:ro" "$(image_of prometheus)" \
    check config /cfg/prometheus.yaml >/dev/null || die "deploy/observability/prometheus.yaml is invalid"
else
  warn "docker not running: skipped the telemetry config checks"
fi
dashboards="$(mktemp -d)"
python3 "$DEPLOY_DIR/observability/grafana/build_dashboards.py" "$dashboards" >/dev/null
diff -rq "$dashboards" "$DEPLOY_DIR/observability/grafana/dashboards" >/dev/null \
  || die "dashboards are out of date: python3 deploy/observability/grafana/build_dashboards.py deploy/observability/grafana/dashboards"
rm -rf "$dashboards"

# The edge proxy (INGRESS_MODE=direct) is a whole nginx.conf: test it in its own image with a throwaway certificate.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  info "nginx (edge)"
  edge_image="$(awk '/^  edge:/ { f = 1 } f && /image:/ { print $2; exit }' "$DEPLOY_DIR/docker-compose.yml")"
  edge_tls="$(mktemp -d)"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=lint \
    -keyout "$edge_tls/privkey.pem" -out "$edge_tls/fullchain.pem" 2>/dev/null
  chmod 644 "$edge_tls"/*.pem
  docker run --rm -v "$DEPLOY_DIR/nginx/edge.conf:/etc/nginx/nginx.conf:ro" -v "$edge_tls:/tls:ro" --entrypoint nginx "$edge_image" -t -q \
    || die "deploy/nginx/edge.conf is invalid"
  rm -rf "$edge_tls"
else
  warn "docker not running: skipped the edge nginx check"
fi

# Infrastructure as code (docs/deployment-hetzner.md) — each check runs when its tool is installed.
if command -v terraform >/dev/null; then
  info "terraform"
  tf_dir="$DEPLOY_DIR/terraform/hetzner"
  terraform -chdir="$tf_dir" fmt -check -recursive >/dev/null || die "terraform files need formatting: terraform -chdir=$tf_dir fmt"
  terraform -chdir="$tf_dir" init -backend=false -input=false >/dev/null && terraform -chdir="$tf_dir" validate -no-color >/dev/null \
    || die "deploy/terraform/hetzner is invalid: terraform -chdir=$tf_dir validate"
else
  warn "terraform not installed: skipped terraform validate"
fi
if command -v ansible-playbook >/dev/null; then
  info "ansible"
  (cd "$DEPLOY_DIR/ansible" && ansible-playbook -i inventory.example.ini site.yml --syntax-check >/dev/null) \
    || die "deploy/ansible/site.yml has syntax errors"
  if command -v ansible-lint >/dev/null; then
    (cd "$DEPLOY_DIR/ansible" && ansible-lint -q site.yml) || die "ansible-lint found problems in deploy/ansible"
  else
    warn "ansible-lint not installed: skipped (brew install ansible-lint)"
  fi
else
  warn "ansible not installed: skipped the playbook check"
fi
if command -v shellcheck >/dev/null; then
  info "shellcheck"; shellcheck -S warning -x -P "$ROOT/scripts" "$ROOT/scripts/provision.sh" "$ROOT/scripts/deploy.sh" "$ROOT/scripts/up.sh" "$ROOT/scripts/ip-cert.sh"
else
  warn "shellcheck not installed: skipped (brew install shellcheck)"
fi

if [[ -d "$WEB_DIR" ]] && npm run --prefix "$WEB_DIR" 2>/dev/null | grep -q '^  lint$'; then
  info "ng lint"; npm run lint --prefix "$WEB_DIR" ${1:+-- --fix}
else
  warn "web lint not configured (ng add angular-eslint)"
fi
