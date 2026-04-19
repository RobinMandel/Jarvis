@echo off
title Mission Control V3 - Watchdog
cd /d "C:\Users\Robin\Jarvis\Mission-Control"

set PORT=8090
set PYTHON="C:\Users\Robin\AppData\Local\Programs\Python\Python311\python.exe"

:loop
if exist "%~dp0data\stop.flag" (
    del "%~dp0data\stop.flag" >nul 2>&1
    echo [%date% %time%] stop.flag detected - exiting loop >> server_restart.log
    exit /b 0
)
echo [%date% %time%] Checking port %PORT%... >> server_restart.log

rem --- Kill any stale process bound to our port to avoid OSError 10048 crash-loop ---
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo [%date% %time%] Port %PORT% still bound by PID %%P - killing stale process >> server_restart.log
    taskkill /F /PID %%P >nul 2>&1
)

rem --- Wait for Windows TIME_WAIT to release the socket ---
:wait_port
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
    echo [%date% %time%] Port still busy, waiting 3s... >> server_restart.log
    timeout /t 3 /nobreak >nul
    goto wait_port
)

echo [%date% %time%] Starting Mission Control V3... >> server_restart.log
%PYTHON% server.py >> mc_stdout.log 2>> mc_stderr.log
set EXITCODE=%errorlevel%
echo [%date% %time%] Server stopped (exit %EXITCODE%), restarting in 15s... >> server_restart.log

rem --- 15s backoff gives TIME_WAIT sockets time to clear ---
timeout /t 15 /nobreak >nul
goto loop
