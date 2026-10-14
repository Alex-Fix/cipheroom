#!/usr/bin/env bash
# Let's Encrypt certificate for this machine's IP address, for the edge proxy of `scripts/up.sh --direct` (on a Hetzner
# server Ansible does this instead, with a systemd timer). IP certificates are short-lived (160 hours) and only issued
# through the HTTP check on port 80, which edge answers. Issues the first time, renews when due (about half-way), copies
# the certificate for edge and reloads it gracefully. Run it twice a day, e.g. from cron:
#   17 */12 * * * cd /path/to/cipheroom && scripts/ip-cert.sh >/dev/null
# Guide: docs/deployment-hetzner.md → Direct mode
source "$(dirname "$0")/_common.sh"
require_env

edge_dir="$DEPLOY_DIR/edge"
ip="$(grep -E '^LIVEKIT_NODE_IP=' "$DEPLOY_DIR/.env" | tail -1 | cut -d= -f2- || true)"
[[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "set this machine's public IPv4 in LIVEKIT_NODE_IP (deploy/.env)"
[[ -d "$edge_dir/acme" ]] || die "start the stack first: scripts/up.sh --direct"
"${COMPOSE[@]}" --profile edge ps --status running edge | grep -q edge || die "edge isn't running: scripts/up.sh --direct"

certbot() {
  # The pinned image from docker-compose.yml (profile certs), kept current by Dependabot.
  "${COMPOSE[@]}" --profile certs run --rm --no-deps -v "$edge_dir/letsencrypt:/etc/letsencrypt" \
    -v "$edge_dir/acme:/acme-webroot" certbot "$@"
}
if [[ -f "$edge_dir/letsencrypt/live/cipheroom/fullchain.pem" ]]; then
  certbot renew --quiet
else
  info "Asking Let's Encrypt for a certificate for $ip (port 80 must reach this machine)"
  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot -w /acme-webroot \
    --preferred-profile shortlived --cert-name cipheroom --ip-address "$ip"
fi

# Let's Encrypt's files are root's (written in the container): copy them in a container too, readable by edge's
# nginx (uid 101) and nobody else. Reload only when they changed.
changed="$("${COMPOSE[@]}" --profile certs run --rm --no-deps -v "$edge_dir/letsencrypt:/le:ro" -v "$edge_dir/tls:/tls" \
  --entrypoint sh certbot -c '
  live=/le/live/cipheroom
  if cmp -s "$live/fullchain.pem" /tls/fullchain.pem && cmp -s "$live/privkey.pem" /tls/privkey.pem; then exit 0; fi
  install -o 0 -g 101 -m 0640 "$live/privkey.pem" /tls/privkey.pem
  install -o 0 -g 101 -m 0640 "$live/fullchain.pem" /tls/fullchain.pem
  echo changed')"
if [[ "$changed" == changed ]]; then
  "${COMPOSE[@]}" --profile edge exec -T edge nginx -s reload
  info "edge now uses the new certificate — https://$ip"
fi
