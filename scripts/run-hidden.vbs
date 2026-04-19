' Hidden launcher for Jarvis cron scripts
' Usage: wscript.exe run-hidden.vbs <script.py>
' Uses python.exe (not pythonw) so subprocesses (Claude CLI) get proper stdio.
' Redirects stdout+stderr to data/<scriptname>.log via cmd /c.
If WScript.Arguments.Count = 0 Then WScript.Quit

Dim shell, pythonExe, scriptPath, scriptStem, logPath
Set shell = CreateObject("WScript.Shell")
pythonExe = "C:\Users\Robin\AppData\Local\Programs\Python\Python311\python.exe"
scriptPath = WScript.Arguments(0)

' Derive log filename from script path
scriptStem = Mid(scriptPath, InStrRev(scriptPath, "\") + 1)
If Right(scriptStem, 3) = ".py" Then scriptStem = Left(scriptStem, Len(scriptStem) - 3)
logPath = "C:\Users\Robin\Jarvis\data\" & scriptStem & ".log"

' Run hidden, wait for completion so scheduled task gets correct exit code
' Logging is handled inside each Python script via file Tee
shell.Run """" & pythonExe & """ """ & scriptPath & """", 0, True
