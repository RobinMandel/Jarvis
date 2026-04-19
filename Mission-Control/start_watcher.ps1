# Start restart_watcher.py in background
$watcherPath = "C:\Users\Robin\Jarvis\Mission-Control\restart_watcher.py"
$pythonExe = "C:\Users\Robin\AppData\Local\Programs\Python\Python311\python.exe"

Set-Location "C:\Users\Robin\Jarvis\Mission-Control"
Write-Host "[Watcher] Starting restart_watcher.py..."
& $pythonExe $watcherPath
