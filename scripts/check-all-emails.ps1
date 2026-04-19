# Check all email accounts (Outlook + Uni) for Heartbeat
# Returns urgent/important emails only

param(
    [switch]$Verbose = $false
)

$urgent = @()

# Keywords that make an email urgent
$urgentKeywords = @(
    'Prüfung', 'Deadline', 'Frist', 'Important', 'Urgent', 
    'Absage', 'Zusage', 'Termin', 'Erinnerung', 'Mahnung',
    'Klausur', 'OSCE', 'Praktikum'
)

function Test-Urgent {
    param([string]$Subject, [string]$From)
    
    foreach ($keyword in $urgentKeywords) {
        if ($Subject -match $keyword -or $From -match $keyword) {
            return $true
        }
    }
    return $false
}

# --- Check Outlook (Graph API) ---
Write-Host "📧 Checking Outlook (robinmandel@outlook.de)..." -ForegroundColor Cyan

try {
    $outlookOutput = python "$PSScriptRoot\outlook_graph.py" unread --top 50 2>&1

    foreach ($line in $outlookOutput) {
        if ($line -match "^- .+ \| (.+) \| (.+)$") {
            $from = $Matches[1].Trim()
            $subject = $Matches[2].Trim()
            if (Test-Urgent -Subject $subject -From $from) {
                $urgent += [PSCustomObject]@{
                    Account = "Outlook"
                    From = $from
                    Subject = $subject
                    Received = ""
                    Importance = "normal"
                }
            }
        }
    }

    if ($Verbose) {
        $unreadCount = ($outlookOutput | Where-Object { $_ -match "^- " }).Count
        Write-Host "  $unreadCount unread, $($urgent.Count) urgent" -ForegroundColor Gray
    }
}
catch {
    Write-Host "  ✗ Outlook check failed: $_" -ForegroundColor Red
}

# --- Check Uni (IMAP) ---
Write-Host "📧 Checking Uni (robin.mandel@uni-ulm.de)..." -ForegroundColor Cyan

try {
    # Quick IMAP check for unread count
    $credFile = "$PSScriptRoot\..\secrets\uni-mail-cred.json"
    
    if (Test-Path $credFile) {
        $credData = Get-Content $credFile | ConvertFrom-Json
        $password = $credData.password
        
        $tcpClient = New-Object System.Net.Sockets.TcpClient("imap.uni-ulm.de", 993)
        $sslStream = New-Object System.Net.Security.SslStream($tcpClient.GetStream(), $false)
        $sslStream.AuthenticateAsClient("imap.uni-ulm.de")
        
        $reader = New-Object System.IO.StreamReader($sslStream)
        $writer = New-Object System.IO.StreamWriter($sslStream)
        $writer.AutoFlush = $true
        
        $reader.ReadLine() | Out-Null  # greeting
        
        $writer.WriteLine("A001 LOGIN robin.mandel@uni-ulm.de $password")
        $reader.ReadLine() | Out-Null
        
        $writer.WriteLine("A002 SELECT INBOX")
        while ($true) {
            $line = $reader.ReadLine()
            if ($line -match "^A002 ") { break }
        }
        
        $writer.WriteLine("A003 SEARCH UNSEEN")
        $unreadIds = @()
        while ($true) {
            $line = $reader.ReadLine()
            if ($line -match "^\* SEARCH (.*)") {
                $unreadIds = $Matches[1] -split ' ' | Where-Object { $_ -match '^\d+$' }
            }
            if ($line -match "^A003 ") { break }
        }
        
        if ($unreadIds.Count -gt 0) {
            # Fetch subjects for unread messages
            foreach ($msgId in $unreadIds) {
                $writer.WriteLine("A004$msgId FETCH $msgId (BODY[HEADER.FIELDS (FROM SUBJECT DATE)])")
                
                $headers = @()
                while ($true) {
                    $line = $reader.ReadLine()
                    if ($line -match "^A004$msgId ") { break }
                    $headers += $line
                }
                
                $from = ($headers | Where-Object { $_ -match "^From: (.*)" } | ForEach-Object { $Matches[1] }) -join ""
                $subject = ($headers | Where-Object { $_ -match "^Subject: (.*)" } | ForEach-Object { $Matches[1] }) -join ""
                $date = ($headers | Where-Object { $_ -match "^Date: (.*)" } | ForEach-Object { $Matches[1] }) -join ""
                
                # Decode subject if needed
                if ($subject -match '=\?([^?]+)\?B\?([^?]+)\?=') {
                    try {
                        $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[2]))
                        $subject = $subject -replace '=\?[^?]+\?B\?[^?]+\?=', $decoded
                    } catch {}
                }
                
                if (Test-Urgent -Subject $subject -From $from) {
                    $urgent += [PSCustomObject]@{
                        Account = "Uni"
                        From = $from
                        Subject = $subject
                        Received = $date
                        Importance = "normal"
                    }
                }
            }
        }
        
        $writer.WriteLine("A999 LOGOUT")
        $tcpClient.Close()
        
        if ($Verbose) {
            Write-Host "  ✓ $($unreadIds.Count) unread" -ForegroundColor Gray
        }
    }
    else {
        Write-Host "  ⚠ No credentials found" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  ✗ Uni check failed: $_" -ForegroundColor Red
}

# --- Report ---
Write-Host ""

if ($urgent.Count -eq 0) {
    Write-Host "✓ No urgent emails" -ForegroundColor Green
}
else {
    Write-Host "🚨 $($urgent.Count) URGENT EMAIL(S):`n" -ForegroundColor Red
    
    foreach ($email in $urgent) {
        $icon = if ($email.Importance -eq "high") { "🚨" } else { "⚡" }
        Write-Host "  $icon [$($email.Account)] $($email.From)" -ForegroundColor Yellow
        Write-Host "    $($email.Subject)" -ForegroundColor White
        Write-Host "    $($email.Received)`n" -ForegroundColor Gray
    }
}

# Update state file
$stateFile = "$PSScriptRoot\..\data\email-check-state.json"
$state = @{
    lastChecks = @{
        outlook = [int][double]::Parse((Get-Date -UFormat %s))
        uni = [int][double]::Parse((Get-Date -UFormat %s))
    }
    lastAlerts = $urgent | ForEach-Object { "$($_.Account): $($_.Subject)" }
    notes = "Timestamps in Unix epoch (seconds). Last check: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

$state | ConvertTo-Json | Set-Content $stateFile

return $urgent
