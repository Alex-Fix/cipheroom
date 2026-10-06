#!/usr/bin/env bash
# Create deploy/.env from .env.example (if missing) and generate LiveKit API key/secret.
# Usage: scripts/secrets.sh [--force]   (--force rotates existing generated secrets)
source "$(dirname "$0")/_common.sh"

env_file="$DEPLOY_DIR/.env"
if [[ ! -f "$env_file" ]]; then
  [[ -f "$DEPLOY_DIR/.env.example" ]] || die "deploy/.env.example missing"
  cp "$DEPLOY_DIR/.env.example" "$env_file"
  info "Created deploy/.env from example"
fi

set_var() {
  local name=$1 value=$2 current
  current="$(grep -E "^$name=" "$env_file" | cut -d= -f2- || true)"
  if [[ -n "$current" && "${FORCE:-0}" != 1 ]]; then
    info "$name already set (use --force to rotate)"; return
  fi
  if grep -qE "^$name=" "$env_file"; then
    sed -i.bak "s|^$name=.*|$name=$value|" "$env_file" && rm -f "$env_file.bak"
  else
    echo "$name=$value" >> "$env_file"
  fi
  info "$name generated"
}

[[ "${1:-}" == "--force" ]] && FORCE=1

set_var LIVEKIT_API_KEY "API$(openssl rand -hex 6)"
set_var LIVEKIT_API_SECRET "$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48)"

chmod 600 "$env_file"
warn "Fill in manually: CF_TURN_KEY_ID, CF_TURN_API_TOKEN, TUNNEL_TOKEN"
