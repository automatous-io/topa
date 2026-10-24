#!/bin/bash
cd "$(dirname "$0")"
PORT=8766
( sleep 1; open "http://localhost:$PORT/index.html" ) &
python3 -m http.server "$PORT"
