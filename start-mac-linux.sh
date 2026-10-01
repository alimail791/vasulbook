#!/bin/sh
# Starts VasulBook on your computer. Keep this window open; press Ctrl+C to stop.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again."
  exit 1
fi
[ -d node_modules ] || { echo "Installing VasulBook. This happens only the first time..."; npm install --no-audit --no-fund; }
( sleep 4; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1 ) &
npm run local
