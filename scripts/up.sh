#!/usr/bin/env bash
# Build and start the compose stack. --tunnel also starts cloudflared.
source "$(dirname "$0")/_common.sh"
require_env

[[ "${1:-}" == "--tunnel" ]] && COMPOSE+=(--profile tunnel)

# --remove-orphans: containers of services that were removed from the compose file (e.g. the old livekit) go too.
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
