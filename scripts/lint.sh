#!/usr/bin/env bash
# Verify formatting/lint. Pass --fix to apply fixes.
source "$(dirname "$0")/_common.sh"

if [[ "${1:-}" == "--fix" ]]; then
  dotnet format "$ROOT/Cipheroom.slnx"
else
  info "dotnet format"; dotnet format "$ROOT/Cipheroom.slnx" --verify-no-changes
fi

if [[ -d "$WEB_DIR" ]] && npm run --prefix "$WEB_DIR" 2>/dev/null | grep -q '^  lint$'; then
  info "ng lint"; npm run lint --prefix "$WEB_DIR" ${1:+-- --fix}
else
  warn "web lint not configured (ng add angular-eslint)"
fi
