$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "C:\Users\Robin\Jarvis\Mission-Control\start-hidden.vbs"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable:$false
Register-ScheduledTask -TaskName "Mission Control V3" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
Write-Host "Task 'Mission Control V3' erstellt."
