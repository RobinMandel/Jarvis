#!/usr/bin/env python3
"""
Memory Sync — Laeuft jede Stunde.
Sammelt alles was heute passiert ist und schreibt/updated das Tageslog im Obsidian Vault.
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0

CLAUDE_CLI = r"C:\Users\Robin\.local\bin\claude.exe"
VAULT_MEMORY = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HISTORY_FILE = DATA_DIR / "telegram-history.json"
HEARTBEAT_STATE = DATA_DIR / "heartbeat-state.json"
SYNC_STATE = DATA_DIR / "memory-sync-state.json"

# File logging: write to data/cron-memory-sync.log so we can diagnose scheduled-task runs
import atexit as _atexit
DATA_DIR.mkdir(parents=True, exist_ok=True)
_log_fh = open(DATA_DIR / "cron-memory-sync.log", "a", encoding="utf-8", buffering=1)
_orig_stdout = sys.stdout
class _Tee:
    def write(self, s): _orig_stdout.write(s); _log_fh.write(s)
    def flush(self): _orig_stdout.flush(); _log_fh.flush()
    def __getattr__(self, n): return getattr(_orig_stdout, n)
sys.stdout = _Tee()
_atexit.register(_log_fh.close)
print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] cron-memory-sync START")


def load_sync_state():
    if SYNC_STATE.exists():
        try:
            return json.loads(SYNC_STATE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_sync_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SYNC_STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def gather_today_data():
    """Collect all data sources from today."""
    today = datetime.now().strftime("%Y-%m-%d")
    sections = []

    # 1. Telegram conversations
    if HISTORY_FILE.exists():
        try:
            history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            if history:
                lines = []
                for entry in history[-20:]:  # last 20 entries
                    role = "Robin" if entry["role"] == "user" else "Jarvis"
                    ts = entry.get("ts", "")
                    lines.append(f"[{ts}] {role}: {entry['text'][:150]}")
                if lines:
                    sections.append("## Telegram-Gespraeche\n" + "\n".join(lines))
        except Exception:
            pass

    # 2. Heartbeat state
    if HEARTBEAT_STATE.exists():
        try:
            state = json.loads(HEARTBEAT_STATE.read_text(encoding="utf-8"))
            sections.append(
                f"## System-Status\n"
                f"- Ungelesene Outlook: {state.get('unread_outlook', '?')}\n"
                f"- Ungelesene Uni: {state.get('unread_uni', '?')}\n"
                f"- Kommende Events: {state.get('upcoming_events', '?')}\n"
                f"- Letzter Check: {state.get('last_check_time', '?')}"
            )
        except Exception:
            pass

    # 3. Night research results from today
    night_results = DATA_DIR / "night-results"
    if night_results.exists():
        for f in night_results.glob(f"{today}-*.json"):
            try:
                content = json.loads(f.read_text(encoding="utf-8"))
                name = f.stem.replace(f"{today}-", "")
                if isinstance(content, dict):
                    summary = content.get("takeaway", content.get("tldr", str(content)[:200]))
                    sections.append(f"## Nacht-Ergebnis: {name}\n{summary}")
            except Exception:
                pass

    # 4. Claude Code session transcripts from today (all Jarvis-related projects)
    projects_base = Path(os.path.expanduser("~/.claude/projects"))
    total_today = 0
    if projects_base.exists():
        for proj_dir in projects_base.iterdir():
            if not proj_dir.is_dir():
                continue
            for f in proj_dir.glob("*.jsonl"):
                try:
                    mtime = datetime.fromtimestamp(f.stat().st_mtime)
                    if mtime.strftime("%Y-%m-%d") == today:
                        total_today += 1
                except Exception:
                    pass
    if total_today:
        sections.append(f"## Claude Code Sessions\n- {total_today} Session(s) heute aktiv")

    return "\n\n".join(sections)


def sync_memory():
    today = datetime.now().strftime("%Y-%m-%d")
    now_str = datetime.now().strftime("%H:%M")
    output_file = VAULT_MEMORY / f"{today}.md"

    # Gather data
    data = gather_today_data()
    if not data.strip():
        print(f"[{now_str}] Keine neuen Daten zum Syncen.")
        return

    # Check if data changed since last sync
    state = load_sync_state()
    data_hash = str(hash(data))
    if state.get("last_hash") == data_hash and state.get("last_date") == today:
        print(f"[{now_str}] Keine Aenderungen seit letztem Sync.")
        return

    # If tageslog already exists and is substantial, append rather than overwrite
    existing = ""
    if output_file.exists():
        existing = output_file.read_text(encoding="utf-8").strip()

    if existing and len(existing) > 100:
        # Update: ask Claude to merge existing + new data
        prompt = f"""Hier ist das bestehende Tageslog fuer {today}:

---BESTEHEND---
{existing[:2000]}
---ENDE BESTEHEND---

Hier sind neue Daten die seit dem letzten Update dazukamen:

---NEU---
{data[:2000]}
---ENDE NEU---

Aktualisiere das Tageslog. Behalte bestehende Eintraege bei, fuege neue hinzu.
Format: Markdown mit # {today} als Titel, ## Abschnitte.
Kurz und praegnant, nur relevante Infos. Deutsch.
Gib NUR das aktualisierte Tageslog aus, keinen anderen Text."""
    else:
        # Create new
        prompt = f"""Erstelle ein Tageslog fuer {today} basierend auf diesen Daten:

{data[:3000]}

Format:
# {today} — Tageslog

## Zusammenfassung
(2-3 Saetze)

## Aktivitaeten
(Was passiert ist)

## Notizen
(Relevantes fuer spaeter)

Kurz und praegnant. Deutsch. Gib NUR das Tageslog aus."""

    try:
        result = subprocess.run(
            [
                CLAUDE_CLI,
                "-p", prompt,
                "--output-format", "text",
                "--max-turns", "1",
                "--system-prompt", "Du bist Jarvis. Schreibe ein praegnantes Tageslog. Nur Fakten. Am Ende IMMER einen Abschnitt '## Verknuepfungen' mit [[Wikilinks]] (z.B. [[Anki]], [[Dissertation-ITI]], [[Trading]], [[Medizin]], [[OSCE]]) und danach Tags mit # (z.B. #jarvis #memory #auto-dream).",
                "--no-session-persistence",
                "--disallowed-tools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Agent",
            ],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            creationflags=_NO_WINDOW,
        )

        if result.returncode == 0 and result.stdout.strip():
            output_file.write_text(result.stdout.strip(), encoding="utf-8")
            print(f"[{now_str}] Tageslog aktualisiert: {output_file}")

            # Update sync state
            state["last_hash"] = data_hash
            state["last_date"] = today
            state["last_sync"] = now_str
            save_sync_state(state)
        else:
            print(f"[{now_str}] Claude Fehler: RC={result.returncode} | stdout={result.stdout[:100]!r} | stderr={result.stderr[:200]!r}")

    except subprocess.TimeoutExpired:
        print(f"[{now_str}] Claude CLI TIMEOUT (>120s) — Claude zu langsam oder haengt")
    except Exception as e:
        print(f"[{now_str}] Fehler: {type(e).__name__}: {e}")


if __name__ == "__main__":
    sync_memory()
