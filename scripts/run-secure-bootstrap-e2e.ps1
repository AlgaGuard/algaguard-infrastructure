[CmdletBinding()]
param(
  [string]$ProjectName = "algaguard-secure-bootstrap-e2e",
  [switch]$KeepStack
)

$ErrorActionPreference = "Stop"
$env:COMPOSE_PROJECT_NAME = $ProjectName
$compose = @("compose", "--project-name", $ProjectName, "--env-file", ".env.example", "-f", "compose.yaml", "-f", "compose.application.yaml")
$failed = $false

function Invoke-Compose([string[]]$Arguments) {
  & docker @compose @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed: $($Arguments -join ' ')" }
}

function Show-Diagnostics {
  & docker @compose "ps" | Out-Host
  & docker @compose "logs" "--tail=120" "keycloak" "device-service" "access-service" 2>$null | Out-Host
}

try {
  $server = & docker info --format '{{.OSType}}'
  if ($LASTEXITCODE -ne 0 -or $server.Trim() -ne "linux") { throw "Docker Desktop Linux engine is unavailable" }
  Invoke-Compose @("config", "--quiet")
  Invoke-Compose @("down", "--volumes", "--remove-orphans")
  Invoke-Compose @("build", "access-service", "device-service", "profile-service", "telemetry-service", "mqtt-ingestion-service", "command-service", "ota-service", "realtime-service")
  Invoke-Compose @("up", "-d", "--wait", "--wait-timeout", "180", "timescaledb", "redis", "keycloak", "minio", "emqx")
  Invoke-Compose @("run", "--rm", "--no-deps", "minio-init")
  foreach ($service in @("access-service", "device-service", "profile-service", "telemetry-service", "mqtt-ingestion-service", "command-service", "ota-service")) {
    Invoke-Compose @("run", "--rm", "--no-deps", $service, "node", "dist/scripts/migrate.js")
  }
  Invoke-Compose @("up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "access-service", "device-service", "profile-service", "telemetry-service", "mqtt-ingestion-service", "command-service", "ota-service", "realtime-service")
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  & npm run test:credential
  if ($LASTEXITCODE -ne 0) { throw "secure bootstrap E2E failed" }
} catch {
  $failed = $true
  Show-Diagnostics
  throw
} finally {
  if (-not $KeepStack) { & docker @compose "down" "--volumes" "--remove-orphans" | Out-Host }
  if ($failed) { Write-Error "Secure bootstrap E2E failed; diagnostics were emitted above." }
}
