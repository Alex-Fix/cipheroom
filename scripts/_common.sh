#!/usr/bin/env bash
# Shared helpers for scripts/*. Source, don't execute.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/src/server/Cipheroom.Api"
TESTS_DIR="$ROOT/src/server/Cipheroom.Api.Tests"
WEB_DIR="$ROOT/web"
DEPLOY_DIR="$ROOT/deploy"
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.yml")
[[ -f "$DEPLOY_DIR/.env" ]] && COMPOSE+=(--env-file "$DEPLOY_DIR/.env")

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

require_dir() { [[ -d "$1" ]] || die "$1 not found — scaffold it first (see .claude/skills)"; }
require_env() { [[ -f "$DEPLOY_DIR/.env" ]] || die "deploy/.env missing — copy deploy/.env.example and run scripts/secrets.sh"; }
