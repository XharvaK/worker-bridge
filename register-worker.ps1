<#
.SYNOPSIS
    Registers Gemini Worker Bridge as a normal-user Windows Scheduled Task at Logon.
    Does NOT require administrator privileges.
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistEntry = Join-Path $ScriptDir "dist\index.js"

if (-not (Test-Path $DistEntry)) {
    Write-Host "Building project first..." -ForegroundColor Cyan
    npm run build --prefix "$ScriptDir"
}

$NodePath = (Get-Command node.exe).Source
if (-not $NodePath) {
    Write-Error "node.exe not found in PATH."
    exit 1
}

$TaskName = "GeminiWorkerBridge"
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$DistEntry`" start" -WorkingDirectory "$ScriptDir"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Write-Host "Registering Scheduled Task: $TaskName..." -ForegroundColor Cyan
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Description "Headless Antigravity Gemini Worker Bridge Daemon" -Force | Out-Null

Write-Host "Gemini Worker Bridge registered successfully. It will start automatically when you log in." -ForegroundColor Green
Write-Host "To start it immediately, run: Start-ScheduledTask -TaskName `"$TaskName`"" -ForegroundColor Yellow
