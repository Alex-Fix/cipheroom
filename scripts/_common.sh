#!/usr/bin/env bash
# Shared helpers for scripts/*. Source, don't execute.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/src/Cipheroom.Api"
TESTS_DIR="$ROOT/tests"
WEB_DIR="$ROOT/web"
DEPLOY_DIR="$ROOT/deploy"
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.yml")
[[ -f "$DEPLOY_DIR/.env" ]] && COMPOSE+=(--env-file "$DEPLOY_DIR/.env")

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

require_dir() { [[ -d "$1" ]] || die "$1 not found — scaffold it first (see .claude/skills)"; }
require_env() { [[ -f "$DEPLOY_DIR/.env" ]] || die "deploy/.env missing — copy deploy/.env.example and run scripts/secrets.sh"; }

# Hetzner servers by name (scripts/provision.sh, scripts/deploy.sh --server <name>; docs/deployment-hetzner.md). The
# first server is `default` and keeps the original file names; every other one gets its own Terraform workspace, env
# overlay, inventory, pinned host keys and SSH key (Hetzner refuses the same key twice in a project).
server_files() {
  SERVER="$1"
  [[ "$SERVER" =~ ^[a-z][a-z0-9-]{0,19}$ ]] || die "server name: lowercase letters, digits and dashes, up to 20 (got '$SERVER')"
  local suffix=""
  [[ "$SERVER" == default ]] || suffix=".$SERVER"
  OVERLAY="$DEPLOY_DIR/.env.hetzner$suffix"
  INVENTORY="$DEPLOY_DIR/ansible/inventory$suffix.ini"
  KNOWN_HOSTS="$DEPLOY_DIR/ansible/known_hosts$suffix"
  TFVARS="$DEPLOY_DIR/terraform/hetzner/terraform$suffix.tfvars"
  if [[ "$SERVER" == default ]]; then
    SSH_KEY="${CIPHEROOM_SSH_KEY:-$HOME/.ssh/id_cipheroom}"
    SERVER_ARG=""
  else
    SSH_KEY="$HOME/.ssh/id_cipheroom-$SERVER"
    SERVER_ARG=" --server $SERVER"
  fi
}

# A setting for this server: its overlay first, then deploy/.env. Never printed by the callers.
server_value() {
  local v=""
  [[ -f "$OVERLAY" ]] && v="$(grep -E "^$1=" "$OVERLAY" | tail -1 | cut -d= -f2- || true)"
  [[ -n "$v" || ! -f "$DEPLOY_DIR/.env" ]] || v="$(grep -E "^$1=" "$DEPLOY_DIR/.env" | tail -1 | cut -d= -f2- || true)"
  printf '%s' "$v"
}
