Set WshShell = CreateObject("WScript.Shell")
WshShell.Environment("Process")("MS_CLIENT_ID") = "2fbe99b8-e739-4dfa-860f-bc8d2396700a"
WshShell.Environment("Process")("MS_TENANT_ID") = "common"
WshShell.CurrentDirectory = "C:\Users\Robin\Jarvis"
WshShell.Run "python C:\Users\Robin\Jarvis\scripts\telegram-bridge-watchdog.py", 0, False
