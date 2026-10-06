#!/usr/bin/env bash
# Run tests. Usage: scripts/test.sh [--server|--web]
source "$(dirname "$0")/_common.sh"

run_server() { require_dir "$TESTS_DIR"; info "Backend tests"; dotnet test --solution "$ROOT/Cipheroom.sln"; }
run_web()    { require_dir "$WEB_DIR";   info "Frontend tests"; npm test --prefix "$WEB_DIR" -- --watch=false; }

case "${1:-all}" in
  --server) run_server ;;
  --web)    run_web ;;
  all)      run_server; run_web ;;
  *)        die "usage: $0 [--server|--web]" ;;
esac
