@echo off
rem Mission Control V3 — thin wrapper that delegates to watchdog.py.
rem All restart / lock / port-wait logic lives in watchdog.py (singleton via PID file).
title Mission Control V3 - Watchdog
cd /d "C:\Users\Robin\Jarvis\Mission-Control"
"C:\Users\Robin\AppData\Local\Programs\Python\Python311\python.exe" "C:\Users\Robin\Jarvis\Mission-Control\watchdog.py" >> "C:\Users\Robin\Jarvis\Mission-Control\server_restart.log" 2>&1
