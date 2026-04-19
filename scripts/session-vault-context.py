#!/usr/bin/env python3
"""
SessionStart-Hook: Laedt kurzen Vault-Kontext in jede neue Claude-Session.
Gibt die letzten 2 Tageslogs und den Knowledge-INDEX als system-reminder aus.
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

VAULT_MEMORY = Path(r"C:\Users\Robin\.openclaw\workspace-clean\memory")
VAULT_KNOWLEDGE = Path(r"E:\OneDrive\AI\Obsidian-Vault\Jarvis-Brain\Jarvis-Knowledge")


def read_daily_notes(n=2):
    """Read the last n daily notes from vault."""
    today = datetime.now()
    results = []
    for offset in range(10):  # search up to 10 days back
        date = today - timedelta(days=offset)
        f = VAULT_MEMORY / f"{date.strftime('%Y-%m-%d')}.md"
        if f.exists():
            try:
                content = f.read_text(encoding="utf-8").strip()
                if content:
                    results.append((date.strftime('%Y-%m-%d'), content[:1200]))
            except Exception:
                pass
        if len(results) >= n:
            break
    return results


def read_index():
    """Read knowledge index if available."""
    idx = VAULT_KNOWLEDGE / "INDEX.md"
    if idx.exists():
        try:
            return idx.read_text(encoding="utf-8").strip()[:600]
        except Exception:
            pass
    return ""


def main():
    notes = read_daily_notes(2)
    index = read_index()

    if not notes and not index:
        return  # nothing to output

    parts = ["[Jarvis Vault Context]"]

    for date, content in notes:
        parts.append(f"\n--- Daily Note {date} ---\n{content}")

    if index:
        parts.append(f"\n--- Knowledge Index ---\n{index}")

    print("\n".join(parts))


if __name__ == "__main__":
    main()
