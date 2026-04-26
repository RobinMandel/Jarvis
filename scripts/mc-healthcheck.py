#!/usr/bin/env python3
"""
Mission Control Healthcheck (Fix 4 — Belt-and-Suspenders).

Probes http://localhost:8090/ from a separate Scheduled Task. If MC is
unreachable across all retries, triggers a restart of the "Mission Control V3"
task and sends an ntfy push so Robin sees it on his phone.

Independent of watchdog.py — covers the failure mode where the watchdog itself
is dead (PID-file race, hard crash, etc.) and nothing supervises the supervisor.

Designed to be safe to run every 5 minutes:
  - Fast no-op when MC is healthy
  - Cooldown: never restart twice within COOLDOWN_S
  - Logs to mc-healthcheck.log next to this script
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8090
PROBE_URL = f"http://{HOST}:{PORT}/"
PROBE_TIMEOUT_S = 4
PROBE_RETRIES = 3
PROBE_RETRY_DELAY_S = 5
COOLDOWN_S = 10 * 60  # don't re-trigger restart within 10 min

SCRIPT_DIR = Path(__file__).resolve().parent
LOG_FILE = SCRIPT_DIR / "mc-healthcheck.log"
COOLDOWN_FILE = SCRIPT_DIR / ".mc-healthcheck-cooldown"

NTFY_TOPIC = "jarvis-3uQt7WT31rZskOY9"
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}"

TASK_NAME = "Mission Control V3"


def log(msg: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def probe_once() -> tuple[bool, str]:
    """Single probe — returns (ok, detail)."""
    # Cheap pre-check: TCP connect. Avoids a full HTTP request when port is dead.
    try:
        with socket.create_connection((HOST, PORT), timeout=PROBE_TIMEOUT_S):
            pass
    except Exception as e:
        return False, f"tcp:{e.__class__.__name__}: {e}"
    # Real HTTP probe — server may be listening but stuck.
    try:
        with urllib.request.urlopen(PROBE_URL, timeout=PROBE_TIMEOUT_S) as resp:
            code = resp.getcode()
            if 200 <= code < 500:
                return True, f"http:{code}"
            return False, f"http:{code}"
    except Exception as e:
        return False, f"http:{e.__class__.__name__}: {e}"


def is_in_cooldown() -> bool:
    if not COOLDOWN_FILE.exists():
        return False
    try:
        last = float(COOLDOWN_FILE.read_text().strip())
    except Exception:
        return False
    return (time.time() - last) < COOLDOWN_S


def mark_restart() -> None:
    try:
        COOLDOWN_FILE.write_text(str(time.time()))
    except Exception:
        pass


def trigger_restart() -> bool:
    """Run the MC scheduled task. Returns True on success."""
    try:
        result = subprocess.run(
            ["schtasks", "/Run", "/TN", TASK_NAME],
            capture_output=True, text=True, timeout=15,
        )
        ok = result.returncode == 0
        log(f"schtasks /Run rc={result.returncode} stdout={result.stdout.strip()!r} stderr={result.stderr.strip()!r}")
        return ok
    except Exception as e:
        log(f"schtasks /Run failed: {e}")
        return False


def push(title: str, message: str, priority: int = 4, tags: str = "warning,gear") -> None:
    try:
        req = urllib.request.Request(
            NTFY_URL,
            data=message.encode("utf-8"),
            headers={
                "Title": title.encode("utf-8").decode("latin-1", errors="replace"),
                "Priority": str(priority),
                "Tags": tags,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            log(f"ntfy push rc={r.getcode()}")
    except Exception as e:
        log(f"ntfy push failed: {e}")


def main() -> int:
    # Fast path: one probe. Most invocations end here.
    ok, detail = probe_once()
    if ok:
        # Quiet success — don't spam the log with every 5-min OK
        return 0

    log(f"probe failed: {detail} — entering retry loop")
    for i in range(2, PROBE_RETRIES + 1):
        time.sleep(PROBE_RETRY_DELAY_S)
        ok, detail = probe_once()
        log(f"  retry {i}: {'ok' if ok else detail}")
        if ok:
            return 0

    if is_in_cooldown():
        log("MC down but cooldown active — skipping restart")
        return 1

    log("MC unresponsive after retries — triggering restart")
    mark_restart()
    started = trigger_restart()
    push(
        title="MC Restart" if started else "MC Restart FAILED",
        message=(
            f"Mission Control war nicht erreichbar ({detail}). "
            f"Healthcheck hat {'Restart ausgelöst' if started else 'Restart-Trigger versucht, aber schtasks failte'}."
        ),
        priority=4 if started else 5,
        tags="warning,gear" if started else "rotating_light",
    )
    return 0 if started else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e!r}")
        sys.exit(3)
