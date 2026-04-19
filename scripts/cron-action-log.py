"""Cron-Wrapper: regeneriert Action-Log im Obsidian Vault.

Ruft Mission-Control/build-action-log.py auf. Laeuft guenstig (liest nur JSONL
und schreibt Markdown) — kann alle 5 Minuten triggern.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

BUILDER = Path(r"C:/Users/Robin/Jarvis/Mission-Control/build-action-log.py")


def main() -> int:
    if not BUILDER.exists():
        print(f"FEHLT: {BUILDER}", file=sys.stderr)
        return 1
    result = subprocess.run(
        [sys.executable, str(BUILDER)],
        cwd=str(BUILDER.parent),
        capture_output=True,
        text=True,
    )
    sys.stdout.write(result.stdout)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
