#!/usr/bin/env bash
# Local HTTPS certs (mkcert) so phones/other machines on the LAN can use camera/mic.
source "$(dirname "$0")/_common.sh"
command -v mkcert >/dev/null || die "brew install mkcert"

lan_ip="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
out="$ROOT/.certs"
mkdir -p "$out"
mkcert -install
mkcert -cert-file "$out/dev.pem" -key-file "$out/dev-key.pem" localhost 127.0.0.1 ::1 ${lan_ip:+"$lan_ip"}
info "Certs in .certs/ (gitignored). Serve web with: npm start --prefix web -- --host 0.0.0.0 --ssl --ssl-cert ../.certs/dev.pem --ssl-key ../.certs/dev-key.pem"
[[ -n "$lan_ip" ]] && info "Open https://$lan_ip:4200 on other devices (install mkcert root CA there: $(mkcert -CAROOT))"
