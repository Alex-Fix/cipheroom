#!/usr/bin/env bash
# Run LiveKit (docker), API (dotnet watch) and Angular dev server together. Ctrl+C stops all.
# LIVEKIT_NODE_IP=<lan-ip> scripts/dev.sh  → lets other LAN devices connect (they also need HTTPS: scripts/certs.sh).
source "$(dirname "$0")/_common.sh"
require_dir "$API_DIR"
require_dir "$WEB_DIR"

[[ -d "$WEB_DIR/node_modules" ]] || (info "Installing web deps"; npm ci --prefix "$WEB_DIR")

DEV_COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.dev.yml")
docker info >/dev/null 2>&1 || die "Docker is not running — start Docker Desktop first"
info "LiveKit → ws://localhost:7880"
"${DEV_COMPOSE[@]}" up -d

trap '"${DEV_COMPOSE[@]}" down >/dev/null 2>&1; kill 0' EXIT INT TERM

info "API  → http://localhost:5080"
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://localhost:5080 \
  dotnet watch --project "$API_DIR" --no-hot-reload 2>&1 | sed -u 's/^/[api] /' &

info "Web  → http://localhost:4200"
npm start --prefix "$WEB_DIR" 2>&1 | sed -u 's/^/[web] /' &

wait
