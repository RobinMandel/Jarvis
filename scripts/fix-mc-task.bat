@echo off
schtasks /delete /tn "Mission Control V3" /f
schtasks /create /tn "Mission Control V3" /tr "wscript.exe \"C:\Users\Robin\Jarvis\Mission-Control\start-hidden.vbs\"" /sc onlogon /rl HIGHEST /f
echo Done.
