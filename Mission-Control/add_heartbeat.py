import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\server.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Heartbeat Logic Definition
heartbeat_logic = r'''
# ============================================================================
# HEARTBEAT & ORCHESTRATOR LOGIC (OpenClaw-Style)
# ============================================================================

_HEARTBEAT_INTERVAL = 600  # 10 Minuten
_heartbeat_task = None

async def _gather_environment_context():
    """Sammelt aktuellen System- und Umweltkontext für den Orchestrator."""
    now = datetime.now()
    ctx = [
        f"### AUTONOMER HEARTBEAT - {now.strftime('%Y-%m-%d %H:%M:%S')} ###",
        f"Context: win32, Jarvis Mission Control V3",
        f"Status: {len(sessions.sessions)} aktive Sessions, {len(list(DATA_DIR.glob('tasks.json')))} Task-Dateien.",
    ]
    
    # Minecraft-Status-Check (Beispielhaft)
    try:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(('127.0.0.1', 25565)) == 0:
                ctx.append("Minecraft Server: Online (Port 25565)")
            else:
                ctx.append("Minecraft Server: Offline")
    except:
        pass
        
    return "\n".join(ctx)

async def _run_heartbeat_pulse():
    """Führt einen einzelnen autonomen Heartbeat-Turn aus."""
    print(f"[Heartbeat] Puls startet...", flush=True)
    
    # Orchestrator-Session finden oder erstellen
    oid = "orchestrator"
    session = sessions.get_or_create(oid)
    session.provider = "openclaw"
    session.model = "" # OpenClaw Default
    
    env_ctx = await _gather_environment_context()
    prompt = (
        f"{env_ctx}\n\n"
        "Du bist der autonome Orchestrator von Jarvis. Dies ist ein Heartbeat-Turn. "
        "Prüfe den Status und entscheide, ob Aktionen (z.B. Notifications via send_push, "
        "Skill-Aktivierungen via skill_activate) notwendig sind. "
        "Wenn alles okay ist und keine Aktion erforderlich ist, antworte nur mit 'OK'. "
        "Antworte kurz und präzise."
    )
    
    # Wir rufen den LLM-Client direkt auf (Headless)
    try:
        from llm_client import invoke_llm, Message, TextDelta
        full_response = ""
        async for ev in invoke_llm(
            provider=session.provider,
            model=session.model,
            messages=[Message(role="user", content=prompt)],
            system="Du bist Jarvis Orchestrator. Handle autonom basierend auf dem System-Status.",
        ):
            if isinstance(ev, TextDelta):
                full_response += ev.text
        
        # Ergebnis in der Session loggen (für UI Sichtbarkeit)
        session.history.append({"role": "user", "content": f"[System Heartbeat at {datetime.now().strftime('%H:%M')}]"})
        session.history.append({"role": "assistant", "content": full_response.strip()})
        session.message_count += 2
        sessions.persist()
        
        print(f"[Heartbeat] Antwort: {full_response[:50].strip()}...", flush=True)
        
    except Exception as e:
        print(f"[Heartbeat] Fehler: {e}", flush=True)

async def _heartbeat_loop():
    """Endlosschleife für den autonomen Puls."""
    await asyncio.sleep(120)  # 2 Minuten warten nach Boot
    while True:
        try:
            await _run_heartbeat_pulse()
            await asyncio.sleep(_HEARTBEAT_INTERVAL)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Heartbeat] Loop Error: {e}", flush=True)
            await asyncio.sleep(60)

async def _start_heartbeat(app):
    nonlocal _heartbeat_task
    _heartbeat_task = asyncio.create_task(_heartbeat_loop())
    print(f"[Heartbeat] Autonomer Puls gestartet (Intervall: {_HEARTBEAT_INTERVAL}s)")

async def _stop_heartbeat(app):
    nonlocal _heartbeat_task
    if _heartbeat_task:
        _heartbeat_task.cancel()
        try:
            await _heartbeat_task
        except asyncio.CancelledError:
            pass
'''

# 2. Integration into create_app() cleanup/startup
if 'app.on_startup.append(_start_periodic_classify)' in content:
    content = content.replace(
        'app.on_startup.append(_start_periodic_classify)',
        'app.on_startup.append(_start_periodic_classify)\n    app.on_startup.append(_start_heartbeat)'
    )
if 'app.on_cleanup.append(_stop_periodic_classify)' in content:
    content = content.replace(
        'app.on_cleanup.append(_stop_periodic_classify)',
        'app.on_cleanup.append(_stop_periodic_classify)\n    app.on_cleanup.append(_stop_heartbeat)'
    )

# 3. Add the logic definition before create_app()
if 'def create_app():' in content:
    content = content.replace('def create_app():', heartbeat_logic + '\n\ndef create_app():')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Heartbeat logic integrated successfully")
