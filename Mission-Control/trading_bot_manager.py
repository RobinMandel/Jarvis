"""Trading-Bot Manager.

Registry + Prozess-Control fuer Trading-Bots. Persistierung in
data/trading-bots.json. Laufende Prozesse werden in einem Modul-Level-Dict
gehalten (ueberleben keinen MC-Neustart; tote PIDs werden beim Laden bereinigt).
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

# Pfade
MC_DIR = Path(__file__).parent
JARVIS_ROOT = MC_DIR.parent
RUNNER = JARVIS_ROOT / "trading-bots" / "runner.py"
STATE_DIR = JARVIS_ROOT / "trading-bots" / "state"
STATE_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_DIR = JARVIS_ROOT / "trading-bots" / "configs"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
REGISTRY = MC_DIR / "data" / "trading-bots.json"

# In-Memory Handles: bot_id -> Popen
_procs: dict[str, subprocess.Popen] = {}

# Windows-spezifische Subprocess-Flags
if sys.platform == "win32":
    _SPAWN_FLAGS = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    _STOP_SIGNAL = signal.CTRL_BREAK_EVENT
else:
    _SPAWN_FLAGS = {}
    _STOP_SIGNAL = signal.SIGTERM


def _load() -> list[dict]:
    if not REGISTRY.exists():
        return []
    try:
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(bots: list[dict]) -> None:
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps(bots, indent=2), encoding="utf-8")


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        if sys.platform == "win32":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True, text=True, timeout=3,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return str(pid) in out.stdout
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _read_state(bot_id: str) -> dict:
    path = STATE_DIR / f"{bot_id}.state.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _enrich(bot: dict) -> dict:
    """Fuege Laufzeit-Infos (Status aus State-File + PID-Check) hinzu."""
    state = _read_state(bot["id"])
    pid = bot.get("pid")
    alive = _pid_alive(pid)
    # Wenn Prozess tot aber Status != stopped -> korrigieren
    status = state.get("status") or bot.get("status") or "stopped"
    if not alive and status == "running":
        status = "crashed"
    return {
        **bot,
        "status": status,
        "alive": alive,
        "tick_count": state.get("tick_count", 0),
        "last_tick": state.get("last_tick"),
        "last_result": state.get("last_result"),
        "error": state.get("error"),
    }


def list_bots() -> list[dict]:
    return [_enrich(b) for b in _load()]


def get_bot(bot_id: str) -> dict | None:
    for b in _load():
        if b["id"] == bot_id:
            return _enrich(b)
    return None


def create_bot(name: str, strategy: str = "demo", params: dict | None = None,
               interval_sec: int = 60) -> dict:
    bots = _load()
    bot_id = uuid.uuid4().hex[:12]
    bot = {
        "id": bot_id,
        "name": name or f"Bot-{bot_id[:6]}",
        "strategy": strategy,
        "params": params or {},
        "interval_sec": int(interval_sec),
        "status": "stopped",
        "pid": None,
        "created_at": datetime.now().isoformat(),
        "last_started": None,
        "last_stopped": None,
    }
    bots.append(bot)
    _save(bots)
    # Config-JSON fuer den Runner
    _write_config(bot)
    return _enrich(bot)


def delete_bot(bot_id: str) -> bool:
    bots = _load()
    for i, b in enumerate(bots):
        if b["id"] == bot_id:
            # Laufenden Prozess killen
            if b.get("status") == "running":
                stop_bot(bot_id)
            bots.pop(i)
            _save(bots)
            # State- und Config-Dateien aufraeumen
            for p in (STATE_DIR / f"{bot_id}.state.json", CONFIG_DIR / f"{bot_id}.json"):
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass
            _procs.pop(bot_id, None)
            return True
    return False


def _write_config(bot: dict) -> Path:
    cfg_path = CONFIG_DIR / f"{bot['id']}.json"
    cfg_path.write_text(json.dumps({
        "strategy": bot["strategy"],
        "params": bot.get("params", {}),
        "interval_sec": bot.get("interval_sec", 60),
    }, indent=2), encoding="utf-8")
    return cfg_path


def start_bot(bot_id: str) -> dict:
    bots = _load()
    bot = next((b for b in bots if b["id"] == bot_id), None)
    if not bot:
        raise KeyError(bot_id)
    # Wenn bereits laufend -> nichts tun
    if _pid_alive(bot.get("pid")):
        return {"ok": True, "already_running": True, "pid": bot["pid"]}

    if not RUNNER.exists():
        raise FileNotFoundError(f"Runner missing: {RUNNER}")

    cfg_path = _write_config(bot)
    log_path = STATE_DIR / f"{bot_id}.log"
    # Append-Mode, damit Restart-Logs erhalten bleiben
    log_f = open(log_path, "a", encoding="utf-8", buffering=1)
    log_f.write(f"\n--- start {datetime.now().isoformat()} ---\n")
    log_f.flush()

    proc = subprocess.Popen(
        [sys.executable, str(RUNNER), "--id", bot_id, "--config", str(cfg_path)],
        stdout=log_f, stderr=subprocess.STDOUT,
        cwd=str(RUNNER.parent),
        **_SPAWN_FLAGS,
    )
    _procs[bot_id] = proc
    bot["pid"] = proc.pid
    bot["status"] = "running"
    bot["last_started"] = datetime.now().isoformat()
    _save(bots)
    return {"ok": True, "pid": proc.pid}


def stop_bot(bot_id: str, timeout: float = 5.0) -> dict:
    bots = _load()
    bot = next((b for b in bots if b["id"] == bot_id), None)
    if not bot:
        raise KeyError(bot_id)

    proc = _procs.get(bot_id)
    pid = bot.get("pid")
    killed = False

    if proc and proc.poll() is None:
        try:
            if sys.platform == "win32":
                proc.send_signal(_STOP_SIGNAL)
            else:
                proc.terminate()
            proc.wait(timeout=timeout)
        except Exception:
            proc.kill()
            killed = True
    elif pid and _pid_alive(pid):
        # Verwaister PID (nach MC-Neustart): hart killen
        try:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/F"],
                    capture_output=True, timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                os.kill(pid, signal.SIGTERM)
            killed = True
        except Exception:
            pass

    _procs.pop(bot_id, None)
    bot["status"] = "stopped"
    bot["pid"] = None
    bot["last_stopped"] = datetime.now().isoformat()
    _save(bots)
    return {"ok": True, "force_killed": killed}


def restart_bot(bot_id: str) -> dict:
    stop_result = stop_bot(bot_id)
    start_result = start_bot(bot_id)
    return {"ok": True, "stop": stop_result, "start": start_result}


def update_bot(bot_id: str, updates: dict[str, Any]) -> dict | None:
    bots = _load()
    bot = next((b for b in bots if b["id"] == bot_id), None)
    if not bot:
        return None
    for k in ("name", "strategy", "params", "interval_sec"):
        if k in updates:
            bot[k] = updates[k]
    _save(bots)
    _write_config(bot)
    return _enrich(bot)
