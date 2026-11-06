param(
    [string]$RuntimeRoot = "$env:LOCALAPPDATA\teleport-router\discord-test",
    [string]$StateHome = 'C:\RouterDiscord'
)
$ErrorActionPreference = 'Stop'
$env:HERMES_HOME = $StateHome
$env:HERMES_RUNTIME_DIR = Join-Path $RuntimeRoot 'tools'
$env:ROUTER_HOME = $env:HERMES_HOME
$env:GATEWAY_ALLOW_ALL_USERS = 'false'
$env:DISCORD_ALLOW_ALL_USERS = 'false'
$env:DISCORD_ALLOWED_USERS = ''
$env:DISCORD_ALLOWED_ROLES = ''
$workspace = Join-Path $env:HERMES_HOME 'workspace'
$logDir = Join-Path $env:HERMES_HOME 'logs'
New-Item -ItemType Directory -Path $workspace,$logDir -Force | Out-Null
Set-Location -LiteralPath $workspace
$launcher = Join-Path $env:HERMES_HOME 'bin\hermes.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Hermes launcher is missing: $launcher"
}
& $launcher gateway run *>> (Join-Path $logDir 'discord-service.log')
exit $LASTEXITCODE
