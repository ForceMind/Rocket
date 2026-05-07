#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_PORT="${BASE_PORT:-${PORT:-3000}}"
MAX_PORT="${MAX_PORT:-$((BASE_PORT + 50))}"
NODE_BIN="${NODE_BIN:-}"

if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x "/usr/bin/node" ]]; then
    NODE_BIN="/usr/bin/node"
  elif [[ -x "/usr/local/bin/node" ]]; then
    NODE_BIN="/usr/local/bin/node"
  else
    echo "Node.js was not found. Install Node.js 18+ first." >&2
    exit 1
  fi
fi

port_in_use() {
  local port="$1"
  "$NODE_BIN" - "$port" <<'NODE'
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer();

server.once("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    process.exit(0);
  }
  process.exit(2);
});

server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
  server.close(() => process.exit(1));
});
NODE
}

choose_port() {
  local port
  for ((port = BASE_PORT; port <= MAX_PORT; port++)); do
    if ! port_in_use "$port"; then
      echo "$port"
      return 0
    fi
  done
  echo "No free port found in range ${BASE_PORT}-${MAX_PORT}." >&2
  return 1
}

PORT="$(choose_port)"
export PORT

mkdir -p "$APP_DIR/data"
cat > "$APP_DIR/data/runtime.env" <<EOF
PORT=${PORT}
BASE_PORT=${BASE_PORT}
MAX_PORT=${MAX_PORT}
URL=http://localhost:${PORT}/
ADMIN_URL=http://localhost:${PORT}/admin
EOF

echo "Rocket Crash Platform starting on port ${PORT}"
exec "$NODE_BIN" "$APP_DIR/server.js"
