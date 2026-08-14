<#
.SYNOPSIS
    Unregisters the Worker Bridge Windows Scheduled Task.
#>

$TaskName = "WorkerBridge"

Write-Host "Unregistering Scheduled Task: $TaskName..." -ForegroundColor Cyan
try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Worker Bridge scheduled task removed successfully." -ForegroundColor Green
} catch {
    Write-Host "Scheduled task '$TaskName' was not registered or already removed." -ForegroundColor Yellow
}
