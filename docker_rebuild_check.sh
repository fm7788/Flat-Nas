#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SERVICE="${1:-flatnas}"
COMPOSE_FILE="${2:-docker-compose.yml}"
SKIP_DOWN="${SKIP_DOWN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose -f "${COMPOSE_FILE}" "$@"; }
else
  echo "缺少 docker compose 或 docker-compose" >&2
  exit 1
fi

test_endpoint() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1
}

wait_endpoint() {
  local url="$1"
  local timeout="${2:-90}"
  local start now
  start="$(date +%s)"
  while true; do
    if test_endpoint "$url"; then
      return 0
    fi
    now="$(date +%s)"
    if [ $((now - start)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
  done
}

assert_true() {
  local cond="$1"
  local msg="$2"
  if [ "$cond" != "0" ]; then
    echo "$msg" >&2
    exit 1
  fi
}

echo "==> Docker 无缓存重建 + 自检开始"
echo "Compose 文件: ${COMPOSE_FILE}"
echo "服务名: ${SERVICE}"

if [ "${SKIP_DOWN}" != "1" ]; then
  echo "==> 停止旧容器"
  compose down --remove-orphans
fi

if [ "${SKIP_BUILD}" != "1" ]; then
  echo "==> 无缓存构建镜像"
  compose build --pull --no-cache "${SERVICE}"
fi

echo "==> 强制重建并启动"
compose up -d --force-recreate "${SERVICE}"

echo "==> 容器状态"
compose ps

host_port="$(compose port "${SERVICE}" 3000 2>/dev/null | head -n1 | sed -E 's/.*:([0-9]+)$/\1/')"
if ! [[ "${host_port:-}" =~ ^[0-9]+$ ]]; then
  host_port="23000"
fi

base_url="http://127.0.0.1:${host_port}"
ping_url="${base_url}/api/ping"
sys_url="${base_url}/api/system-config"
index_url="${base_url}/"

echo "==> 服务地址: ${base_url}"
wait_endpoint "${ping_url}" 90 || { echo "接口未就绪: ${ping_url}" >&2; exit 1; }
test_endpoint "${sys_url}" || { echo "接口检查失败: ${sys_url}" >&2; exit 1; }
test_endpoint "${index_url}" || { echo "首页检查失败: ${index_url}" >&2; exit 1; }

index_html="$(curl -fsS --max-time 8 "${index_url}")"
assets="$(printf '%s' "${index_html}" | grep -Eo '(src|href)="\/assets\/[^"]+"' | sed -E 's/^(src|href)="([^"]+)"$/\2/' | awk '!seen[$0]++' | head -n 8)"
if [ -z "${assets}" ]; then
  echo "未在首页解析到 /assets 资源引用" >&2
  exit 1
fi

while IFS= read -r asset; do
  [ -z "${asset}" ] && continue
  test_endpoint "${base_url}${asset}" || { echo "静态资源访问失败: ${asset}" >&2; exit 1; }
done <<< "${assets}"

echo "==> 最近日志"
compose logs --tail 80 "${SERVICE}"

echo "✅ 重建完成且自检通过"
