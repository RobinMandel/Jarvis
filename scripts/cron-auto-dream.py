#!/usr/bin/env python3
"""
Auto-Dream — Memory Consolidation
Laeuft taeglich um 03:00. Fasst den Tag zusammen und schreibt ins Obsidian Vault.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0

VAULT_MEMORY = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
CLAUDE_CLI = r"C:\Users\Robin\.local\bin\claude.exe"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HISTORY_FILE = DATA_DIR / "telegram-history.json"

import atexit as _atexit
DATA_DIR.mkdir(parents=True, exist_ok=True)
_log_fh = open(DATA_DIR / "cron-auto-dream.log", "a", encoding="utf-8", buffering=1)
_orig_stdout = sys.stdout
class _Tee:
    def write(self, s): _orig_stdout.write(s); _log_fh.write(s)
    def flush(self): _orig_stdout.flush(); _log_fh.flush()
    def __getattr__(self, n): return getattr(_orig_stdout, n)
sys.stdout = _Tee()
_atexit.register(_log_fh.close)
print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] cron-auto-dream START")


MC_SESSIONS_FILE = Path(__file__).resolve().parent.parent / "Mission-Control" / "data" / "sessions.json"
MC_NIGHT_RESULTS = Path(__file__).resolve().parent.parent / "data" / "night-results"


def get_today_sources():
    """Gather all information from today to consolidate."""
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    parts = []

    # 1. Mission Control chat sessions from today
    if MC_SESSIONS_FILE.exists():
        try:
            sessions = json.loads(MC_SESSIONS_FILE.read_text(encoding="utf-8"))
            session_summaries = []
            for sid, s in sessions.items():
                history = s.get("history", [])
                if not history:
                    continue
                # Only today's sessions: check last_message or last history entry
                last_msg = s.get("last_message", "")
                # Filter by checking if any timestamp matches today (rough heuristic: include all)
                user_msgs = [m["content"] for m in history if m.get("role") == "user"]
                asst_msgs = [m["content"] for m in history if m.get("role") == "assistant"]
                if not user_msgs:
                    continue
                title = s.get("custom_title") or s.get("auto_title") or sid[:8]
                topic = s.get("topic", "")
                summary = f"Session '{title}'"
                if topic:
                    summary += f" [{topic}]"
                summary += f": {len(user_msgs)} Nachrichten"
                # Include last user message as context
                last_user = user_msgs[-1][:200] if user_msgs else ""
                last_asst = asst_msgs[-1][:200] if asst_msgs else ""
                session_summaries.append(f"- {summary}\n  Robin: {last_user}\n  Jarvis: {last_asst}")
            if session_summaries:
                parts.append("## Mission Control Sessions (heute)")
                parts.extend(session_summaries[:8])  # max 8 sessions
        except Exception as e:
            print(f"MC sessions Fehler: {e}")

    # 2. Telegram history (all messages, no limit)
    if HISTORY_FILE.exists():
        try:
            history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            if history:
                lines = []
                for entry in history:
                    role = "Robin" if entry["role"] == "user" else "Jarvis"
                    ts = entry.get("ts", "")
                    lines.append(f"[{ts}] {role}: {entry['text'][:200]}")
                parts.append("\n## Telegram-Gespraeche")
                parts.extend(lines)
        except Exception:
            pass

    # 3. Night research results from today
    if MC_NIGHT_RESULTS.exists():
        for f in sorted(MC_NIGHT_RESULTS.glob(f"{today}-*.json")):
            try:
                content = json.loads(f.read_text(encoding="utf-8"))
                name = f.stem.replace(f"{today}-", "")
                takeaway = content.get("takeaway", content.get("tldr", ""))
                if takeaway:
                    parts.append(f"\n## Nacht-Ergebnis: {name}\n{takeaway}")
            except Exception:
                pass

    # 4. Heartbeat state
    state_file = DATA_DIR / "heartbeat-state.json"
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            parts.append(
                f"\n## System-Status\n"
                f"- Ungelesene Outlook: {state.get('unread_outlook', '?')}\n"
                f"- Ungelesene Uni: {state.get('unread_uni', '?')}\n"
                f"- Kommende Events: {state.get('upcoming_events', '?')}"
            )
        except Exception:
            pass

    # 5. Yesterday's note for continuity (brief)
    yesterday_file = VAULT_MEMORY / f"{yesterday}.md"
    if yesterday_file.exists():
        try:
            content = yesterday_file.read_text(encoding="utf-8").strip()
            if content:
                # Only the Zusammenfassung section
                lines = content.split("\n")
                summary_lines = []
                in_summary = False
                for line in lines:
                    if line.startswith("## Zusammenfassung"):
                        in_summary = True
                        continue
                    if in_summary and line.startswith("##"):
                        break
                    if in_summary and line.strip():
                        summary_lines.append(line)
                if summary_lines:
                    parts.append(f"\n## Gestern ({yesterday}) — Zusammenfassung\n" + "\n".join(summary_lines[:3]))
        except Exception:
            pass

    return "\n".join(parts)


def consolidate():
    today = datetime.now().strftime("%Y-%m-%d")
    output_file = VAULT_MEMORY / f"{today}.md"

    # Read existing note if present — merge, don't skip
    existing = ""
    if output_file.exists():
        existing = output_file.read_text(encoding="utf-8").strip()

    sources = get_today_sources()
    if not sources.strip():
        print("Keine Daten zum Konsolidieren.")
        return

    if existing:
        prompt = f"""Hier ist das bisherige Tageslog fuer {today}:

---BESTEHENDES LOG---
{existing[:3000]}
---ENDE---

Hier sind zusaetzliche Daten aus dem ganzen Tag (MC-Sessions, Telegram, Recherchen):

---NEUE DATEN---
{sources[:3000]}
---ENDE---

Erstelle ein finales, konsolidiertes Tageslog. Behalte was gut ist, ergaenze was fehlt, entferne Duplikate.
Format (Obsidian-kompatibel):
# {today} — Tageslog

## Zusammenfassung
(2-3 praegnante Saetze: Was war heute wichtig?)

## Aktivitaeten
(Chronologische Bullet Points mit Uhrzeiten falls bekannt)

## Erkenntnisse & Entscheidungen
(Was wurde gelernt, entschieden, geloest?)

## Offen / Naechste Schritte
(Was ist noch offen oder muss morgen angegangen werden?)

## Verknuepfungen
[[Thema1]] · [[Thema2]] · [[Thema3]]

#jarvis #memory #auto-dream

REGELN: Nur Fakten, kein Fuelltext. Deutsch. Wikilinks zu: Anki, Dissertation-ITI, Trading, Medizin, OSCE, Mission-Control-V3, Telegram-Bridge."""
    else:
        prompt = f"""Erstelle ein Tageslog fuer {today} aus diesen Daten:

{sources[:4000]}

Format (Obsidian-kompatibel):
# {today} — Tageslog

## Zusammenfassung
(2-3 praegnante Saetze)

## Aktivitaeten
(Chronologische Bullet Points)

## Erkenntnisse & Entscheidungen
(Was wurde gelernt/entschieden?)

## Offen / Naechste Schritte
(Was bleibt offen?)

## Verknuepfungen
[[Thema1]] · [[Thema2]]

#jarvis #memory #auto-dream

Nur Fakten, kein Fuelltext. Deutsch."""

    try:
        result = subprocess.run(
            [
                CLAUDE_CLI,
                "-p", prompt,
                "--output-format", "text",
                "--max-turns", "1",
                "--system-prompt", "Du bist Jarvis. Erstelle ein praegnantes Tageslog. Nur Fakten, keine Fuellwoerter.",
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
            print(f"Tageslog {'konsolidiert' if existing else 'erstellt'}: {output_file}")
        else:
            print(f"Claude Fehler: RC={result.returncode} | stderr={result.stderr[:200]!r}")

    except subprocess.TimeoutExpired:
        print("Claude CLI TIMEOUT (>120s)")
    except Exception as e:
        print(f"Fehler: {type(e).__name__}: {e}")


if __name__ == "__main__":
    consolidate()
