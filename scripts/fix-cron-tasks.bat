@echo off
set PYTHON="C:\Users\Robin\AppData\Local\Programs\Python\Python311\python.exe"
set SCRIPTS=C:\Users\Robin\Jarvis\scripts

schtasks /create /tn "Jarvis Auto-Dream" /tr "%PYTHON% %SCRIPTS%\cron-auto-dream.py" /sc daily /st 03:00 /rl HIGHEST /f
schtasks /create /tn "Jarvis Diss-Recherche" /tr "%PYTHON% %SCRIPTS%\cron-diss-recherche.py" /sc daily /st 02:00 /rl HIGHEST /f
schtasks /create /tn "Jarvis Memory Sync" /tr "%PYTHON% %SCRIPTS%\cron-memory-sync.py" /sc hourly /mo 1 /st 00:00 /rl HIGHEST /f
schtasks /create /tn "Jarvis Trading Summary" /tr "%PYTHON% %SCRIPTS%\cron-trading-summary.py" /sc daily /st 20:00 /rl HIGHEST /f

echo Done.
