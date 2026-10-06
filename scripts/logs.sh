#!/usr/bin/env bash
# Follow compose logs. Usage: scripts/logs.sh [service...]
source "$(dirname "$0")/_common.sh"
"${COMPOSE[@]}" logs -f --tail=200 "$@"
