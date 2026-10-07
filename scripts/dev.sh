#!/usr/bin/env bash
# Run the API (dotnet watch) and the Angular dev server together. Ctrl+C stops both.
# Media goes through Cloudflare Realtime SFU, so the API needs its credentials: they are read from deploy/.env
# (CF_SFU_APP_ID / CF_SFU_APP_SECRET, plus TURN if set). Other LAN devices also need HTTPS: scripts/certs.sh.
source "$(dirname "$0")/_common.sh"
require_dir "$API_DIR"
require_dir "$WEB_DIR"

[[ -d "$WEB_DIR/node_modules" ]] || (info "Installing web deps"; npm ci --prefix "$WEB_DIR")

# Read single values from deploy/.env without executing it.
env_value() { [[ -f "$DEPLOY_DIR/.env" ]] && grep -E "^$1=" "$DEPLOY_DIR/.env" | cut -d= -f2- || true; }
sfu_app_id="$(env_value CF_SFU_APP_ID)"
[[ -n "$sfu_app_id" ]] || warn "CF_SFU_APP_ID not set in deploy/.env — calls will fail (run scripts/secrets.sh)"

trap 'kill 0' EXIT INT TERM

info "API  → http://localhost:5080"
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://localhost:5080 \
  Sfu__Cloudflare__AppId="$sfu_app_id" \
  Sfu__Cloudflare__AppSecret="$(env_value CF_SFU_APP_SECRET)" \
  Turn__Cloudflare__KeyId="$(env_value CF_TURN_KEY_ID)" \
  Turn__Cloudflare__ApiToken="$(env_value CF_TURN_API_TOKEN)" \
  dotnet watch --project "$API_DIR" --no-hot-reload 2>&1 | sed -u 's/^/[api] /' &

info "Web  → http://localhost:4200"
npm start --prefix "$WEB_DIR" 2>&1 | sed -u 's/^/[web] /' &

wait
