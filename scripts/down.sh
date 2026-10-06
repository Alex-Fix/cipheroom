#!/usr/bin/env bash
# Stop the compose stack (all profiles).
source "$(dirname "$0")/_common.sh"
"${COMPOSE[@]}" --profile tunnel down "$@"
