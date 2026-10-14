#!/usr/bin/env bash
# Build and start the compose stack.
#   --tunnel         also start cloudflared (public hostname)
#   --observability  also start the telemetry stack (Grafana at /grafana/) and make the api export to it
#   --direct         no Cloudflare: serve https://<LIVEKIT_NODE_IP> from this machine (needs MEDIA_MODE=livekit, a public
#                    IPv4 in LIVEKIT_NODE_IP and ports 80, 443, 7881, 7882/udp, 3478/udp, 30000-30100/udp reaching it);
#                    then scripts/ip-cert.sh gets the certificate (docs/deployment-hetzner.md → Direct mode)
source "$(dirname "$0")/_common.sh"
require_env

OBSERVABILITY=false
DIRECT=false
for arg in "$@"; do
  case "$arg" in
    --tunnel) COMPOSE+=(--profile tunnel) ;;
    --observability) OBSERVABILITY=true ;;
    --direct) DIRECT=true ;;
    *) die "unknown option: $arg (use --tunnel, --observability, --direct)" ;;
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

if [[ "$DIRECT" == true ]]; then
  [[ " ${COMPOSE[*]} " != *" --profile tunnel "* ]] || die "--direct and --tunnel exclude each other"
  [[ "$(env_value MEDIA_MODE)" == livekit ]] || die "--direct needs MEDIA_MODE=livekit (no Cloudflare in this mode)"
  [[ -z "$(env_value LIVEKIT_TURN_DOMAIN)" ]] || die "--direct serves TURN over TLS on the IP: leave LIVEKIT_TURN_DOMAIN empty"
  ip="$(env_value LIVEKIT_NODE_IP)"
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "--direct needs this machine's public IPv4 in LIVEKIT_NODE_IP"
  edge_dir="$DEPLOY_DIR/edge"
  mkdir -p "$edge_dir/tls" "$edge_dir/acme" "$edge_dir/letsencrypt"
  # LiveKit's TURN behind edge: TLS ends at edge, plain TCP to 5349; browsers are told turns:<ip>:443.
  # Host network: media only on the public IP (not Docker's bridges, which its own TURN relay can't answer from).
  { awk -v ip="$ip" '{ print } /^rtc:/ { print "  ips:"; print "    includes: [\"" ip "/32\"]" }' "$DEPLOY_DIR/livekit/livekit.yaml"
    printf '%s\n' "turn:" "  enabled: true" "  domain: $ip" "  tls_port: 5349" \
      "  external_tls: true" "  udp_port: 3478" "  relay_range_start: 30000" "  relay_range_end: 30100"; } >"$edge_dir/livekit.yaml"
  # edge needs a certificate to start: a self-signed placeholder until scripts/ip-cert.sh has Let's Encrypt's.
  if [[ ! -f "$edge_dir/tls/fullchain.pem" ]]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=cipheroom-placeholder \
      -addext "subjectAltName=IP:$ip" -keyout "$edge_dir/tls/privkey.pem" -out "$edge_dir/tls/fullchain.pem" 2>/dev/null
    chmod 644 "$edge_dir/tls/fullchain.pem" "$edge_dir/tls/privkey.pem" # placeholder only; ip-cert.sh restricts the real key
  fi
  export LIVEKIT_CONFIG=./edge/livekit.yaml PUBLIC_HOST="$ip" \
    API_ALLOWED_HOSTS="$ip;localhost"
  COMPOSE+=(--profile direct)
fi

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
if [[ "$DIRECT" == true ]]; then
  info "Next: scripts/ip-cert.sh (Let's Encrypt certificate for $ip; then twice a day from cron, see its header)"
fi
