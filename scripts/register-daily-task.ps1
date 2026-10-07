<#
.SYNOPSIS
    Registers the TEFAS daily update as a Windows Scheduled Task.

.DESCRIPTION
    Creates (or replaces) a daily task that runs `node dist/cli.js daily`.
    StartWhenAvailable is enabled, so a machine that was asleep at the scheduled
    time still runs the job on next wake - the crawler itself then backfills
    whatever days it missed.

.PARAMETER Time
    24h HH:mm start time. TEFAS publishes the day's prices in the evening.

.PARAMETER TaskName
    Scheduled Task name.

.PARAMETER Unregister
    Remove the task instead of creating it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1
    powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1 -Time 21:15
    powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string]$Time = '20:00',
    [string]$TaskName = 'TefasDailyUpdate',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    }
    else {
        Write-Host "No scheduled task named '$TaskName'."
    }
    return
}

if ($Time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw "Invalid -Time '$Time'. Use 24h HH:mm, e.g. 20:00."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw 'node.exe not found on PATH. Install Node.js 22+ first.'
}

$entry = Join-Path $projectRoot 'dist\cli.js'
if (-not (Test-Path $entry)) {
    Write-Host 'dist/ missing - building...'
    Push-Location $projectRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}
if (-not (Test-Path $entry)) {
    throw "Build did not produce $entry"
}

$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$action = New-ScheduledTaskAction -Execute $node -Argument '"dist\cli.js" daily' -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Fetches the latest TEFAS fund data into the local SQLite archive.' | Out-Null

Write-Host "Registered '$TaskName' - runs daily at $Time."
Write-Host "  Command:  $node `"dist\cli.js`" daily"
Write-Host "  Workdir:  $projectRoot"
Write-Host "  Logs:     $logDir\tefas-<date>.log"
Write-Host ''
Write-Host "Run it once now with:  Start-ScheduledTask -TaskName '$TaskName'"
