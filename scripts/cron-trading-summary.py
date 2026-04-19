#!/usr/bin/env python3
"""
Trading Evening Summary — Tages-Zusammenfassung der Maerkte
Laeuft Mo-Fr um 20:00.
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
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Telegram notification
BOT_TOKEN = "8484154438:AAFXvvnhK-7V6raOOXOa2qlkD0y3smVhM5A"
ROBIN_CHAT_ID = 8178215734


def send_telegram(text):
    import requests
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": ROBIN_CHAT_ID, "text": text},
            timeout=10
        )
    except Exception:
        pass


def trading_summary():
    today = datetime.now().strftime("%Y-%m-%d")
    weekday = datetime.now().weekday()

    if weekday >= 5:  # Sa/So
        print("Wochenende — kein Trading Summary.")
        return

    output_file = DATA_DIR / "night-results" / f"{today}-trading-summary.json"
    output_file.parent.mkdir(parents=True, exist_ok=True)

    if output_file.exists():
        print(f"Trading Summary fuer {today} existiert bereits.")
        return

    prompt = """Du bist Marcus, Robins Finanzanalyst.

Erstelle eine kurze Tages-Zusammenfassung der Maerkte. Suche mit web_search nach:
1. "S&P 500 DAX today market close"
2. "Bitcoin Ethereum crypto market today"
3. "major market news today"

Gib das Ergebnis als JSON:
{
  "date": "DATUM",
  "markets": {
    "SP500": "+/- X%",
    "DAX": "+/- X%",
    "BTC": "$PREIS (+/- X%)",
    "ETH": "$PREIS (+/- X%)"
  },
  "headlines": ["Top 3 Schlagzeilen"],
  "tldr": "1-2 Saetze Zusammenfassung"
}

Gib NUR das JSON aus."""

    try:
        result = subprocess.run(
            [
                CLAUDE_CLI,
                "-p", prompt,
                "--output-format", "text",
                "--max-turns", "5",
                "--no-session-persistence",
                "--disallowed-tools", "Edit", "Write", "Glob", "Agent",
            ],
            capture_output=True, text=True, timeout=90,
            encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            creationflags=_NO_WINDOW,
        )

        if result.returncode == 0 and result.stdout.strip():
            output_file.write_text(result.stdout.strip(), encoding="utf-8")
            print(f"Trading Summary geschrieben: {output_file}")

            # Send to Telegram
            try:
                data = json.loads(result.stdout.strip())
                msg = f"Trading Summary {today}\n\n"
                for k, v in data.get("markets", {}).items():
                    msg += f"{k}: {v}\n"
                msg += f"\n{data.get('tldr', '')}"
                send_telegram(msg)
            except json.JSONDecodeError:
                send_telegram(f"Trading Summary {today}:\n{result.stdout.strip()[:500]}")
        else:
            print(f"Claude Fehler: RC={result.returncode}")

    except Exception as e:
        print(f"Fehler: {e}")


if __name__ == "__main__":
    trading_summary()
