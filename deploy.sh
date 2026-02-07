#!/bin/bash

# FlatNas One-Click Deployment Script for Debian
# Author: Trae AI Assistant
# Description: Automated deployment of FlatNas on Debian systems with Nginx and Systemd.

set -e

# Configuration
APP_DIR="/opt/flatnas"
REPO_URL="https://github.com/Garry-QD/FlatNas.git"
NODE_MAJOR=20
SERVICE_NAME="flatnas"
NGINX_CONF="/etc/nginx/sites-available/flatnas"
SWAP_FILE="/swapfile"
GIT_REMOTE_NAME="origin"
GIT_DEFAULT_BRANCH="main"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Log function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}"
    exit 1
}

warn() {
    echo -e "${YELLOW}[WARN] $1${NC}"
}

get_origin_default_branch() {
    cd "$APP_DIR"
    branch=$(git symbolic-ref -q --short refs/remotes/${GIT_REMOTE_NAME}/HEAD 2>/dev/null | sed "s@^${GIT_REMOTE_NAME}/@@")
    if [ -n "$branch" ]; then
        echo "$branch"
        return 0
    fi
    echo "${GIT_DEFAULT_BRANCH}"
}

backup_persistent_data() {
    BACKUP_DIR="/tmp/flatnas-backup-$(date +%s)"
    mkdir -p "$BACKUP_DIR"

    if [ -d "${APP_DIR}/server/data" ]; then
        cp -a "${APP_DIR}/server/data" "$BACKUP_DIR/"
    fi
    if [ -d "${APP_DIR}/server/doc" ]; then
        cp -a "${APP_DIR}/server/doc" "$BACKUP_DIR/"
    fi
    if [ -d "${APP_DIR}/server/music" ]; then
        cp -a "${APP_DIR}/server/music" "$BACKUP_DIR/"
    fi
    if [ -d "${APP_DIR}/server/PC" ]; then
        cp -a "${APP_DIR}/server/PC" "$BACKUP_DIR/"
    fi
    if [ -d "${APP_DIR}/server/APP" ]; then
        cp -a "${APP_DIR}/server/APP" "$BACKUP_DIR/"
    fi
    if [ -d "${APP_DIR}/server/cgi-bin" ]; then
        cp -a "${APP_DIR}/server/cgi-bin" "$BACKUP_DIR/"
    fi
    if [ -f "${APP_DIR}/server/default.json" ]; then
        cp -a "${APP_DIR}/server/default.json" "$BACKUP_DIR/default.json.bak"
    fi
}

restore_persistent_data() {
    if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
        return 0
    fi

    mkdir -p "${APP_DIR}/server"

    if [ -d "${BACKUP_DIR}/data" ]; then
        rm -rf "${APP_DIR}/server/data"
        cp -a "${BACKUP_DIR}/data" "${APP_DIR}/server/"
    fi
    if [ -d "${BACKUP_DIR}/doc" ]; then
        rm -rf "${APP_DIR}/server/doc"
        cp -a "${BACKUP_DIR}/doc" "${APP_DIR}/server/"
    fi
    if [ -d "${BACKUP_DIR}/music" ]; then
        rm -rf "${APP_DIR}/server/music"
        cp -a "${BACKUP_DIR}/music" "${APP_DIR}/server/"
    fi
    if [ -d "${BACKUP_DIR}/PC" ]; then
        rm -rf "${APP_DIR}/server/PC"
        cp -a "${BACKUP_DIR}/PC" "${APP_DIR}/server/"
    fi
    if [ -d "${BACKUP_DIR}/APP" ]; then
        rm -rf "${APP_DIR}/server/APP"
        cp -a "${BACKUP_DIR}/APP" "${APP_DIR}/server/"
    fi
    if [ -d "${BACKUP_DIR}/cgi-bin" ]; then
        rm -rf "${APP_DIR}/server/cgi-bin"
        cp -a "${BACKUP_DIR}/cgi-bin" "${APP_DIR}/server/"
    fi
}

safe_git_update() {
    cd "$APP_DIR"
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        error "${APP_DIR} is not a git repository."
    fi

    log "Backing up persistent data..."
    backup_persistent_data

    log "Fetching latest code..."
    git fetch "${GIT_REMOTE_NAME}" --prune

    git merge --abort 2>/dev/null || true
    git rebase --abort 2>/dev/null || true

    TARGET_BRANCH=$(get_origin_default_branch)
    if git show-ref --verify --quiet "refs/remotes/${GIT_REMOTE_NAME}/${TARGET_BRANCH}"; then
        log "Resetting code to ${GIT_REMOTE_NAME}/${TARGET_BRANCH}..."
        git reset --hard "${GIT_REMOTE_NAME}/${TARGET_BRANCH}"
    else
        log "Resetting code to ${GIT_REMOTE_NAME}/${GIT_DEFAULT_BRANCH}..."
        git reset --hard "${GIT_REMOTE_NAME}/${GIT_DEFAULT_BRANCH}"
    fi

    # Fix permissions
    chmod +x deploy.sh

    git clean -fd

    log "Restoring persistent data..."
    restore_persistent_data
}

# 1. System Environment Check
check_system() {
    log "Checking system environment..."
    if [ "$EUID" -ne 0 ]; then
        error "Please run as root (sudo ./deploy.sh)"
    fi

    if [ ! -f /etc/debian_version ]; then
        error "This script is designed for Debian systems only."
    fi
    
    log "System check passed: Debian detected."
}

# 1.1 Check and Add Swap
check_and_add_swap() {
    log "Checking memory and swap..."
    
    # Check physical memory size (in MB)
    MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}')
    
    # If memory is less than 2048MB (2GB)
    if [ "$MEM_TOTAL" -lt 2048 ]; then
        log "Low memory detected (${MEM_TOTAL}MB). Checking swap..."
        
        # Check current swap size
        SWAP_TOTAL=$(free -m | awk '/^Swap:/{print $2}')
        
        if [ "$SWAP_TOTAL" -lt 1024 ]; then
            ROOT_FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
            SWAP_MB=2048
            if [ -n "$ROOT_FREE_MB" ] && [ "$ROOT_FREE_MB" -lt 3072 ]; then
                SWAP_MB=1024
            fi

            log "Swap is insufficient. Creating ${SWAP_MB}MB swap file..."
            
            # Create swap file
            if [ -f "${SWAP_FILE}" ]; then
                swapoff "${SWAP_FILE}" 2>/dev/null || true
                rm -f "${SWAP_FILE}"
            fi

            if ! fallocate -l ${SWAP_MB}M "${SWAP_FILE}" 2>/dev/null; then
                dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="${SWAP_MB}"
            fi
            
            chmod 600 "${SWAP_FILE}"
            mkswap "${SWAP_FILE}" >/dev/null
            swapon "${SWAP_FILE}"
            
            # Make it permanent if not already in fstab
            if ! grep -q "${SWAP_FILE}" /etc/fstab; then
                echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
            fi
            
            log "Swap created and enabled successfully."
        else
            log "Swap size is sufficient (${SWAP_TOTAL}MB)."
        fi
    else
        log "Memory is sufficient (${MEM_TOTAL}MB)."
    fi
}

# 2. Install Dependencies
install_dependencies() {
    log "Updating system and installing dependencies..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl git gnupg2 ca-certificates lsb-release build-essential python3

    # Install Node.js
    if ! command -v node &> /dev/null || [ $(node -v | cut -d'.' -f1 | cut -c2-) -lt $NODE_MAJOR ]; then
        log "Installing or Updating Node.js to ${NODE_MAJOR}..."
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
        apt-get update -qq
        apt-get install -y -qq nodejs
    else
        log "Node.js is already installed: $(node -v)"
    fi

    # Install Nginx
    if ! command -v nginx &> /dev/null; then
        log "Installing Nginx..."
        apt-get install -y -qq nginx
    else
        log "Nginx is already installed."
    fi
    
    # Enable Nginx
    systemctl enable nginx
    systemctl start nginx
}

# 3. Deploy Application
deploy_app() {
    log "Deploying application to ${APP_DIR}..."

    # Create directory if not exists
    if [ ! -d "$APP_DIR" ]; then
        log "Cloning repository..."
        git clone "$REPO_URL" "$APP_DIR"
    else
        log "Directory exists. Updating code safely (keep data)..."
        safe_git_update
    fi

    cd "$APP_DIR" || error "Failed to enter directory ${APP_DIR}"

    export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
    export npm_config_audit=false
    export npm_config_fund=false
    export npm_config_progress=false
    export npm_config_loglevel=error
    export npm_config_jobs=1

    # Install project dependencies
    log "Installing npm dependencies..."
    if [ -f "package-lock.json" ]; then
        npm ci --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi

    # Build Frontend
    log "Building frontend..."
    NODE_OPTIONS="--max-old-space-size=1024" npm run build

    # Prepare backend directories
    log "Preparing backend directories..."
    mkdir -p server/data server/doc server/music server/PC server/APP server/cgi-bin

    # Set permissions for CGI scripts
    log "Setting permissions for CGI scripts..."
    if [ -d "server/cgi-bin" ]; then
        chmod +x server/cgi-bin/* 2>/dev/null || true
    fi
}

deploy_app_local() {
    log "Deploying local code in ${APP_DIR} (no git pull/reset)..."

    if [ ! -d "$APP_DIR" ]; then
        error "Application directory not found: ${APP_DIR}. Please run install first."
    fi

    cd "$APP_DIR" || error "Failed to enter directory ${APP_DIR}"

    export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
    export npm_config_audit=false
    export npm_config_fund=false
    export npm_config_progress=false
    export npm_config_loglevel=error
    export npm_config_jobs=1

    log "Installing npm dependencies..."
    if [ -f "package-lock.json" ]; then
        npm ci --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi

    log "Building frontend..."
    NODE_OPTIONS="--max-old-space-size=1024" npm run build

    log "Preparing backend directories..."
    mkdir -p server/data server/doc server/music server/PC server/APP server/cgi-bin

    log "Setting permissions for CGI scripts..."
    if [ -d "server/cgi-bin" ]; then
        chmod +x server/cgi-bin/* 2>/dev/null || true
    fi
}

# 4. Configure Systemd Service
setup_service() {
    log "Configuring Systemd service..."
    
    NODE_BIN=$(which node)
    if [ -z "$NODE_BIN" ]; then
        error "Node.js binary not found. Installation might have failed."
    fi

    cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=FlatNas Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server/server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=256

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME}
    log "Restarting application service..."
    systemctl restart ${SERVICE_NAME}
}

# 5. Configure Nginx
setup_nginx() {
    log "Configuring Nginx..."

    cat > ${NGINX_CONF} <<EOF
server {
    listen 80;
    server_name _;

    root ${APP_DIR}/dist;
    index index.html;
    client_max_body_size 0;

    # Frontend
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /socket.io/ {
        proxy_pass http://localhost:3000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    # Music
    location /music/ {
        proxy_pass http://localhost:3000/music/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # PC Wallpapers
    location /backgrounds/ {
        proxy_pass http://localhost:3000/backgrounds/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Mobile Wallpapers
    location /mobile_backgrounds/ {
        proxy_pass http://localhost:3000/mobile_backgrounds/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    # CGI
    location ~ \.cgi$ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

    # Enable site
    if [ ! -L /etc/nginx/sites-enabled/flatnas ]; then
        ln -s ${NGINX_CONF} /etc/nginx/sites-enabled/
    fi

    # Disable default if exists
    if [ -f /etc/nginx/sites-enabled/default ]; then
        rm /etc/nginx/sites-enabled/default
    fi

    # Test and Reload
    nginx -t
    systemctl reload nginx
}

view_config() {
    check_system

    IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$IP_ADDR" ]; then
        IP_ADDR=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | head -n 1 | cut -d/ -f1)
    fi

    if command -v curl >/dev/null 2>&1; then
        PUBLIC_IP=$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || true)
    fi
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP="Unknown"
    fi

    AUTH_MODE="single"
    SYSTEM_JSON="${APP_DIR}/server/data/system.json"
    if [ -f "$SYSTEM_JSON" ] && command -v python3 >/dev/null 2>&1; then
        AUTH_MODE=$(python3 - <<PY 2>/dev/null || echo "single"
import json
with open("${SYSTEM_JSON}", "r", encoding="utf-8") as f:
    print(json.load(f).get("authMode", "single"))
PY
)
    fi

    echo -e "${GREEN}=============================================${NC}"
    echo -e "${GREEN}            FlatNas 配置查看                ${NC}"
    echo -e "${GREEN}=============================================${NC}"
    echo "应用目录: ${APP_DIR}"
    echo "Nginx 配置: ${NGINX_CONF}"
    echo "数据目录: ${APP_DIR}/server/data"
    echo "文件传输: ${APP_DIR}/server/doc/transfer"
    echo "音乐目录: ${APP_DIR}/server/music"
    echo
    echo "服务状态:"
    echo "  flatnas: $(systemctl is-active ${SERVICE_NAME} 2>/dev/null || echo unknown) / $(systemctl is-enabled ${SERVICE_NAME} 2>/dev/null || echo unknown)"
    echo "  nginx:   $(systemctl is-active nginx 2>/dev/null || echo unknown) / $(systemctl is-enabled nginx 2>/dev/null || echo unknown)"
    echo
    echo "登录入口:"
    if [ -n "$IP_ADDR" ]; then
        echo "  内网:  http://${IP_ADDR}"
    fi
    echo "  外网:  http://${PUBLIC_IP}"
    echo
    echo "账号信息:"
    if [ "$AUTH_MODE" = "multi" ]; then
        echo "  模式: 多用户"
        echo "  默认管理员: admin / admin"
        echo "  说明: 多用户模式可在网页端注册新用户"
    else
        echo "  模式: 单用户"
        echo "  默认密码: admin"
        echo "  说明: 单用户模式登录时只需输入密码"
    fi
    echo -e "${GREEN}=============================================${NC}"
}

# 7. Uninstall FlatNas
uninstall_app() {
    log "Uninstalling FlatNas..."

    # 1. Stop and Remove Service
    if systemctl list-units --full -all | grep -Fq "${SERVICE_NAME}.service"; then
        log "Stopping and disabling service..."
        systemctl stop ${SERVICE_NAME}
        systemctl disable ${SERVICE_NAME}
        rm -f /etc/systemd/system/${SERVICE_NAME}.service
        systemctl daemon-reload
    else
        warn "Service ${SERVICE_NAME} not found."
    fi

    # 2. Remove Nginx Config
    if [ -f "${NGINX_CONF}" ]; then
        log "Removing Nginx configuration..."
        rm -f ${NGINX_CONF}
        rm -f /etc/nginx/sites-enabled/flatnas
        if command -v nginx &> /dev/null; then
            nginx -t
            systemctl reload nginx
        fi
    else
        warn "Nginx configuration not found."
    fi

    # 3. Remove Files
    if [ -d "$APP_DIR" ]; then
        echo -e "${YELLOW}Warning: This will delete the application directory.${NC}"
        read -p "Do you want to delete ALL DATA in $APP_DIR? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            log "Removing application files..."
            rm -rf "$APP_DIR"
            log "FlatNas has been completely removed."
        else
            log "Application files kept at $APP_DIR."
            log "FlatNas service and nginx config have been removed."
        fi
    else
        log "Application directory not found."
    fi
}

# Main Menu
show_help() {
    echo "Usage: ./deploy.sh [OPTION]"
    echo "Options:"
    echo "  install    - Full installation and deployment"
    echo "  update     - Pull latest code and rebuild"
    echo "  rebuild    - Rebuild and restart using local code (no git pull/reset)"
    echo "  uninstall  - Remove FlatNas service and files"
    echo "  config     - Show current deployment config and login entry"
    echo "  help       - Show this help message"
}

# Function to handle installation logic
do_install() {
    check_system
    check_and_add_swap
    install_dependencies
    deploy_app
    setup_service
    setup_nginx
    
    IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$IP_ADDR" ]; then
        IP_ADDR=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | head -n 1 | cut -d/ -f1)
    fi

    PUBLIC_IP=$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || echo "Unknown")
    
    log "==============================================="
    log "   FlatNas Deployment Successful!   "
    log "==============================================="
    log "Access your FlatNas at:"
    log "  Local:   http://${IP_ADDR}"
    log "  Public:  http://${PUBLIC_IP}"
    log "==============================================="
}

do_update() {
    check_system
    check_and_add_swap
    install_dependencies
    deploy_app
    setup_service
    setup_nginx
    log "Update Complete!"
}

do_rebuild() {
    check_system
    deploy_app_local
    setup_service
    setup_nginx
    log "Rebuild Complete!"
}

is_tty() {
    [ -t 0 ] && [ -t 1 ]
}

maybe_clear() {
    if is_tty && command -v clear >/dev/null 2>&1; then
        clear
    fi
}

show_menu() {
    while true; do
        maybe_clear
        echo -e "${GREEN}=============================================${NC}"
        echo -e "${GREEN}      FlatNas 一键部署（交互式）            ${NC}"
        echo -e "${GREEN}=============================================${NC}"
        echo "1. 安装 / 重新部署"
        echo "2. 更新（保留数据）"
        echo "3. 卸载"
        echo "4. 查看配置（含登录入口）"
        echo "5. 本地重建（不拉取代码）"
        echo "0. 退出"
        echo -e "${GREEN}=============================================${NC}"
        read -p "请输入选项 [0-5]: " choice

        case $choice in
            1)
                do_install
                read -p "按回车返回菜单..." _
                ;;
            2)
                do_update
                read -p "按回车返回菜单..." _
                ;;
            3)
                check_system
                uninstall_app
                read -p "按回车返回菜单..." _
                ;;
            4)
                view_config
                read -p "按回车返回菜单..." _
                ;;
            5)
                do_rebuild
                read -p "按回车返回菜单..." _
                ;;
            0)
                exit 0
                ;;
            *)
                echo -e "${YELLOW}无效选项：${choice}${NC}"
                read -p "按回车重试..." _
                ;;
        esac
    done
}

action_confirm_or_menu() {
    local action="$1"
    if ! is_tty; then
        return 0
    fi
    if [ "${FLATNAS_DEPLOY_YES:-0}" = "1" ] || [ "${FLATNAS_DEPLOY_YES:-}" = "true" ]; then
        return 0
    fi
    echo -e "${YELLOW}即将执行：${action}${NC}"
    echo -e "${YELLOW}如需跳过确认可使用：FLATNAS_DEPLOY_YES=1 或追加参数 --yes${NC}"
    read -r -p "确认继续？[y/N] " ans
    if [[ "$ans" =~ ^[Yy]$ ]]; then
        return 0
    fi
    show_menu
    exit 0
}

ACTION="${1:-}"
shift 1 2>/dev/null || true

AUTO_YES=0
FORCE_MENU=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y)
            AUTO_YES=1
            ;;
        --menu)
            FORCE_MENU=1
            ;;
    esac
done

if [ "${AUTO_YES}" = "1" ]; then
    export FLATNAS_DEPLOY_YES=1
fi

if [ -z "${ACTION}" ] || [ "${FORCE_MENU}" = "1" ]; then
    if is_tty; then
        show_menu
        exit 0
    fi
    show_help
    exit 1
fi

case "${ACTION}" in
    install)
        action_confirm_or_menu "install（安装/重新部署）"
        do_install
        ;;
    update)
        action_confirm_or_menu "update（更新并重建，保留数据）"
        do_update
        ;;
    rebuild)
        action_confirm_or_menu "rebuild（本地重建，不拉取代码）"
        do_rebuild
        ;;
    uninstall)
        action_confirm_or_menu "uninstall（卸载服务/可选删除数据）"
        check_system
        uninstall_app
        ;;
    config)
        view_config
        ;;
    help|-h|--help)
        show_help
        ;;
    *)
        show_help
        exit 1
        ;;
esac
