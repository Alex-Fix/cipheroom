#!/usr/bin/env bash
# Build and start the compose stack. --tunnel also starts cloudflared.
source "$(dirname "$0")/_common.sh"
require_env

[[ "${1:-}" == "--tunnel" ]] && COMPOSE+=(--profile tunnel)

"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps
