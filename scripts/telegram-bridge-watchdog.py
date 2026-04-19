"""Watchdog for telegram-bridge.py — restarts it if it crashes."""
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

BRIDGE = Path(__file__).resolve().parent / "telegram-bridge.py"
LOG = Path(__file__).resolve().parent.parent / "data" / "telegram-bridge.log"
PYTHON = sys.executable
MAX_RAPID_CRASHES = 5
RAPID_WINDOW = 60  # seconds


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} [WATCHDOG] {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def main():
    log("Starting watchdog")
    crash_times = []

    while True:
        log(f"Launching telegram-bridge.py (pid will follow)")
        proc = subprocess.Popen(
            [PYTHON, str(BRIDGE)],
            stdin=subprocess.DEVNULL,
            cwd=str(BRIDGE.parent.parent),
        )
        log(f"Bridge started with PID {proc.pid}")

        exit_code = proc.wait()
        now = time.time()
        crash_times.append(now)

        # Keep only recent crashes
        crash_times = [t for t in crash_times if now - t < RAPID_WINDOW]

        if exit_code == 0:
            log("Bridge exited cleanly (code 0) — not restarting")
            break

        log(f"Bridge crashed with exit code {exit_code}")

        if len(crash_times) >= MAX_RAPID_CRASHES:
            log(f"Too many crashes ({len(crash_times)}) in {RAPID_WINDOW}s — giving up")
            break

        wait = min(10 * len(crash_times), 60)
        log(f"Restarting in {wait}s...")
        time.sleep(wait)


if __name__ == "__main__":
    main()
