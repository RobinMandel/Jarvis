#!/usr/bin/env python3
"""
Jarvis Heartbeat — Checks Email + Calendar, outputs a briefing.
Usage:
  python heartbeat.py              # Full briefing
  python heartbeat.py --quick      # Only urgent items
  python heartbeat.py --json       # JSON output (for Mission Control)
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SCRIPTS_DIR = Path(__file__).resolve().parent
SECRETS_DIR = SCRIPTS_DIR.parent / "secrets"
DATA_DIR = SCRIPTS_DIR.parent / "data"
STATE_FILE = DATA_DIR / "heartbeat-state.json"

# Quiet hours: no checks between 23:00 and 08:00
QUIET_START = 23
QUIET_END = 8
MIN_INTERVAL_SECONDS = 3600  # 1h between checks


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def is_quiet_hour():
    h = datetime.now().hour
    return h >= QUIET_START or h < QUIET_END


def should_skip(state):
    last = state.get("last_check_unix", 0)
    now = int(datetime.now(timezone.utc).timestamp())
    return (now - last) < MIN_INTERVAL_SECONDS


def check_outlook():
    """Check Outlook via Graph API."""
    try:
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "outlook_graph.py"), "unread", "--top", "20"],
            capture_output=True, text=True, timeout=15, encoding="utf-8", errors="replace", env=env
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip() or "Token expired?", "mails": []}

        mails = []
        for line in result.stdout.strip().split("\n"):
            if line.startswith("- "):
                parts = line[2:].split(" | ")
                if len(parts) >= 3:
                    mails.append({
                        "date": parts[0].strip(),
                        "from": parts[1].strip(),
                        "subject": parts[2].strip(),
                        "account": "Outlook"
                    })
        return {"mails": mails}
    except Exception as e:
        return {"error": str(e), "mails": []}


def check_uni_mail():
    """Check Uni Ulm via IMAP."""
    try:
        import imaplib
        import ssl
        cred_file = SECRETS_DIR / "uni-mail-cred.json"
        if not cred_file.exists():
            return {"error": "No credentials", "mails": []}

        creds = json.loads(cred_file.read_text(encoding="utf-8"))
        pw = creds["password"]
        user = "robin.mandel@uni-ulm.de"

        ctx = ssl.create_default_context()
        m = imaplib.IMAP4_SSL("imap.uni-ulm.de", 993, ssl_context=ctx)
        m.login(user, pw)
        m.select("INBOX")
        _, data = m.search(None, "UNSEEN")
        ids = data[0].split()

        mails = []
        for mid in ids[-10:]:  # last 10 unread
            _, msg_data = m.fetch(mid, "(BODY[HEADER.FIELDS (FROM SUBJECT DATE)])")
            raw = msg_data[0][1].decode("utf-8", errors="replace")
            mail = {"account": "Uni", "from": "", "subject": "", "date": ""}
            for line in raw.strip().split("\n"):
                line = line.strip()
                if line.lower().startswith("from:"):
                    mail["from"] = line[5:].strip()
                elif line.lower().startswith("subject:"):
                    mail["subject"] = line[8:].strip()
                elif line.lower().startswith("date:"):
                    mail["date"] = line[5:].strip()
            if mail["subject"] or mail["from"]:
                mails.append(mail)
        m.logout()
        return {"mails": mails}
    except Exception as e:
        return {"error": str(e), "mails": []}


def check_calendar():
    """Check iCloud calendar for upcoming events."""
    try:
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "icloud-calendar.py"), "list-events", "--days", "2", "--json"],
            capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace", env=env
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip(), "events": []}

        events = json.loads(result.stdout) if result.stdout.strip() else []
        return {"events": events}
    except Exception as e:
        return {"error": str(e), "events": []}


URGENT_KEYWORDS = [
    "pruefung", "prüfung", "deadline", "frist", "urgent", "important",
    "absage", "zusage", "termin", "erinnerung", "mahnung",
    "klausur", "osce", "praktikum", "dringend"
]


def is_urgent(text):
    lower = text.lower()
    return any(kw in lower for kw in URGENT_KEYWORDS)


def format_briefing(outlook, uni, calendar, quick=False):
    lines = []
    now_str = datetime.now().strftime("%d.%m.%Y %H:%M")
    lines.append(f"=== Jarvis Heartbeat | {now_str} ===\n")

    # Calendar
    events = calendar.get("events", [])
    if events:
        lines.append(f"KALENDER ({len(events)} Events naechste 48h):")
        for e in events:
            lines.append(f"  {e.get('start','')} | {e.get('summary','')} [{e.get('calendar','')}]")
        lines.append("")

    # Emails
    all_mails = outlook.get("mails", []) + uni.get("mails", [])
    urgent = [m for m in all_mails if is_urgent(m.get("subject", "") + m.get("from", ""))]

    if urgent:
        lines.append(f"DRINGEND ({len(urgent)} Mails):")
        for m in urgent:
            lines.append(f"  [{m['account']}] {m['from']} — {m['subject']}")
        lines.append("")

    if not quick:
        normal = [m for m in all_mails if m not in urgent]
        if normal:
            lines.append(f"UNGELESEN ({len(normal)} Mails):")
            for m in normal:
                lines.append(f"  [{m['account']}] {m['from']} — {m['subject']}")
            lines.append("")

    # Errors
    for name, data in [("Outlook", outlook), ("Uni", uni), ("Kalender", calendar)]:
        if "error" in data:
            lines.append(f"FEHLER {name}: {data['error']}")

    if not events and not all_mails and not any("error" in d for d in [outlook, uni, calendar]):
        lines.append("Alles ruhig. Keine ungelesenen Mails, keine Termine.")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Jarvis Heartbeat")
    parser.add_argument("--quick", action="store_true", help="Only urgent items")
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--force", action="store_true", help="Skip interval/quiet checks")
    args = parser.parse_args()

    state = load_state()

    if not args.force:
        if is_quiet_hour():
            if args.json:
                print(json.dumps({"skipped": "quiet_hours"}))
            return
        if should_skip(state):
            if args.json:
                print(json.dumps({"skipped": "too_recent"}))
            return

    # Run checks
    outlook = check_outlook()
    uni = check_uni_mail()
    calendar = check_calendar()

    # Update state
    state["last_check_unix"] = int(datetime.now(timezone.utc).timestamp())
    state["last_check_time"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    state["unread_outlook"] = len(outlook.get("mails", []))
    state["unread_uni"] = len(uni.get("mails", []))
    state["upcoming_events"] = len(calendar.get("events", []))
    save_state(state)

    if args.json:
        print(json.dumps({
            "outlook": outlook,
            "uni": uni,
            "calendar": calendar,
            "timestamp": state["last_check_time"]
        }, ensure_ascii=False, indent=2))
    else:
        print(format_briefing(outlook, uni, calendar, quick=args.quick))


if __name__ == "__main__":
    main()
