<#
MewClaw Windows 计划任务封装：安装/启停/状态/日志，无提权（登录时运行）。
来源：lark-claw infra/windows/lark-claw-service.ps1（整体平移，M0；任务名改 MewClaw）。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "status", "logs")]
  [string]$Action = "status"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "MewClaw"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$ServiceRoot = Join-Path $RepoRoot "var/services"
$LaunchEnvPath = Join-Path $ServiceRoot "launch.env"
$StatusPath = Join-Path $ServiceRoot "status.json"
$StopRequestPath = Join-Path $ServiceRoot "stop.request"
$CliPath = Join-Path $RepoRoot "infra/windows/dist/cli.js"
$EnvPath = Join-Path $RepoRoot ".env"
$GracefulStopAttempts = 120

function Get-LarkTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Assert-RuntimeReady {
  if (-not (Test-Path -LiteralPath $CliPath)) {
    throw "Service runtime is not built. Run npm run service:build first."
  }
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    throw "Repository .env is required before installing the service."
  }
}

function Ensure-LaunchEnvironment {
  New-Item -ItemType Directory -Path $ServiceRoot -Force | Out-Null
  @(
    "DSH_AUTH_ENABLED=true"
    "DSH_PROFILE=web"
  ) | Set-Content -LiteralPath $LaunchEnvPath -Encoding ascii
}

function Install-LarkTask {
  Assert-RuntimeReady
  Ensure-LaunchEnvironment
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = "--env-file-if-exists=`"$LaunchEnvPath`" --env-file-if-exists=`"$EnvPath`" `"$CliPath`" run"
  $taskAction = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $RepoRoot
  $triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $currentUser)
  )
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $task = New-ScheduledTask -Action $taskAction -Trigger $triggers -Principal $principal -Settings $settings
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Write-Output "Installed $TaskName for startup/logon under $currentUser without elevation."
}

function Start-LarkTask {
  if (-not (Get-LarkTask)) { throw "$TaskName is not installed." }
  Ensure-LaunchEnvironment
  New-Item -ItemType Directory -Path $ServiceRoot -Force | Out-Null
  Remove-Item -LiteralPath $StopRequestPath -Force -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Start requested for $TaskName."
}

function Stop-LarkTask {
  $task = Get-LarkTask
  if (-not $task) { throw "$TaskName is not installed." }
  New-Item -ItemType Directory -Path $ServiceRoot -Force | Out-Null
  New-Item -ItemType File -Path $StopRequestPath -Force | Out-Null
  for ($attempt = 0; $attempt -lt $GracefulStopAttempts; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ((Get-ScheduledTask -TaskName $TaskName).State -ne "Running") {
      Write-Output "Stopped $TaskName gracefully."
      return
    }
  }
  Stop-ScheduledTask -TaskName $TaskName
  Write-Warning "$TaskName exceeded the graceful stop window and was terminated."
}

function Show-LarkStatus {
  $task = Get-LarkTask
  if (-not $task) {
    [pscustomobject]@{ installed = $false; task = $TaskName } | ConvertTo-Json
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $runtime = if (Test-Path -LiteralPath $StatusPath) {
    Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
  } else { $null }
  [pscustomobject]@{
    installed = $true
    lastRunTime = $info.LastRunTime
    lastTaskResult = $info.LastTaskResult
    nextRunTime = $info.NextRunTime
    runtime = $runtime
    state = $task.State.ToString()
    task = $TaskName
  } | ConvertTo-Json -Depth 8
}

function Show-LarkLogs {
  foreach ($name in @("supervisor", "worker", "admin", "auth", "gateway")) {
    $path = Join-Path $ServiceRoot "$name.log"
    Write-Output "[$name]"
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Tail 80 }
  }
}

switch ($Action) {
  "install" { Install-LarkTask }
  "uninstall" {
    if (Get-LarkTask) {
      Stop-LarkTask
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Write-Output "Uninstalled $TaskName. Runtime data and logs were retained."
  }
  "start" { Start-LarkTask }
  "stop" { Stop-LarkTask }
  "restart" { Stop-LarkTask; Start-LarkTask }
  "status" { Show-LarkStatus }
  "logs" { Show-LarkLogs }
}
