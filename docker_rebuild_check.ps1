param(
  [string]$Service = "flatnas",
  [string]$ComposeFile = "docker-compose.yml",
  [switch]$SkipDown,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function UseComposePlugin {
  try {
    docker compose version *> $null
    return $true
  } catch {
    return $false
  }
}

function InvokeCompose {
  param([string[]]$ComposeArgs)
  if ($script:UsePlugin) {
    & docker compose -f $ComposeFile @ComposeArgs
  } else {
    & docker-compose -f $ComposeFile @ComposeArgs
  }
}

function RequireCmd {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing command: $Name"
  }
}

function TestEndpoint {
  param(
    [string]$Url,
    [int]$TimeoutSec = 5
  )
  try {
    $resp = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec $TimeoutSec
    return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400
  } catch {
    return $false
  }
}

function WaitEndpoint {
  param(
    [string]$Url,
    [int]$MaxSeconds = 60
  )
  $start = Get-Date
  while (((Get-Date) - $start).TotalSeconds -lt $MaxSeconds) {
    if (TestEndpoint -Url $Url -TimeoutSec 3) {
      return $true
    }
    Start-Sleep -Milliseconds 1500
  }
  return $false
}

function GetMappedPort {
  param(
    [string]$Svc,
    [int]$ContainerPort = 3000
  )
  $output = InvokeCompose -ComposeArgs @("port", $Svc, "$ContainerPort") 2>$null
  if (-not $output) {
    return 23000
  }
  $line = ($output | Select-Object -First 1).Trim()
  if (-not $line) {
    return 23000
  }
  if ($line -match ":(\d+)$") {
    return [int]$matches[1]
  }
  if ($line -match "^\d+$") {
    return [int]$line
  }
  return 23000
}

function AssertTrue {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

RequireCmd -Name "docker"
$script:UsePlugin = UseComposePlugin
if (-not $script:UsePlugin) {
  RequireCmd -Name "docker-compose"
}

Write-Host "==> Docker rebuild and self-check start"
Write-Host "Compose file: $ComposeFile"
Write-Host "Service: $Service"

if (-not $SkipDown) {
  Write-Host "==> Stop old containers"
  InvokeCompose -ComposeArgs @("down", "--remove-orphans")
}

if (-not $SkipBuild) {
  Write-Host "==> Build image with --no-cache"
  InvokeCompose -ComposeArgs @("build", "--pull", "--no-cache", $Service)
}

Write-Host "==> Force recreate and start"
InvokeCompose -ComposeArgs @("up", "-d", "--force-recreate", $Service)

Write-Host "==> Container status"
InvokeCompose -ComposeArgs @("ps")

$hostPort = GetMappedPort -Svc $Service -ContainerPort 3000
$baseUrl = "http://127.0.0.1:$hostPort"
$pingUrl = "$baseUrl/api/ping"
$sysUrl = "$baseUrl/api/system-config"
$indexUrl = "$baseUrl/"

Write-Host "==> Base URL: $baseUrl"
AssertTrue -Condition (WaitEndpoint -Url $pingUrl -MaxSeconds 90) -Message "Ping endpoint not ready: $pingUrl"
AssertTrue -Condition (TestEndpoint -Url $sysUrl -TimeoutSec 5) -Message "System config endpoint failed: $sysUrl"
AssertTrue -Condition (TestEndpoint -Url $indexUrl -TimeoutSec 5) -Message "Index endpoint failed: $indexUrl"

$indexResp = Invoke-WebRequest -Uri $indexUrl -Method GET -TimeoutSec 8
$indexHtml = [string]$indexResp.Content
$assetPattern = "(?:src|href)=`"(/assets/[^`"]+)`""
$matches = [regex]::Matches($indexHtml, $assetPattern)
$assets = @()
foreach ($m in $matches) {
  $p = $m.Groups[1].Value
  if ($p -and -not $assets.Contains($p)) {
    $assets += $p
  }
}

AssertTrue -Condition ($assets.Count -gt 0) -Message "No /assets references found in index page"

$probeAssets = $assets | Select-Object -First 8
foreach ($asset in $probeAssets) {
  $ok = TestEndpoint -Url ($baseUrl.TrimEnd("/") + $asset) -TimeoutSec 8
  AssertTrue -Condition $ok -Message "Static asset request failed: $asset"
}

Write-Host "==> Recent logs"
InvokeCompose -ComposeArgs @("logs", "--tail", "80", $Service)

Write-Host "SUCCESS: rebuild completed and self-check passed"
