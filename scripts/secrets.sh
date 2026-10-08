#!/usr/bin/env bash
# Create deploy/.env from .env.example (if missing), lock its permissions, and list values still empty.
# Cloudflare secrets come from the Cloudflare dashboard; only TELEMETRY_SECRET (a random key nobody needs to know)
# is generated here — written to the file, never printed.
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

# Observability (scripts/up.sh --observability) — docs/observability.md
value_of() { grep -E "^$1=" "$env_file" | cut -d= -f2- || true; }

if [[ -z "$(value_of TELEMETRY_SECRET)" ]]; then
  secret="$(openssl rand -hex 32)"
  tmp="$(mktemp)"
  if grep -qE '^TELEMETRY_SECRET=' "$env_file"; then
    awk -v s="$secret" '/^TELEMETRY_SECRET=/{print "TELEMETRY_SECRET=" s; next} {print}' "$env_file" > "$tmp"
  else
    cat "$env_file" > "$tmp"; printf 'TELEMETRY_SECRET=%s\n' "$secret" >> "$tmp"
  fi
  cat "$tmp" > "$env_file"; rm -f "$tmp"
  info "Generated TELEMETRY_SECRET (pseudonymous room ids in logs and traces)"
fi

optional=(
  "GRAFANA_ADMIN_PASSWORD|choose one (12+ characters) and type it into deploy/.env with an editor — needed for --observability"
  "CF_ACCOUNT_ID|the hex id in your dashboard URL — free-tier usage from Cloudflare (otherwise estimated)"
  "CF_ANALYTICS_API_TOKEN|My Profile → API Tokens → Custom: only Account Analytics: Read"
)
for entry in "${optional[@]}"; do
  name="${entry%%|*}"
  [[ -z "$(value_of "$name")" ]] && warn "$name is empty (optional) — ${entry#*|}"
done
exit 0
