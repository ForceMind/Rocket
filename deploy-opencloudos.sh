#!/usr/bin/env bash
set -Eeuo pipefail

ENV_PUBLIC_HOST_SET="${PUBLIC_HOST+x}"
ENV_PUBLIC_HOST_VALUE="${PUBLIC_HOST-}"
ENV_PUBLIC_WS_HOST_SET="${PUBLIC_WS_HOST+x}"
ENV_PUBLIC_WS_HOST_VALUE="${PUBLIC_WS_HOST-}"
ENV_PUBLIC_WS_SCHEME_SET="${PUBLIC_WS_SCHEME+x}"
ENV_PUBLIC_WS_SCHEME_VALUE="${PUBLIC_WS_SCHEME-}"
ENV_PUBLIC_WS_PATH_SET="${PUBLIC_WS_PATH+x}"
ENV_PUBLIC_WS_PATH_VALUE="${PUBLIC_WS_PATH-}"
ENV_ADMIN_PATH_SET="${ADMIN_PATH+x}"
ENV_ADMIN_PATH_VALUE="${ADMIN_PATH-}"
ENV_PUBLIC_WS_URL_VALUE="${PUBLIC_WS_URL-${WS_URL-}}"
ENV_PUBLIC_WS_URL_SET=""
if [[ -n "${PUBLIC_WS_URL+x}" || -n "${WS_URL+x}" ]]; then
  ENV_PUBLIC_WS_URL_SET="1"
fi

SERVICE_NAME="${SERVICE_NAME:-rocket-crash}"
APP_DIR="${APP_DIR:-/opt/rocket-crash-platform}"
RUN_USER="${RUN_USER:-rocket}"
BASE_PORT="${BASE_PORT:-3000}"
MAX_PORT="${MAX_PORT:-$((BASE_PORT + 50))}"
OPEN_FIREWALL="${OPEN_FIREWALL:-1}"
UPDATE_FROM_GIT="${UPDATE_FROM_GIT:-1}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
HTTPS_KEY_PATH="${HTTPS_KEY_PATH:-${SSL_KEY_PATH:-${TLS_KEY_PATH:-}}}"
HTTPS_CERT_PATH="${HTTPS_CERT_PATH:-${SSL_CERT_PATH:-${TLS_CERT_PATH:-}}}"
HTTPS_CA_PATH="${HTTPS_CA_PATH:-${SSL_CA_PATH:-${TLS_CA_PATH:-}}}"
PUBLIC_WS_URL="${PUBLIC_WS_URL:-${WS_URL:-}}"
PUBLIC_WS_HOST="${PUBLIC_WS_HOST:-}"
PUBLIC_WS_SCHEME="${PUBLIC_WS_SCHEME:-wss}"
PUBLIC_WS_PATH="${PUBLIC_WS_PATH:-/ws}"
ADMIN_PATH="${ADMIN_PATH:-/manage}"
DEPLOY_CONFIG_FILE="${DEPLOY_CONFIG_FILE:-${APP_DIR}/data/deploy-config.env}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

trim_value() {
  local value="$*"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

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

normalize_public_path() {
  local value="$1"
  if [[ -z "$value" || "$value" == "/" ]]; then
    echo "/manage"
    return 0
  fi
  value="${value%%\?*}"
  value="${value%%#*}"
  if [[ "$value" != /* ]]; then
    value="/${value}"
  fi
  while [[ "$value" == */ && "$value" != "/" ]]; do
    value="${value%/}"
  done
  echo "$value"
}

can_prompt_deploy_config() {
  [[ "${ASK_DEPLOY_CONFIG:-1}" == "1" && -t 0 && -t 1 && ("${LOADED_DEPLOY_CONFIG:-0}" != "1" || "${FORCE_DEPLOY_CONFIG_PROMPT:-0}" == "1") ]]
}

load_previous_deploy_config() {
  LOADED_DEPLOY_CONFIG=0
  if [[ ! -f "$DEPLOY_CONFIG_FILE" ]]; then
    return 0
  fi

  # shellcheck disable=SC1090
  source "$DEPLOY_CONFIG_FILE"
  LOADED_DEPLOY_CONFIG=1

  if [[ -n "$ENV_PUBLIC_HOST_SET" ]]; then
    PUBLIC_HOST="$ENV_PUBLIC_HOST_VALUE"
  fi
  if [[ -n "$ENV_PUBLIC_WS_HOST_SET" ]]; then
    PUBLIC_WS_HOST="$ENV_PUBLIC_WS_HOST_VALUE"
    if [[ -z "$ENV_PUBLIC_WS_URL_SET" ]]; then
      PUBLIC_WS_URL=""
    fi
  fi
  if [[ -n "$ENV_PUBLIC_WS_SCHEME_SET" ]]; then
    PUBLIC_WS_SCHEME="$ENV_PUBLIC_WS_SCHEME_VALUE"
  fi
  if [[ -n "$ENV_PUBLIC_WS_PATH_SET" ]]; then
    PUBLIC_WS_PATH="$ENV_PUBLIC_WS_PATH_VALUE"
  fi
  if [[ -n "$ENV_ADMIN_PATH_SET" ]]; then
    ADMIN_PATH="$ENV_ADMIN_PATH_VALUE"
  fi
  if [[ -n "$ENV_PUBLIC_WS_URL_SET" ]]; then
    PUBLIC_WS_URL="$ENV_PUBLIC_WS_URL_VALUE"
  fi
}

write_shell_value() {
  local name="$1"
  local value="$2"
  printf "%s=%q\n" "$name" "$value"
}

save_previous_deploy_config() {
  mkdir -p "$(dirname "$DEPLOY_CONFIG_FILE")"
  {
    echo "# Rocket deploy config. Edit this file or run FORCE_DEPLOY_CONFIG_PROMPT=1 sudo bash deploy-opencloudos.sh to change it."
    write_shell_value "PUBLIC_HOST" "${PUBLIC_HOST:-}"
    write_shell_value "PUBLIC_WS_URL" "${PUBLIC_WS_URL:-}"
    write_shell_value "PUBLIC_WS_HOST" "${PUBLIC_WS_HOST:-}"
    write_shell_value "PUBLIC_WS_SCHEME" "${PUBLIC_WS_SCHEME:-wss}"
    write_shell_value "PUBLIC_WS_PATH" "${PUBLIC_WS_PATH:-/ws}"
    write_shell_value "ADMIN_PATH" "${ADMIN_PATH:-/manage}"
  } > "$DEPLOY_CONFIG_FILE"
  chmod 600 "$DEPLOY_CONFIG_FILE"
}

prompt_deploy_config() {
  if ! can_prompt_deploy_config; then
    return 0
  fi

  local input=""
  local force_prompt="${FORCE_DEPLOY_CONFIG_PROMPT:-0}"
  echo
  echo "Deployment configuration"
  echo "Press Enter to keep defaults or values already provided by environment variables."
  echo "These public hosts are written only to the browser runtime config, not to the Node listener."

  if [[ -z "$PUBLIC_HOST" || "$force_prompt" == "1" ]]; then
    read -r -p "Frontend public host, for example rocket.xincreates.com (current: ${PUBLIC_HOST:-auto-detect public IP}): " input
    input="$(trim_value "$input")"
    if [[ -n "$input" ]]; then
      PUBLIC_HOST="$input"
    fi
  else
    echo "Frontend public host: ${PUBLIC_HOST}"
  fi

  if [[ (-z "$PUBLIC_WS_URL" && -z "$PUBLIC_WS_HOST") || "$force_prompt" == "1" ]]; then
    local current_ws="${PUBLIC_WS_URL:-${PUBLIC_WS_HOST:-same as frontend host}}"
    read -r -p "Frontend WebSocket host or URL, for example rocket-api.xincreates.com or wss://rocket-api.xincreates.com/ws (current: ${current_ws}): " input
    input="$(trim_value "$input")"
    if [[ -n "$input" ]]; then
      if [[ "$input" =~ ^wss?:// ]]; then
        PUBLIC_WS_URL="$input"
        PUBLIC_WS_HOST=""
      else
        PUBLIC_WS_HOST="$input"
        PUBLIC_WS_URL=""
      fi
    fi
  elif [[ -n "$PUBLIC_WS_URL" ]]; then
    echo "WebSocket public URL: ${PUBLIC_WS_URL}"
  else
    echo "WebSocket public host: ${PUBLIC_WS_HOST}"
  fi

  if [[ -z "$ADMIN_PATH" || "$force_prompt" == "1" ]]; then
    read -r -p "Admin page path, for example /manage (current: ${ADMIN_PATH:-/manage}): " input
    input="$(trim_value "$input")"
    if [[ -n "$input" ]]; then
      ADMIN_PATH="$input"
    fi
  else
    echo "Admin page path: ${ADMIN_PATH}"
  fi
}

json_string() {
  "$NODE_BIN" -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$1"
}

write_frontend_runtime_config() {
  local ws_url_json
  mkdir -p "$APP_DIR/public"
  ws_url_json="$(json_string "${PUBLIC_WS_URL:-}")"
  cat > "$APP_DIR/public/runtime-config.js" <<EOF
window.ROCKET_CONFIG = window.ROCKET_CONFIG || {};
window.ROCKET_CONFIG.publicWsUrl = ${ws_url_json};
EOF
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy-opencloudos.sh" >&2
  exit 1
fi

load_previous_deploy_config
if [[ "${LOADED_DEPLOY_CONFIG:-0}" == "1" && "${FORCE_DEPLOY_CONFIG_PROMPT:-0}" != "1" ]]; then
  echo "Reusing deploy config from ${DEPLOY_CONFIG_FILE}."
fi
prompt_deploy_config

if [[ -z "$PUBLIC_WS_URL" && -n "$PUBLIC_WS_HOST" ]]; then
  PUBLIC_WS_URL="$(build_public_ws_url "$PUBLIC_WS_HOST" "$PUBLIC_WS_SCHEME" "$PUBLIC_WS_PATH")"
fi
ADMIN_PATH="$(normalize_public_path "$ADMIN_PATH")"

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
    --exclude='data/deploy-config.env' \
    -C "$SOURCE_DIR" -cf - . | tar -C "$APP_DIR" -xf -
fi

mkdir -p "$APP_DIR/data"
chmod +x "$APP_DIR/start-linux.sh"
save_previous_deploy_config
write_frontend_runtime_config
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
Environment=HTTPS_KEY_PATH=${HTTPS_KEY_PATH}
Environment=HTTPS_CERT_PATH=${HTTPS_CERT_PATH}
Environment=HTTPS_CA_PATH=${HTTPS_CA_PATH}
Environment=ADMIN_PATH=${ADMIN_PATH}
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
  PROTOCOL="http"
  WS_PROTOCOL="ws"
fi
PROTOCOL="${PROTOCOL:-http}"
WS_PROTOCOL="${WS_PROTOCOL:-ws}"

detect_public_ip() {
  local ip=""
  local endpoints=(
    "https://api.ipify.org"
    "https://ifconfig.me/ip"
    "https://icanhazip.com"
  )

  if command -v curl >/dev/null 2>&1; then
    for endpoint in "${endpoints[@]}"; do
      ip="$(curl -fsS --max-time 3 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$ip"
        return 0
      fi
    done
  fi

  if [[ -n "${NODE_BIN:-}" ]]; then
    ip="$("$NODE_BIN" - "${endpoints[@]}" <<'NODE' 2>/dev/null || true
const https = require("node:https");
const endpoints = process.argv.slice(2);
const ipPattern = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body.trim()));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(""));
  });
}

(async () => {
  for (const endpoint of endpoints) {
    const value = await fetchText(endpoint);
    if (ipPattern.test(value)) {
      console.log(value);
      return;
    }
  }
})();
NODE
)"
    ip="$(echo "$ip" | tr -d '[:space:]')"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "$ip"
      return 0
    fi
  fi

  return 1
}

PUBLIC_IP="$PUBLIC_HOST"
if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(detect_public_ip || true)"
fi
PRIVATE_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "$PRIVATE_IP" ]]; then
  PRIVATE_IP="127.0.0.1"
fi

DISPLAY_HOST="$PUBLIC_IP"
if [[ -z "$DISPLAY_HOST" ]]; then
  DISPLAY_HOST="$PRIVATE_IP"
fi

if [[ -n "$PUBLIC_HOST" ]]; then
  if [[ "$PUBLIC_HOST" =~ ^https?:// ]]; then
    PLAYER_URL="${PUBLIC_HOST%/}/"
  elif [[ "$PUBLIC_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    PLAYER_URL="${PROTOCOL}://${PUBLIC_HOST}:${PORT}/"
  else
    PLAYER_URL="https://${PUBLIC_HOST}/"
  fi
else
  PLAYER_URL="${PROTOCOL}://${DISPLAY_HOST}:${PORT}/"
fi
ADMIN_URL="${PLAYER_URL%/}${ADMIN_PATH}"

echo
echo "Deployment complete."
echo "Service: ${SERVICE_NAME}"
echo "App dir: ${APP_DIR}"
echo "Port range: ${BASE_PORT}-${MAX_PORT}"
echo "Selected port: ${PORT}"
echo "Runtime file: ${APP_DIR}/data/runtime.env"
if [[ -n "$PUBLIC_IP" ]]; then
  echo "Public host: ${PUBLIC_IP}"
fi
echo "Private IP: ${PRIVATE_IP}"
echo "Player URL: ${PLAYER_URL}"
echo "Admin URL : ${ADMIN_URL}"
if [[ -n "${PUBLIC_WS_URL:-}" ]]; then
  echo "WebSocket : ${PUBLIC_WS_URL}"
else
  echo "WebSocket : ${WS_PROTOCOL}://${DISPLAY_HOST}:${PORT}/ws"
fi
echo "Admin auth: disabled"
echo
echo "Useful commands:"
echo "  systemctl status ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
