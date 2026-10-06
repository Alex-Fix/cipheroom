#!/usr/bin/env bash
# Regenerate app icons (favicon, apple-touch-icon, in-app logo) in web/public/ from web/src/assets-src/*.svg.
# Outputs are committed; rerun after editing the SVG masters. Artwork is CC BY-SA 4.0 (LICENSE-ASSETS.md).
source "$(dirname "$0")/_common.sh"
[[ -d "$WEB_DIR/node_modules/@resvg/resvg-js" ]] || { info "Installing web deps"; npm ci --prefix "$WEB_DIR"; }
node "$WEB_DIR/scripts/icons.mjs"
