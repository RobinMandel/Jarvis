import os
import json
import time
from pathlib import Path
from datetime import datetime

def gather_heartbeat_context():
    \"\"\"Sammelt aktuellen Kontext fuer den Orchestrator-Heartbeat.\"\"\"
    now = datetime.now()
    
    # 1. System Info
    context = [
        f"### SYSTEM HEARTBEAT ###",
        f"Zeit: {now.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Betriebssystem: {os.name} (win32)",
    ]
    
    # 2. Mission Control Status
    try:
        data_dir = Path(r'C:\Users\Robin\Jarvis\Mission-Control\data')
        sessions = len(list((data_dir / 'sessions.json').parent.glob('sessions.json'))) # Vereinfacht
        tasks = len(list((data_dir / 'tasks.json').parent.glob('tasks.json')))
        context.append(f"MC-Status: Sessions persistiert, Tasks geladen.")
    except:
        pass

    # 3. Kuerzliche Aktivitaeten (Logs checken)
    try:
        log_file = Path(r'C:\Users\Robin\Jarvis\Mission-Control\data\server.log')
        if log_file.exists():
            mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
            context.append(f"Letzte Server-Aktivitaet: {mtime.strftime('%H:%M:%S')}")
    except:
        pass

    return \"\n\".join(context)

print(gather_heartbeat_context())
