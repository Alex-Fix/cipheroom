#!/usr/bin/env bash
# Create deploy/.env from .env.example (if missing), lock its permissions, and list required values still empty.
# Nothing is generated: every secret comes from the Cloudflare dashboard.
# Usage: scripts/secrets.sh
source "$(dirname "$0")/_common.sh"

env_file="$DEPLOY_DIR/.env"
if [[ ! -f "$env_file" ]]; then
  [[ -f "$DEPLOY_DIR/.env.example" ]] || die "deploy/.env.example missing"
  cp "$DEPLOY_DIR/.env.example" "$env_file"
  info "Created deploy/.env from example"
fi
chmod 600 "$env_file"

# name|where to get it
required=(
  "CF_SFU_APP_ID|Cloudflare dashboard → Realtime → SFU → create application"
  "CF_SFU_APP_SECRET|same SFU application (app secret)"
  "CF_TURN_KEY_ID|Cloudflare dashboard → Realtime → TURN → create key (fallback for restrictive networks)"
  "CF_TURN_API_TOKEN|same TURN key (API token)"
  "TUNNEL_TOKEN|Zero Trust → Networks → Tunnels (only for scripts/up.sh --tunnel)"
)
missing=0
for entry in "${required[@]}"; do
  name="${entry%%|*}"
  value="$(grep -E "^$name=" "$env_file" | cut -d= -f2- || true)"
  if [[ -z "$value" ]]; then
    warn "$name is empty — ${entry#*|}"
    missing=1
  fi
done
[[ $missing == 0 ]] && info "deploy/.env has every required value"
exit 0
