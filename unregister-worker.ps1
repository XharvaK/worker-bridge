<#
.SYNOPSIS
    Unregisters the Gemini Worker Bridge Windows Scheduled Task.
#>

$TaskName = "GeminiWorkerBridge"

try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Scheduled Task '$TaskName' has been unregistered." -ForegroundColor Green
} catch {
    Write-Host "Scheduled Task '$TaskName' was not found or already unregistered." -ForegroundColor Yellow
}
