Start-Sleep -Seconds 15
# Kill only the bridge python processes started > 5 min ago (keep watchdog-fresh ones)
Get-Process python,pythonw -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*Python311*" -and $_.StartTime -lt (Get-Date).AddMinutes(-1)
} | ForEach-Object {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($cmd -match "telegram-bridge\.py" -and $cmd -notmatch "watchdog") {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}
Remove-Item "C:\Users\Robin\Jarvis\data\telegram-bridge.lock" -ErrorAction SilentlyContinue
