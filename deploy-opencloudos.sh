#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-rocket-crash}"
APP_DIR="${APP_DIR:-/opt/rocket-crash-platform}"
RUN_USER="${RUN_USER:-rocket}"
BASE_PORT="${BASE_PORT:-3000}"
MAX_PORT="${MAX_PORT:-$((BASE_PORT + 50))}"
OPEN_FIREWALL="${OPEN_FIREWALL:-1}"
UPDATE_FROM_GIT="${UPDATE_FROM_GIT:-1}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy-opencloudos.sh" >&2
  exit 1
fi

install_node_if_missing() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi

  echo "Node.js was not found. Trying to install nodejs with dnf/yum..."
  if command -v dnf >/dev/null 2>&1; then
    dnf -y install nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum -y install nodejs
  else
    echo "Neither dnf nor yum was found. Install Node.js 18+ manually." >&2
    exit 1
  fi
}

install_git_if_needed() {
  if [[ "$UPDATE_FROM_GIT" != "1" || ! -d "$SOURCE_DIR/.git" ]]; then
    return 0
  fi
  if command -v git >/dev/null 2>&1; then
    return 0
  fi

  echo "Git was not found. Trying to install git with dnf/yum..."
  if command -v dnf >/dev/null 2>&1; then
    dnf -y install git
  elif command -v yum >/dev/null 2>&1; then
    yum -y install git
  else
    echo "Neither dnf nor yum was found. Install git manually or run UPDATE_FROM_GIT=0." >&2
    exit 1
  fi
}

update_source_from_git() {
  if [[ "$UPDATE_FROM_GIT" != "1" ]]; then
    echo "Git update skipped because UPDATE_FROM_GIT=0."
    return 0
  fi
  if [[ ! -d "$SOURCE_DIR/.git" ]]; then
    echo "Git update skipped because ${SOURCE_DIR} is not a Git repository."
    return 0
  fi

  install_git_if_needed

  local branch="$GIT_BRANCH"
  if [[ -z "$branch" ]]; then
    branch="$(git -C "$SOURCE_DIR" symbolic-ref --quiet --short HEAD || true)"
  fi
  if [[ -z "$branch" ]]; then
    echo "Git update skipped because current checkout is not on a branch. Set GIT_BRANCH to force one."
    return 0
  fi

  echo "Pulling latest code from ${GIT_REMOTE}/${branch}..."
  git config --global --add safe.directory "$SOURCE_DIR" >/dev/null 2>&1 || true
  git -C "$SOURCE_DIR" fetch --prune "$GIT_REMOTE"
  git -C "$SOURCE_DIR" pull --ff-only "$GIT_REMOTE" "$branch"
}

update_source_from_git
install_node_if_missing

NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js 18+ is required. Current: $("$NODE_BIN" -v)" >&2
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /sbin/nologin "$RUN_USER"
fi

mkdir -p "$APP_DIR"
SOURCE_REAL="$(readlink -f "$SOURCE_DIR")"
APP_REAL="$(readlink -f "$APP_DIR")"

if [[ "$SOURCE_REAL" != "$APP_REAL" ]]; then
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='data/*.json' \
    --exclude='data/runtime.env' \
    -C "$SOURCE_DIR" -cf - . | tar -C "$APP_DIR" -xf -
fi

mkdir -p "$APP_DIR/data"
chmod +x "$APP_DIR/start-linux.sh"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Rocket Crash Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=NODE_BIN=${NODE_BIN}
Environment=BASE_PORT=${BASE_PORT}
Environment=MAX_PORT=${MAX_PORT}
ExecStart=${APP_DIR}/start-linux.sh
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

if [[ "$OPEN_FIREWALL" == "1" ]] && command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${BASE_PORT}-${MAX_PORT}/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
fi

sleep 1
RUNTIME_FILE="$APP_DIR/data/runtime.env"
if [[ -f "$RUNTIME_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$RUNTIME_FILE"
else
  PORT="$BASE_PORT"
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP="127.0.0.1"
fi

echo
echo "Deployment complete."
echo "Service: ${SERVICE_NAME}"
echo "App dir: ${APP_DIR}"
echo "Port range: ${BASE_PORT}-${MAX_PORT}"
echo "Selected port: ${PORT}"
echo "Player URL: http://${SERVER_IP}:${PORT}/"
echo "Admin URL : http://${SERVER_IP}:${PORT}/admin"
echo "Admin auth: disabled"
echo
echo "Useful commands:"
echo "  systemctl status ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
