# Start Telegram Bridge in background (hidden window)
# Usage: powershell -ExecutionPolicy Bypass -File start-telegram-bridge.ps1

$scriptPath = Join-Path $PSScriptRoot "telegram-bridge.py"
$logFile = Join-Path $PSScriptRoot "..\data\telegram-bridge.log"

# Kill existing bridge if running
Get-Process -Name "python" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "telegram-bridge"
} | Stop-Process -Force -ErrorAction SilentlyContinue

# Start hidden
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "python"
$psi.Arguments = "`"$scriptPath`""
$psi.WorkingDirectory = $PSScriptRoot
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false

$process = [System.Diagnostics.Process]::Start($psi)
Write-Host "Telegram Bridge gestartet (PID: $($process.Id))"
Write-Host "Log: $logFile"
