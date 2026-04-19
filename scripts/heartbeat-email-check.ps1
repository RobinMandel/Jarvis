# Heartbeat Email Check — State-based, max 1x alle 2h
$STATE_FILE = "$PSScriptRoot\..\memory\heartbeat-state.json"
$MIN_INTERVAL_SECONDS = 7200  # 2h

# Quiet-Time: 23:00-08:00
$hour = (Get-Date).Hour
if ($hour -ge 23 -or $hour -lt 8) { exit 0 }

# State laden
$lastCheckUnix = 0
if (Test-Path $STATE_FILE) {
    try {
        $state = Get-Content $STATE_FILE -Raw | ConvertFrom-Json
        if ($state.lastEmailCheckUnix) { $lastCheckUnix = [long]$state.lastEmailCheckUnix }
    } catch {}
}

# Zeit seit letztem Check
$nowUnix = [long](Get-Date -UFormat %s)
$secondsSince = $nowUnix - $lastCheckUnix

if ($secondsSince -lt $MIN_INTERVAL_SECONDS) {
    exit 0  # Zu früh — kein Check
}

# Check durchführen
$result = & "$PSScriptRoot\check-all-emails.ps1" 2>&1 | Out-String

# State updaten
$newState = @{ lastEmailCheckUnix = $nowUnix }
$newState | ConvertTo-Json | Set-Content $STATE_FILE -Encoding UTF8

# Nur Output wenn Urgent
if ($result -match "URGENT|🚨|Deadline|Frist|Klausur|OSCE|Absage|Zusage|Erinnerung|Important") {
    Write-Output $result
}
