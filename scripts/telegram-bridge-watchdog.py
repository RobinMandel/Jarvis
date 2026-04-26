"""Watchdog for telegram-bridge.py — restarts it if it crashes.

Singleton via PID-file with identity-check (Windows-PID-Recycling-Defense),
mirroring the pattern from Mission-Control's watchdog.py. Without this,
multiple watchdog instances race each other -> "Bridge laeuft bereits"
crash-loop (= the Watcher Storm pattern observed 2026-04-19 23:00).
"""
from __future__ import annotations

import ctypes
import os
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
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOG = DATA_DIR / "telegram-bridge.log"
PID_FILE = DATA_DIR / "telegram-bridge-watchdog.pid"
BRIDGE_LOCK = DATA_DIR / "telegram-bridge.lock"  # written by bridge itself
PYTHON = sys.executable
MAX_RAPID_CRASHES = 5
RAPID_WINDOW = 60  # seconds
PID_FILE_MAX_AGE_S = 6 * 3600  # stale PID file age fallback


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} [WATCHDOG] {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _is_pid_alive(pid: int) -> bool:
    try:
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
            return True
    except Exception:
        pass
    return False


def _is_pid_our_watchdog(pid: int) -> bool:
    """PID alive AND running this watchdog (defense against Windows PID-recycling)."""
    if not _is_pid_alive(pid):
        return False
    try:
        result = subprocess.run(
            ["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine", "/format:list"],
            capture_output=True, text=True, timeout=8,
            encoding="cp850", errors="replace",
        )
    except Exception as e:
        log(f"WMIC probe failed for PID {pid}: {e}")
        return True  # conservative: don't double-spawn
    cmdline = (result.stdout or "").lower()
    return ("python" in cmdline) and ("telegram-bridge-watchdog.py" in cmdline)


def acquire_singleton() -> bool:
    """True if we got the lock. False if another genuine watchdog is alive."""
    if PID_FILE.exists():
        try:
            age_s = time.time() - PID_FILE.stat().st_mtime
        except Exception:
            age_s = 0
        if age_s > PID_FILE_MAX_AGE_S:
            log(f"PID file {age_s:.0f}s old (> {PID_FILE_MAX_AGE_S}s) — taking over as stale")
        else:
            try:
                other = int(PID_FILE.read_text().strip())
                if other != os.getpid() and _is_pid_our_watchdog(other):
                    return False
                if other != os.getpid() and _is_pid_alive(other):
                    log(f"PID {other} alive but not a watchdog (PID recycle) — taking over")
                else:
                    log(f"PID {other} from pidfile is dead — taking over")
            except Exception:
                log("PID file unreadable — taking over")
    try:
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(os.getpid()))
        return True
    except Exception as e:
        log(f"PID write failed: {e}")
        return False


def release_singleton() -> None:
    try:
        if PID_FILE.exists() and int(PID_FILE.read_text().strip()) == os.getpid():
            PID_FILE.unlink()
    except Exception:
        pass


def _wait_for_existing_bridge() -> None:
    """If bridge is already running (lock file with live PID), passively wait for
    it to exit. Without this, we'd spawn a duplicate which the bridge itself
    rejects with exit 120 ("Bridge laeuft bereits"), and the watchdog would
    interpret that as a crash and immediately retry — the Watcher Storm pattern.
    """
    if not BRIDGE_LOCK.exists():
        return
    try:
        existing_pid = int(BRIDGE_LOCK.read_text().strip())
    except Exception:
        return
    if not _is_pid_alive(existing_pid):
        return  # stale lock, bridge will overwrite on its own startup
    log(f"Bridge already running (PID {existing_pid}) — adopting passively, polling for exit")
    while _is_pid_alive(existing_pid):
        time.sleep(5)
    log(f"Existing bridge PID {existing_pid} exited — resuming spawn loop")


def _run_loop() -> None:
    crash_times: list[float] = []
    while True:
        _wait_for_existing_bridge()
        log("Launching telegram-bridge.py")
        proc = subprocess.Popen(
            [PYTHON, str(BRIDGE)],
            stdin=subprocess.DEVNULL,
            cwd=str(BRIDGE.parent.parent),
        )
        log(f"Bridge started with PID {proc.pid}")

        exit_code = proc.wait()
        now = time.time()
        crash_times.append(now)
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


def main() -> None:
    if not acquire_singleton():
        log(f"Another watchdog is already running (see {PID_FILE}) — exiting.")
        return
    log(f"Starting watchdog (pid={os.getpid()})")
    try:
        _run_loop()
    finally:
        release_singleton()
        log("Watchdog exited")


if __name__ == "__main__":
    main()
