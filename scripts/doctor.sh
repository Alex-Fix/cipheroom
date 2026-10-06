#!/usr/bin/env bash
# Check the local toolchain.
source "$(dirname "$0")/_common.sh"

ok=1
check() {
  local name=$1 cmd=$2 hint=$3 required=${4:-1}
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %-12s %s\n' "$name" "$("$cmd" --version 2>/dev/null | head -1)"
  else
    printf '  \033[31m✗\033[0m %-12s missing — %s\n' "$name" "$hint"; (( required )) && ok=0 || true
  fi
}

info "Required"
check dotnet dotnet "https://dot.net (SDK 10.x)"
check node   node   "brew install node"
check npm    npm    "comes with node"
check docker docker "Docker Desktop / OrbStack"
info "Optional"
check mkcert      mkcert      "brew install mkcert  (LAN HTTPS testing)" 0
check cloudflared cloudflared "brew install cloudflared (only for tunnel)" 0

if command -v dotnet >/dev/null && ! dotnet --list-sdks | grep -q '^10\.'; then
  warn ".NET 10 SDK not found"; ok=0
fi
docker compose version >/dev/null 2>&1 || { warn "docker compose plugin missing"; ok=0; }

(( ok )) && info "All required tools present" || die "Fix the items above"
