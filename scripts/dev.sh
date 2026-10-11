#!/usr/bin/env bash
# Run the API (dotnet watch) and the Angular dev server together. Ctrl+C stops both.
# Media goes through a local LiveKit server in Docker (container cipheroom-dev-livekit, media on localhost
# 7881/tcp + 7882/udp) with throwaway dev keys — no accounts or credentials needed. Other LAN devices also need
# HTTPS: scripts/certs.sh.
#   --cloudflare   Cloudflare Realtime SFU instead: credentials from deploy/.env (CF_SFU_APP_ID / CF_SFU_APP_SECRET,
#                  plus TURN if set)
source "$(dirname "$0")/_common.sh"
require_dir "$API_DIR"
require_dir "$WEB_DIR"

[[ -d "$WEB_DIR/node_modules" ]] || (info "Installing web deps"; npm ci --prefix "$WEB_DIR")

LIVEKIT=true
for arg in "$@"; do
  case "$arg" in
    --cloudflare) LIVEKIT=false ;;
    *) die "unknown option: $arg (use --cloudflare)" ;;
  esac
done

# Read single values from deploy/.env without executing it.
env_value() { [[ -f "$DEPLOY_DIR/.env" ]] && grep -E "^$1=" "$DEPLOY_DIR/.env" | cut -d= -f2- || true; }

if [[ "$LIVEKIT" == true ]]; then
  # Throwaway keys for this run only (the secret must be 32+ characters).
  export Media__Provider=LiveKit LiveKit__Url=http://127.0.0.1:7880 LiveKit__ApiKey=devkey
  LiveKit__ApiSecret="$(openssl rand -hex 32)"
  export LiveKit__ApiSecret
  docker rm -f cipheroom-dev-livekit >/dev/null 2>&1 || true
  docker run -d --name cipheroom-dev-livekit \
    -p 127.0.0.1:7880:7880 -p 127.0.0.1:7881:7881 -p 127.0.0.1:7882:7882/udp \
    -e LIVEKIT_KEYS="devkey: $LiveKit__ApiSecret" \
    -v "$DEPLOY_DIR/livekit/livekit.yaml:/etc/livekit.yaml:ro" \
    livekit/livekit-server:v1.13.9 --config /etc/livekit.yaml --node-ip 127.0.0.1 >/dev/null \
    || die "could not start LiveKit (is Docker running?)"
  info "LiveKit → container cipheroom-dev-livekit (signaling 127.0.0.1:7880, relayed by the API)"
  trap 'docker rm -f cipheroom-dev-livekit >/dev/null 2>&1; kill 0' EXIT INT TERM
  sfu_app_id="" sfu_app_secret="" turn_key_id="" turn_api_token=""
else
  sfu_app_id="$(env_value CF_SFU_APP_ID)"
  [[ -n "$sfu_app_id" ]] || warn "CF_SFU_APP_ID not set in deploy/.env — calls will fail (run scripts/secrets.sh)"
  sfu_app_secret="$(env_value CF_SFU_APP_SECRET)"
  turn_key_id="$(env_value CF_TURN_KEY_ID)"
  turn_api_token="$(env_value CF_TURN_API_TOKEN)"
  trap 'kill 0' EXIT INT TERM
fi

info "API  → http://localhost:5080"
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://localhost:5080 \
  Sfu__Cloudflare__AppId="$sfu_app_id" \
  Sfu__Cloudflare__AppSecret="$sfu_app_secret" \
  Turn__Cloudflare__KeyId="$turn_key_id" \
  Turn__Cloudflare__ApiToken="$turn_api_token" \
  dotnet watch --project "$API_DIR" --no-hot-reload 2>&1 | sed -u 's/^/[api] /' &

info "Web  → http://localhost:4200"
npm start --prefix "$WEB_DIR" 2>&1 | sed -u 's/^/[web] /' &

wait
