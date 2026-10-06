#!/usr/bin/env bash
# Security checks: secrets in git, .env hygiene, vulnerable dependencies, live security headers.
# Usage: scripts/security-check.sh [https://cipheroom.alexfix.dev]
source "$(dirname "$0")/_common.sh"
cd "$ROOT"

fail=0
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

info "Secrets in tracked files"
# Cloudflare tunnel tokens (base64 JSON starting {"a":), private keys, filled-in secret assignments.
patterns='eyJhIjoi[A-Za-z0-9+/=_-]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(TUNNEL_TOKEN|CF_TURN_API_TOKEN|CF_TURN_KEY_ID|LIVEKIT_API_SECRET)=[^[:space:]$]+'
if hits="$(git grep -nIE "$patterns" -- . ':!*.lock' ':!**/package-lock.json' 2>/dev/null)"; then
  bad "possible secrets committed:"; printf '%s\n' "$hits" | sed -E 's/(=|eyJhIjoi)[^[:space:]]{6}[^[:space:]]*/\1…<redacted>/' | sed 's/^/      /'
else
  good "no secret patterns in tracked files"
fi

info "deploy/.env"
if [[ -f "$DEPLOY_DIR/.env" ]]; then
  git check-ignore -q "$DEPLOY_DIR/.env" && good "ignored by git" || bad "NOT ignored by git"
  perms="$(stat -f '%Lp' "$DEPLOY_DIR/.env" 2>/dev/null || stat -c '%a' "$DEPLOY_DIR/.env")"
  [[ "$perms" == 600 ]] && good "permissions 600" || bad "permissions $perms (want 600: chmod 600 deploy/.env)"
else
  good "not present (nothing to check)"
fi

info "NuGet vulnerabilities"
if out="$(dotnet list "$ROOT/Cipheroom.slnx" package --vulnerable --include-transitive 2>&1)"; then
  if grep -qE '^\s+> ' <<<"$out"; then bad "vulnerable packages:"; grep -E 'Project|^\s+> ' <<<"$out" | sed 's/^/      /'
  else good "none reported"; fi
else
  bad "dotnet list failed"; sed 's/^/      /' <<<"$out" | tail -5
fi

info "npm vulnerabilities (runtime deps, high+)"
if [[ -d "$WEB_DIR/node_modules" ]]; then
  if npm audit --prefix "$WEB_DIR" --omit=dev --audit-level=high >/dev/null 2>&1; then good "none at high or critical"
  else bad "npm audit found issues: run 'npm audit --prefix web --omit=dev'"; fi
else
  warn "web/node_modules missing, skipped"
fi

if [[ -n "${1:-}" ]]; then
  info "Security headers on $1"
  headers="$(curl -sSI "$1" | tr -d '\r')" || { bad "request failed"; headers=""; }
  for h in content-security-policy referrer-policy permissions-policy x-content-type-options strict-transport-security; do
    if grep -qi "^$h:" <<<"$headers"; then good "$h"
    elif [[ $h == strict-transport-security ]]; then warn "  $h missing: enable HSTS in Cloudflare (SSL/TLS → Edge Certificates)"
    else bad "$h missing"; fi
  done
  grep -qi "^content-security-policy:.*'unsafe-eval'" <<<"$headers" && bad "CSP allows 'unsafe-eval'"
fi

echo
(( fail )) && die "security check failed" || info "security check passed"