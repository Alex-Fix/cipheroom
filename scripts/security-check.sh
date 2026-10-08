#!/usr/bin/env bash
# Security checks: secrets in git, .env hygiene, vulnerable dependencies, live security headers.
# Usage: scripts/security-check.sh [https://cipheroom.alexfix.dev]
source "$(dirname "$0")/_common.sh"
cd "$ROOT"

fail=0
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

info "Secrets in tracked files"
# Cloudflare tunnel tokens (base64 JSON starting {"a":), private keys, filled-in secret assignments (8+ characters, so
# scripts that merely mention a variable — quoted patterns, placeholders — don't match).
patterns='eyJhIjoi[A-Za-z0-9+/=_-]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(TUNNEL_TOKEN|CF_TURN_API_TOKEN|CF_TURN_KEY_ID|CF_SFU_APP_SECRET|CF_ANALYTICS_API_TOKEN|GRAFANA_ADMIN_PASSWORD|TELEMETRY_SECRET)=[A-Za-z0-9_+/-][^[:space:]$\x27\x22]{7,}'
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

  # Grafana holds call metadata: from outside, nothing may be readable without logging in (docs/observability.md).
  info "Grafana ($1/grafana/)"
  g="${1%/}/grafana"
  read -r code location < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$g/api/search")
  if [[ "$code" == 502 || "$code" == 404 ]]; then
    good "not running ($code)"
  else
    if [[ "$code" =~ ^30[127]$ && "$location" == *.cloudflareaccess.com/* ]]; then good "behind Cloudflare Access"
    elif [[ "$code" == 401 ]]; then good "API requires login"
    else bad "API answers $code without login"; fi
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$g/metrics")" != 200 ]] && good "/metrics not exposed" || bad "/metrics is public (GF_METRICS_ENABLED)"
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$g/api/health")" != 200 ]] && good "health/version not exposed" || bad "/grafana/api/health is public"
    # Only reachable without Access: there, the login page itself must be rate-limited (nginx).
    if [[ "$code" == 401 ]]; then
      limited=0
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13; do
        [[ "$(curl -s -o /dev/null -w '%{http_code}' "$g/login")" == 429 ]] && { limited=1; break; }
      done
      (( limited )) && good "login is rate-limited" || bad "login page is not rate-limited"
    fi
  fi
fi

echo
(( fail )) && die "security check failed" || info "security check passed"