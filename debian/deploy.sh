#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Debian 专用部署脚本 (Nginx + Go 版)
# 说明：
#   本脚本将部署 Go 后端服务，并使用 Nginx 作为反向代理和静态文件服务器。
#   如果没有安装 Nginx，脚本会自动安装。
#
# 使用方式：
#   cd /path/to/debian
#   chmod +x deploy.sh
#   sudo ./deploy.sh

APP_NAME="flatnas"
APP_USER="flatnas"
SERVICE_NAME="flatnas"
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SRC="${BASE_DIR}/flatnas"
BIN_SRC_ALT="${BASE_DIR}/flatnas-server"
DIST_SRC="${BASE_DIR}/dist"
DIST_SRC_ALT="${BASE_DIR}/server/public"

# 安装目标目录
INSTALL_DIR="/opt/${APP_NAME}"
BIN_DIR="${INSTALL_DIR}/bin"
STATIC_DIR="${INSTALL_DIR}/static"
SERVER_DIR="${INSTALL_DIR}/server"
PUBLIC_DIR="${SERVER_DIR}/public"
CACHE_DIR="${SERVER_DIR}/cache"
DATA_DIR="${SERVER_DIR}/data"
MUSIC_DIR="${SERVER_DIR}/music"
PC_DIR="${SERVER_DIR}/PC"
APP_DIR="${SERVER_DIR}/APP"
DOC_DIR="${SERVER_DIR}/doc"
LOG_DIR="/var/log/${APP_NAME}"
CONFIG_DIR="/etc/${APP_NAME}"
CONFIG_FILE="${CONFIG_DIR}/${APP_NAME}.env"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"

# 系统配置
SYSTEMD_SERVICE="/etc/systemd/system/${APP_NAME}.service"

COLOR_GREEN="\033[0;32m"
COLOR_RED="\033[0;31m"
COLOR_YELLOW="\033[0;33m"
COLOR_RESET="\033[0m"

log_info() {
  printf "%s ${COLOR_GREEN}[INFO]${COLOR_RESET} %s\n" "$(date +"%F %T")" "$1"
}

log_warn() {
  printf "%s ${COLOR_YELLOW}[WARN]${COLOR_RESET} %s\n" "$(date +"%F %T")" "$1"
}

log_error() {
  printf "%s ${COLOR_RED}[ERROR]${COLOR_RESET} %s\n" "$(date +"%F %T")" "$1"
}

fail_with_tip() {
  log_error "$1"
  [ -n "$2" ] && log_warn "$2"
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail_with_tip "请使用 root 权限运行脚本" "Debian 下可使用: sudo ./deploy.sh"
  fi
}

require_debian() {
  if [ ! -f /etc/debian_version ]; then
    fail_with_tip "仅支持 Debian 系统" "请在 Debian 系统内执行该脚本"
  fi
}

prompt_port() {
  local label="$1"
  local default="$2"
  local current="$3"
  local final_default="${current:-$default}"
  
  read -r -p "${label} [${final_default}]: " input
  echo "${input:-$final_default}"
}

validate_port() {
  local port="$1"
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || [ "${port}" -lt 1 ] || [ "${port}" -gt 65535 ]; then
    return 1
  fi
  return 0
}

is_port_in_use() {
  local port="$1"
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

require_free_port() {
  local port="$1"
  local name="$2"
  # 检查端口是否被占用，如果是被我们要重启的服务占用则忽略
  if is_port_in_use "${port}"; then
    # 简单的检查，如果服务正在运行，端口占用可能是正常的
    if systemctl is-active --quiet "${SERVICE_NAME}" || systemctl is-active --quiet nginx; then
        log_warn "${name} 端口 ${port} 正在使用中，假设是现有服务占用"
    else
        fail_with_tip "${name} 端口 ${port} 已被占用且服务未运行" "可使用: lsof -iTCP:${port} -sTCP:LISTEN 查看占用进程"
    fi
  fi
}

ensure_packages() {
  local pkgs=("$@")
  local missing=()
  for pkg in "${pkgs[@]}"; do
    if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
      missing+=("${pkg}")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log_info "安装依赖: ${missing[*]}"
    apt-get update -y >/dev/null
    apt-get install -y "${missing[@]}" >/dev/null
  fi
}

check_nginx() {
  if ! command -v nginx >/dev/null 2>&1; then
    log_info "Nginx 未安装，准备安装..."
    ensure_packages nginx
  else
    log_info "Nginx 已安装，继续..."
  fi
}

create_user() {
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    log_info "创建系统用户: ${APP_USER}"
    useradd -r -s /bin/false "${APP_USER}"
  fi
}

load_existing_config() {
  EXISTING_FRONTEND_PORT=""
  EXISTING_BACKEND_PORT=""
  if [ -f "${CONFIG_FILE}" ]; then
    EXISTING_BACKEND_PORT=$(grep '^PORT=' "${CONFIG_FILE}" | cut -d= -f2)
    # 尝试从 nginx 配置读取前端端口
    if [ -f "${NGINX_CONF}" ]; then
        EXISTING_FRONTEND_PORT=$(grep 'listen' "${NGINX_CONF}" | head -n1 | awk '{print $2}' | tr -d ';')
    fi
  fi
}

write_systemd_service() {
  cat > "${SYSTEMD_SERVICE}" <<EOF
[Unit]
Description=FlatNas Go Service
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${CONFIG_FILE}
Environment=GIN_MODE=release
Environment=PUBLIC_DIR=${PUBLIC_DIR}
ExecStart=${BIN_DIR}/${APP_NAME}
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

# 日志配置 (使用 journald)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

write_nginx_config() {
  cat > "${NGINX_CONF}" <<EOF
server {
    listen ${FRONTEND_PORT};
    server_name _;
    client_max_body_size 20m;

    root ${PUBLIC_DIR};
    index index.html;

    # 开启 gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    # 静态文件缓存
    location /assets/ {
        expires 1y;
        access_log off;
        add_header Cache-Control "public";
    }

    # 前端路由支持 (SPA)
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT}/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # WebSocket 支持 (如果需要)
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT}/socket.io/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

  # 启用站点
  ln -sf "${NGINX_CONF}" "${NGINX_LINK}"
  
  # 删除默认站点 (防止端口冲突)
  if [ -L "/etc/nginx/sites-enabled/default" ]; then
    rm "/etc/nginx/sites-enabled/default"
  fi
  
  # 测试配置
  nginx -t >/dev/null || fail_with_tip "Nginx 配置生成失败"
  
  # 注意：此处不执行 reload，留待后续统一 restart，避免 Nginx 未启动时报错
}

write_config() {
  mkdir -p "${CONFIG_DIR}"
  cat > "${CONFIG_FILE}" <<EOF
PORT=${BACKEND_PORT}
PUBLIC_DIR=${PUBLIC_DIR}
EOF
  # 配置文件权限
  chown root:root "${CONFIG_FILE}"
  chmod 644 "${CONFIG_FILE}"
}

verify_deploy() {
  systemctl is-active --quiet "${SERVICE_NAME}" || fail_with_tip "flatnas 服务未处于运行状态"
  systemctl is-active --quiet nginx || fail_with_tip "nginx 服务未处于运行状态"
  
  # 增加等待时间，确保服务有足够时间启动
  sleep 5
  
  # 使用 ss 检查端口时更加宽容，尝试多次
  for i in {1..5}; do
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${BACKEND_PORT}$"; then
        break
    fi
    sleep 1
  done

  if ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${BACKEND_PORT}$"; then
    log_warn "后端端口 ${BACKEND_PORT} 尚未监听 (可能是启动较慢，请稍后检查)"
  else
    # curl 检查增加超时设置，避免卡死
    if ! curl -fsSL --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/ping" >/dev/null 2>&1; then
        log_warn "后端 API 健康检查失败: http://127.0.0.1:${BACKEND_PORT}/api/ping"
        log_warn "后端服务日志 (最后 50 行):"
        journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
        
        log_warn "尝试直接获取 /api/ping 响应内容:"
        curl -v --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/ping" || true
    fi
  fi
  
  if ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${FRONTEND_PORT}$"; then
    log_warn "前端端口 ${FRONTEND_PORT} (Nginx) 尚未监听"
  fi

  local html
  html="$(curl -fsSL --max-time 8 "http://127.0.0.1:${FRONTEND_PORT}/" || true)"
  if [ -z "${html}" ]; then
    log_warn "前端首页拉取失败，未能完成产物校验"
  else
    if printf "%s" "${html}" | grep -Eq '/@vite/client|virtual:vue-devtools-path|/src/main\.(ts|js)'; then
      fail_with_tip "检测到开发版前端（Vite）被部署到线上，请重新构建并同步 server/public"
    fi
    if ! printf "%s" "${html}" | grep -q '/assets/'; then
      log_warn "前端首页未检测到 /assets/ 引用，请确认静态产物是否完整"
    fi
  fi
}

on_error() {
  local line="$1"
  log_error "部署失败，发生错误于行 ${line}"
  exit 1
}

trap 'on_error $LINENO' ERR

require_root
require_debian

echo "=============================="
echo "FlatNas 部署脚本 (Nginx + Go)"
echo "=============================="

load_existing_config

# 端口配置
FRONTEND_PORT="${FLATNAS_FRONTEND_PORT:-}"
if [ -z "${FRONTEND_PORT}" ]; then
  FRONTEND_PORT="$(prompt_port "前端访问端口 (Nginx)" "23000" "${EXISTING_FRONTEND_PORT}")"
fi

BACKEND_PORT="${FLATNAS_BACKEND_PORT:-}"
if [ -z "${BACKEND_PORT}" ]; then
  BACKEND_PORT="$(prompt_port "后端服务端口 (Internal)" "3000" "${EXISTING_BACKEND_PORT}")"
fi

if ! validate_port "${FRONTEND_PORT}" || ! validate_port "${BACKEND_PORT}"; then
  fail_with_tip "端口非法"
fi

if [ "${FRONTEND_PORT}" -eq "${BACKEND_PORT}" ]; then
  fail_with_tip "前端端口和后端端口不能相同"
fi

log_info "检查 Nginx..."
check_nginx

log_info "检查其他依赖..."
ensure_packages curl iproute2 lsof

log_info "创建用户和组..."
create_user

log_info "准备目录结构..."
mkdir -p "${BIN_DIR}" "${STATIC_DIR}" "${PUBLIC_DIR}" "${CACHE_DIR}" "${LOG_DIR}" "${CONFIG_DIR}"
mkdir -p "${DATA_DIR}" "${MUSIC_DIR}" "${PC_DIR}" "${APP_DIR}" "${DOC_DIR}"

# 尝试从源码或当前目录初始化数据 (仅当目标为空时)
# 优先查找 debian/server/NAME (打包资源)，其次查找 ../NAME (项目源码)
SOURCE_ROOT="$(dirname "${BASE_DIR}")"

init_data_dir() {
  local src_name="$1"
  local dest_path="$2"
  
  local src_path=""
  # 1. 检查脚本所在目录下的 server/NAME (例如 debian/server/data)
  if [ -d "${BASE_DIR}/server/${src_name}" ]; then
    src_path="${BASE_DIR}/server/${src_name}"
  # 2. 检查项目根目录下的 server/NAME (例如 ../server/data)
  elif [ -d "${SOURCE_ROOT}/server/${src_name}" ]; then
    src_path="${SOURCE_ROOT}/server/${src_name}"
  fi
  
  if [ -n "${src_path}" ]; then
    # 如果目标目录为空，则复制
    if [ -z "$(ls -A "${dest_path}" 2>/dev/null)" ]; then
       log_info "初始化 ${src_name} 从 ${src_path} ..."
       cp -r "${src_path}/." "${dest_path}/"
    else
       log_info "保留现有 ${src_name} (目标非空)"
    fi
  fi
}

init_data_dir "data" "${DATA_DIR}"
init_data_dir "music" "${MUSIC_DIR}"
init_data_dir "PC" "${PC_DIR}"
init_data_dir "APP" "${APP_DIR}"
init_data_dir "doc" "${DOC_DIR}"

log_info "检查源文件..."
if [ ! -f "${BIN_SRC}" ]; then
  if [ -f "${BIN_SRC_ALT}" ]; then
    BIN_SRC="${BIN_SRC_ALT}"
  else
    fail_with_tip "未找到 Go 二进制文件"
  fi
fi

if [ ! -d "${DIST_SRC}" ]; then
  if [ -d "${DIST_SRC_ALT}" ]; then
    DIST_SRC="${DIST_SRC_ALT}"
  else
    fail_with_tip "未找到前端静态目录"
  fi
fi

log_info "部署文件..."
systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true

# 复制二进制
install -m 755 "${BIN_SRC}" "${BIN_DIR}/${APP_NAME}"

# 复制静态文件
# 检查源目录和目标目录是否相同
if [ "$(readlink -f "${DIST_SRC}")" != "$(readlink -f "${PUBLIC_DIR}")" ]; then
    log_info "清理旧文件并复制新文件..."
    rm -rf "${PUBLIC_DIR:?}"/*
    cp -a "${DIST_SRC}/." "${PUBLIC_DIR}/"
else
    log_info "源目录(${DIST_SRC})与目标目录相同，跳过清理和复制"
fi

log_info "设置权限..."
# 确保所有父目录具有执行权限，以便 Nginx (www-data) 可以进入
chmod 755 /opt
chmod 755 "${INSTALL_DIR}"
chmod 755 "${SERVER_DIR}"
chmod 755 "${PUBLIC_DIR}"
# 确保文件可读
find "${PUBLIC_DIR}" -type f -exec chmod 644 {} \;
find "${PUBLIC_DIR}" -type d -exec chmod 755 {} \;

chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${LOG_DIR}"
chmod 755 "${CACHE_DIR}"
# 重新设置数据目录权限 (防止复制过来的文件权限不对)
chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${MUSIC_DIR}" "${PC_DIR}" "${APP_DIR}" "${DOC_DIR}"
chmod -R 755 "${DATA_DIR}" "${MUSIC_DIR}" "${PC_DIR}" "${APP_DIR}" "${DOC_DIR}"

log_info "生成配置..."
write_config
write_systemd_service
write_nginx_config

log_info "启动服务..."
systemctl enable "${SERVICE_NAME}" >/dev/null
systemctl restart "${SERVICE_NAME}"
systemctl restart nginx

log_info "验证部署..."
verify_deploy

log_info "部署完成!"
log_info "访问地址: http://<服务器IP>:${FRONTEND_PORT}"
log_info "后端监听: 127.0.0.1:${BACKEND_PORT}"
