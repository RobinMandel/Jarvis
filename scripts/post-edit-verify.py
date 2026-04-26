#!/usr/bin/env python3
"""
PostToolUse-Hook: Auto-Verifikation nach Edit/Write/MultiEdit.

Catched Syntax-Bugs SOFORT statt erst beim naechsten Run. Hauptmotivation:
am 2026-04-26 hat ein parallel arbeitendes Modell `telegram-bridge-watchdog.py`
mit doppelt-escapeden Quotes + UTF-8-Mojibake ueberschrieben — die Datei
kompilierte nicht mehr, waere beim naechsten Watchdog-Spawn als SyntaxError
gestorben. Mit diesem Hook fliegt der Fehler sofort auf, bevor der naechste
Edit-Cycle ihn ueberschreibt.

Verifizierungen (per Datei-Endung):
  .py            -> python -m py_compile
  .json          -> json.load
  .yml/.yaml     -> yaml.safe_load (wenn pyyaml verfuegbar)

Kein-Block-Verhalten: Hook gibt JSON `{decision:"block", reason:...}` aus,
wenn die Verifikation fehlschlaegt. Im PostToolUse-Hook bedeutet `block`
einen Reminder an Claude statt eines harten Fehlers — er kann den Fehler
sehen und korrigieren.

Stille-Pfade: bei jedem Fehler-Pfad EXIT 0 ohne Output, damit Edits an
nicht-prueffaehigen Files (Markdown, Code in fremden Sprachen) durchgehen.
"""
from __future__ import annotations

import json
import sys
import subprocess
from pathlib import Path


VERIFIABLE = {".py", ".json", ".yml", ".yaml"}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = payload.get("tool_input") or {}
    tool_response = payload.get("tool_response") or {}
    # file_path kommt aus tool_input bei Edit/Write, oder aus tool_response.filePath
    file_path = (
        tool_input.get("file_path")
        or tool_response.get("filePath")
        or ""
    )
    if not file_path:
        sys.exit(0)

    p = Path(file_path)
    ext = p.suffix.lower()
    if ext not in VERIFIABLE:
        sys.exit(0)
    if not p.exists():
        sys.exit(0)

    error_msg = ""

    if ext == ".py":
        try:
            result = subprocess.run(
                [sys.executable, "-m", "py_compile", str(p)],
                capture_output=True, text=True, timeout=8,
                encoding="utf-8", errors="replace",
            )
            if result.returncode != 0:
                error_msg = (
                    f"Python-Syntax-Fehler in {p.name}:\n"
                    f"{(result.stderr or result.stdout)[:1500]}"
                )
        except Exception as e:
            error_msg = f"py_compile Aufruf fehlgeschlagen: {e}"

    elif ext == ".json":
        try:
            with open(p, encoding="utf-8") as f:
                json.load(f)
        except json.JSONDecodeError as e:
            error_msg = f"JSON-Syntax-Fehler in {p.name}: Zeile {e.lineno}, Spalte {e.colno}: {e.msg}"
        except Exception as e:
            error_msg = f"JSON-Parse-Fehler in {p.name}: {e}"

    elif ext in (".yml", ".yaml"):
        try:
            import yaml
        except ImportError:
            sys.exit(0)  # pyyaml nicht da — leise weiter
        try:
            with open(p, encoding="utf-8") as f:
                yaml.safe_load(f)
        except yaml.YAMLError as e:
            error_msg = f"YAML-Syntax-Fehler in {p.name}: {e}"
        except Exception:
            sys.exit(0)

    if error_msg:
        # decision="block" + reason → wird Claude als system-reminder gezeigt
        # damit er den Fehler sieht und korrigieren kann.
        print(json.dumps({
            "decision": "block",
            "reason": (
                f"Auto-Verify fand einen Fehler nach dem Edit: {error_msg}\n\n"
                "Bitte direkt korrigieren bevor du weitermachst — sonst landet "
                "die kaputte Datei am Ende der Session und reisst beim naechsten "
                "Lauf etwas mit (heute morgen: Mojibake-Vorfall in telegram-bridge-watchdog.py)."
            ),
        }))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Hook-Skript darf nie die Session killen — bei jedem unerwarteten Fehler
        # leise durchwinken.
        sys.exit(0)
