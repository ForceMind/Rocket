#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_PORT="${BASE_PORT:-${PORT:-3000}}"
MAX_PORT="${MAX_PORT:-$((BASE_PORT + 50))}"
NODE_BIN="${NODE_BIN:-}"
HTTPS_KEY_PATH="${HTTPS_KEY_PATH:-${SSL_KEY_PATH:-${TLS_KEY_PATH:-}}}"
HTTPS_CERT_PATH="${HTTPS_CERT_PATH:-${SSL_CERT_PATH:-${TLS_CERT_PATH:-}}}"
HTTPS_CA_PATH="${HTTPS_CA_PATH:-${SSL_CA_PATH:-${TLS_CA_PATH:-}}}"
PUBLIC_WS_URL="${PUBLIC_WS_URL:-${WS_URL:-}}"
PUBLIC_WS_HOST="${PUBLIC_WS_HOST:-}"
PUBLIC_WS_SCHEME="${PUBLIC_WS_SCHEME:-wss}"
PUBLIC_WS_PATH="${PUBLIC_WS_PATH:-/ws}"

build_public_ws_url() {
  local host="$1"
  local scheme="${2:-wss}"
  local route="${3:-/ws}"
  if [[ -z "$host" ]]; then
    return 0
  fi
  if [[ "$host" =~ ^wss?:// ]]; then
    echo "$host"
    return 0
  fi
  if [[ "$route" != /* ]]; then
    route="/${route}"
  fi
  if [[ "$host" == */* ]]; then
    echo "${scheme}://${host}"
  else
    echo "${scheme}://${host}${route}"
  fi
}

if [[ -z "$PUBLIC_WS_URL" && -n "$PUBLIC_WS_HOST" ]]; then
  PUBLIC_WS_URL="$(build_public_ws_url "$PUBLIC_WS_HOST" "$PUBLIC_WS_SCHEME" "$PUBLIC_WS_PATH")"
fi

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
export HTTPS_KEY_PATH
export HTTPS_CERT_PATH
export HTTPS_CA_PATH
export PUBLIC_WS_URL
export PUBLIC_WS_HOST
export PUBLIC_WS_SCHEME
export PUBLIC_WS_PATH

PROTOCOL="http"
WS_PROTOCOL="ws"
if [[ -n "$HTTPS_KEY_PATH" || -n "$HTTPS_CERT_PATH" ]]; then
  PROTOCOL="https"
  WS_PROTOCOL="wss"
fi

mkdir -p "$APP_DIR/data"
cat > "$APP_DIR/data/runtime.env" <<EOF
PORT=${PORT}
BASE_PORT=${BASE_PORT}
MAX_PORT=${MAX_PORT}
PROTOCOL=${PROTOCOL}
WS_PROTOCOL=${WS_PROTOCOL}
URL=${PROTOCOL}://localhost:${PORT}/
ADMIN_URL=${PROTOCOL}://localhost:${PORT}/admin
PUBLIC_WS_URL=${PUBLIC_WS_URL}
PUBLIC_WS_HOST=${PUBLIC_WS_HOST}
PUBLIC_WS_SCHEME=${PUBLIC_WS_SCHEME}
PUBLIC_WS_PATH=${PUBLIC_WS_PATH}
EOF

echo "Rocket Crash Platform starting on ${PROTOCOL}://0.0.0.0:${PORT}"
exec "$NODE_BIN" "$APP_DIR/server.js"
