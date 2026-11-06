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
# Native stderr must not become terminating PowerShell NativeCommandError records.
# Start-Process also keeps the scheduled task attached to the gateway's lifetime.
$gatewayProcess = Start-Process -FilePath $launcher -ArgumentList @('gateway','run','--external-supervisor') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'discord-stdout.log') -RedirectStandardError (Join-Path $logDir 'discord-stderr.log')
$gatewayProcess.WaitForExit()
$gatewayProcess.Refresh()
exit $gatewayProcess.ExitCode
