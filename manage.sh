#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# FlatNas Debian 管理脚本 (优化版)
# 说明：
#   用于管理 FlatNas 服务 (启动/停止/重启/查看日志/修改端口/配置HTTPS)
#   基于 deploy.sh 的配置结构进行统一
#
# 使用方式：
#   cd /path/to/flatnas
#   chmod +x manage.sh
#   sudo ./manage.sh

APP_NAME="flatnas"
APP_USER="flatnas"
SERVICE_NAME="flatnas"

# 目录结构 (保持与 deploy.sh 一致)
INSTALL_DIR="/opt/${APP_NAME}"
SERVER_DIR="${INSTALL_DIR}/server"
PUBLIC_DIR="${SERVER_DIR}/public"
CONFIG_DIR="/etc/${APP_NAME}"
CONFIG_FILE="${CONFIG_DIR}/${APP_NAME}.env"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"
SYSTEMD_SERVICE="/etc/systemd/system/${APP_NAME}.service"
SSL_DIR="/etc/nginx/ssl/${APP_NAME}"

# 颜色定义
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
    fail_with_tip "请使用 root 权限运行脚本" "Debian 下可使用: sudo ./manage.sh"
  fi
}

require_debian() {
  if [ ! -f /etc/debian_version ]; then
    fail_with_tip "仅支持 Debian 系统" "请在 Debian 系统内执行该脚本"
  fi
}

prompt() {
  local label="$1"
  local default="$2"
  read -r -p "${label} [${default}]: " input
  echo "${input:-$default}"
}

prompt_yes_no() {
  local label="$1"
  local default="$2"
  read -r -p "${label} [${default}]: " input
  local val="${input:-$default}"
  case "${val,,}" in
    y|yes|是) echo "yes" ;;
    *) echo "no" ;;
  esac
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
  if is_port_in_use "${port}"; then
    # 如果是 Nginx 或 FlatNas 自己占用了，可以接受(因为我们要重启它们)
    if systemctl is-active --quiet nginx || systemctl is-active --quiet "${SERVICE_NAME}"; then
       return 0
    fi
    fail_with_tip "${name} 端口 ${port} 已被占用" "请先释放该端口或选择其他端口"
  fi
}

load_config() {
  # 默认值
  FRONTEND_PORT="23000"
  BACKEND_PORT="3000"
  HTTPS_ENABLED="no"
  SSL_CERT=""
  SSL_KEY=""
  
  if [ -f "${CONFIG_FILE}" ]; then
    set -a
    . "${CONFIG_FILE}"
    set +a
  fi

  # 兼容 deploy.sh 生成的配置 (deploy.sh 使用 PORT, manage.sh 使用 BACKEND_PORT)
  if [ -z "${BACKEND_PORT:-}" ] && [ -n "${PORT:-}" ]; then
    BACKEND_PORT="${PORT}"
  fi
  
  # 如果配置文件中没有 FRONTEND_PORT，尝试从 Nginx 配置中读取
  if [ -f "${NGINX_CONF}" ]; then
     # 检测 listen 行
     DETECTED_PORT=$(grep 'listen' "${NGINX_CONF}" | head -n1 | awk '{print $2}' | tr -d ';')
     # 如果是 https 配置 (listen 443 ssl)，则需要找 http 跳转或者假设 HTTPS_ENABLED=yes
     # 简单起见，如果开启了 HTTPS，通常 Nginx 配置会有变化。
     # 这里主要为了恢复 deploy.sh 刚刚部署后的状态。
     
     if [ -n "${DETECTED_PORT}" ] && [ "${DETECTED_PORT}" != "443" ]; then
        # 如果不是标准 443 (ssl)，假设这是前端端口
        # 注意：如果启用了 HTTPS，Nginx 配置第一个 server 块通常是 301 跳转，监听的是 HTTP 端口
        FRONTEND_PORT="${DETECTED_PORT}"
     fi
  fi
  
  # 确保变量有值
  FRONTEND_PORT="${FRONTEND_PORT:-23000}"
  BACKEND_PORT="${BACKEND_PORT:-3000}"
  PORT="${BACKEND_PORT}"
}

save_config() {
  mkdir -p "${CONFIG_DIR}"
  cat > "${CONFIG_FILE}" <<EOF
PORT=${BACKEND_PORT}
PUBLIC_DIR=${PUBLIC_DIR}
FRONTEND_PORT=${FRONTEND_PORT}
BACKEND_PORT=${BACKEND_PORT}
HTTPS_ENABLED=${HTTPS_ENABLED}
SSL_CERT=${SSL_CERT}
SSL_KEY=${SSL_KEY}
EOF
  chown root:root "${CONFIG_FILE}"
  chmod 644 "${CONFIG_FILE}"
}

write_nginx_config() {
  local use_https="${HTTPS_ENABLED:-no}"
  
  if [ "${use_https}" = "yes" ] && [ -n "${SSL_CERT}" ] && [ -n "${SSL_KEY}" ]; then
    cat > "${NGINX_CONF}" <<EOF
server {
    listen ${FRONTEND_PORT};
    server_name _;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name _;
    client_max_body_size 20m;
    
    ssl_certificate ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};
    
    root ${PUBLIC_DIR};
    index index.html;
    
    # 开启 gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    # 缓存静态资源
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 30d;
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
        
        # WebSocket 支持
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
  else
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

    # 缓存静态资源
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 30d;
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
        
        # WebSocket 支持
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
  fi

  # 确保软链接存在
  ln -sf "${NGINX_CONF}" "${NGINX_LINK}"
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
ExecStart=${INSTALL_DIR}/bin/${APP_NAME}
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

print_tips() {
  echo ""
  log_info "常用命令:"
  echo "  - 查看服务状态: systemctl status ${SERVICE_NAME}"
  echo "  - 查看应用日志: journalctl -u ${SERVICE_NAME} -n 50 -f"
  echo "  - 重启应用服务: systemctl restart ${SERVICE_NAME}"
  echo "  - 重启 Nginx:   systemctl restart nginx"
  echo ""
}

confirm_twice() {
  local label="$1"
  if [ "$(prompt_yes_no "${label} (yes/no)" "no")" != "yes" ]; then
    return 1
  fi
  if [ "$(prompt_yes_no "再次确认 (yes/no)" "no")" != "yes" ]; then
    return 1
  fi
  return 0
}

change_ports_flow() {
  load_config
  
  local new_frontend
  local new_backend
  
  echo "当前配置: 前端端口=${FRONTEND_PORT}, 后端端口=${BACKEND_PORT}"
  
  new_frontend="$(prompt "输入新前端端口" "${FRONTEND_PORT}")"
  new_backend="$(prompt "输入新后端端口" "${BACKEND_PORT}")"
  
  if ! validate_port "${new_frontend}"; then
    fail_with_tip "前端端口 ${new_frontend} 无效 (范围 1-65535)"
  fi
  if ! validate_port "${new_backend}"; then
    fail_with_tip "后端端口 ${new_backend} 无效 (范围 1-65535)"
  fi
  if [ "${new_frontend}" = "${new_backend}" ]; then
    fail_with_tip "前端和后端不能使用相同端口"
  fi
  
  require_free_port "${new_frontend}" "前端"
  require_free_port "${new_backend}" "后端"
  
  FRONTEND_PORT="${new_frontend}"
  BACKEND_PORT="${new_backend}"
  
  log_info "正在更新配置..."
  save_config
  write_nginx_config
  write_systemd_service
  
  log_info "正在重启服务..."
  nginx -t >/dev/null || fail_with_tip "Nginx 配置生成有误，请检查"
  systemctl restart nginx
  systemctl restart "${SERVICE_NAME}"
  
  log_info "端口修改成功！"
  print_tips
}

configure_https_flow() {
  load_config
  
  local cert_path
  local key_path
  
  echo "配置 HTTPS 需要您提供证书(.pem)和私钥(.key/.pem)的绝对路径"
  cert_path="$(prompt "证书路径" "")"
  key_path="$(prompt "私钥路径" "")"
  
  if [ ! -f "${cert_path}" ]; then
    fail_with_tip "证书文件不存在: ${cert_path}"
  fi
  if [ ! -f "${key_path}" ]; then
    fail_with_tip "私钥文件不存在: ${key_path}"
  fi
  
  mkdir -p "${SSL_DIR}"
  cp -f "${cert_path}" "${SSL_DIR}/cert.pem"
  cp -f "${key_path}" "${SSL_DIR}/key.pem"
  
  HTTPS_ENABLED="yes"
  SSL_CERT="${SSL_DIR}/cert.pem"
  SSL_KEY="${SSL_DIR}/key.pem"
  
  log_info "正在应用 HTTPS 配置..."
  save_config
  write_nginx_config
  
  nginx -t >/dev/null || fail_with_tip "Nginx 配置生成有误，请检查"
  systemctl restart nginx
  
  log_info "HTTPS 配置完成！"
  echo "请尝试访问: https://<服务器IP>:${FRONTEND_PORT}"
}

status_flow() {
  load_config
  echo "------------------------------"
  log_info "系统状态检查"
  echo "------------------------------"
  echo "配置信息:"
  echo "  - 前端端口: ${FRONTEND_PORT}"
  echo "  - 后端端口: ${BACKEND_PORT}"
  echo "  - HTTPS状态: ${HTTPS_ENABLED}"
  echo "  - 静态目录: ${PUBLIC_DIR}"
  echo ""
  
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    log_info "后端服务 (${SERVICE_NAME}): [运行中]"
  else
    log_warn "后端服务 (${SERVICE_NAME}): [未运行]"
  fi
  
  if systemctl is-active --quiet nginx; then
    log_info "Nginx 服务: [运行中]"
  else
    log_warn "Nginx 服务: [未运行]"
  fi
  
  echo ""
  log_info "最近 10 条应用日志:"
  journalctl -u "${SERVICE_NAME}" -n 10 --no-pager
  
  print_tips
}

view_logs_flow() {
    echo "正在查看应用实时日志 (按 Ctrl+C 退出)..."
    journalctl -u "${SERVICE_NAME}" -f
}

uninstall_flow() {
  echo "!!!"
  echo "警告：此操作将完全删除 FlatNas 服务、配置文件、日志及数据！"
  echo "!!!"
  
  if ! confirm_twice "确定要卸载吗？"; then
    echo "取消卸载。"
    return
  fi
  
  log_info "停止服务..."
  systemctl stop "${SERVICE_NAME}" || true
  systemctl stop nginx || true
  systemctl disable "${SERVICE_NAME}" || true
  
  log_info "删除服务文件..."
  rm -f "${SYSTEMD_SERVICE}"
  systemctl daemon-reload
  
  log_info "删除 Nginx 配置..."
  rm -f "${NGINX_CONF}"
  rm -f "${NGINX_LINK}"
  
  log_info "删除应用文件..."
  rm -rf "${INSTALL_DIR}"
  rm -rf "${CONFIG_DIR}"
  rm -rf "${LOG_DIR}"
  rm -rf "${SSL_DIR}"
  
  log_info "删除用户..."
  if id "${APP_USER}" >/dev/null 2>&1; then
    userdel "${APP_USER}" || true
  fi
  
  log_info "重启 Nginx..."
  systemctl restart nginx || true
  
  log_info "卸载完成。"
  exit 0
}

main_menu() {
  while true; do
    echo "=============================="
    echo "   FlatNas 管理面板"
    echo "=============================="
    echo "1. 查看服务状态"
    echo "2. 修改端口配置"
    echo "3. 配置 HTTPS"
    echo "4. 查看实时日志"
    echo "5. 重启所有服务"
    echo "6. 卸载服务"
    echo "0. 退出"
    echo "=============================="
    
    local choice
    read -r -p "请选择 [0-6]: " choice
    case "${choice}" in
      1) status_flow ;;
      2) change_ports_flow ;;
      3) configure_https_flow ;;
      4) view_logs_flow ;;
      5) 
         systemctl restart nginx
         systemctl restart "${SERVICE_NAME}"
         log_info "服务已重启"
         ;;
      6) uninstall_flow ;;
      0) exit 0 ;;
      *) echo "无效选择" ;;
    esac
    
    echo ""
    read -r -p "按回车键返回菜单..."
  done
}

require_root
require_debian
load_config
main_menu
