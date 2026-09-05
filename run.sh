#!/usr/bin/env bash
# Lance TGVmax Radar en local et l'ouvre dans le navigateur.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8934}"
cd "$DIR"
echo "TGVmax Radar disponible sur http://localhost:$PORT"
python3 -m http.server "$PORT" &
SERVER_PID=$!
sleep 1
open "http://localhost:$PORT" 2>/dev/null || true
wait $SERVER_PID
