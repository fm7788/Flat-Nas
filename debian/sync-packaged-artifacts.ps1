# 将「当前仓库」里刚构建的产物同步到本目录（Debian 离线包 / deploy.sh 所用布局）。
# Windows 上 Vite 默认只写入 ../server/public，不会自动更新 debian/server/public，需执行本脚本或手动镜像。
# 用法（在仓库根目录）:  powershell -ExecutionPolicy Bypass -File debian/sync-packaged-artifacts.ps1
# 可选: 跳过前端构建 -SkipFrontend   跳过后端构建 -SkipBackend

param(
    [switch] $SkipFrontend,
    [switch] $SkipBackend
)

$ErrorActionPreference = "Stop"
$debianRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $debianRoot

if (-not $SkipBackend) {
    Push-Location (Join-Path $repoRoot "backend")
    try {
        $env:CGO_ENABLED = "0"
        $env:GOOS = "linux"
        $env:GOARCH = "amd64"
        go build -ldflags="-s -w" -o flatnas-server .
    } finally {
        Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
        Remove-Item Env:GOOS -ErrorAction SilentlyContinue
        Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
        Pop-Location
    }
    Copy-Item -Force (Join-Path $repoRoot "backend\flatnas-server") (Join-Path $debianRoot "flatnas-server")
}

if (-not $SkipFrontend) {
    Push-Location (Join-Path $repoRoot "frontend")
    try {
        npm run build
    } finally {
        Pop-Location
    }
}

$srcPublic = Join-Path $repoRoot "server\public"
$dstPublic = Join-Path $debianRoot "server\public"
if (-not (Test-Path $srcPublic)) {
    Write-Error "缺少 $srcPublic ，请先构建前端。"
}
New-Item -ItemType Directory -Force -Path $dstPublic | Out-Null
robocopy $srcPublic $dstPublic /MIR /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }
Write-Host "已同步: flatnas-server + server/public -> debian/"
