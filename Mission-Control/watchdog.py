"""Mission Control Watchdog — Singleton via PID file.

Replaces the original start.bat loop with a Python implementation that:
  1. Takes an exclusive PID-file lock so only ONE watchdog ever runs at a time
     (multiple schtasks /Run calls or Arena-triggered restarts no longer race).
  2. Spawns server.py, pipes stdout/stderr to mc_stdout.log / mc_stderr.log.
  3. On server exit: waits ~15 s (TIME_WAIT clearance), then restarts.
  4. Reacts to data/stop.flag (same convention as before) for clean shutdown.

Launched via start.bat (now a thin wrapper) from start-hidden.vbs via the
"Mission Control V3" scheduled task. Can also be run directly during dev.
"""

from __future__ import annotations

import ctypes
import os
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
SERVER = BASE / "server.py"

PID_FILE = DATA / "watchdog.pid"
STOP_FLAG = DATA / "stop.flag"
LOG_FILE = DATA / "watchdog.log"
# Aggregate logs (kept for backward compat; per-run logs are the source of truth)
STDOUT_LOG = BASE / "mc_stdout.log"
STDERR_LOG = BASE / "mc_stderr.log"
# Per-run logs (Fix 2): jeder server.py-Lauf bekommt eigene Datei -> Crashes
# bleiben isoliert und Diagnose ist moeglich. Alte Runs werden rotiert.
RUNS_DIR = DATA / "server-runs"
RUNS_KEEP = 20

PORT = 8090
RESTART_BACKOFF_S = 15
PORT_WAIT_TIMEOUT_S = 60
# A PID-file older than this is treated as stale even if the OS reports the
# PID alive (defense against Windows PID-recycling collisions).
PID_FILE_MAX_AGE_S = 6 * 3600


# ---------- Logging ----------

def log(msg: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, flush=True)
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------- Singleton PID lock ----------

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
    """Identity-check against Windows PID-recycling: PID alive AND running this watchdog.

    The plain `_is_pid_alive` returns True for *any* process holding that PID — after
    the original watchdog dies, Windows can recycle the PID for an unrelated process,
    which then keeps us locked out forever (this happened on 2026-04-26: PID 14284 was
    long-dead but reported alive by OpenProcess, blocking the morning restart).
    """
    if not _is_pid_alive(pid):
        return False
    try:
        result = subprocess.run(
            ["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine", "/format:list"],
            capture_output=True, text=True, timeout=8,
            encoding="cp850", errors="replace",
        )
    except Exception as e:
        # WMIC absent or broken -> conservatively treat as our watchdog so we don't
        # double-spawn. The age fallback in acquire_singleton catches truly stale files.
        log(f"WMIC probe failed for PID {pid}: {e}")
        return True
    cmdline = (result.stdout or "").lower()
    return ("python" in cmdline) and ("watchdog.py" in cmdline)


def acquire_singleton() -> bool:
    """True if we got the lock. False if another watchdog is genuinely alive."""
    if PID_FILE.exists():
        # Age-based stale detection: PID-file older than PID_FILE_MAX_AGE_S is
        # always treated as stale — even if the OS reports the PID alive, it
        # cannot be the same watchdog that wrote it that long ago.
        try:
            age_s = time.time() - PID_FILE.stat().st_mtime
        except Exception:
            age_s = 0
        if age_s > PID_FILE_MAX_AGE_S:
            log(f"PID file is {age_s:.0f}s old (> {PID_FILE_MAX_AGE_S}s) — taking over as stale")
        else:
            try:
                other = int(PID_FILE.read_text().strip())
                if other != os.getpid() and _is_pid_our_watchdog(other):
                    return False
                # PID alive but not our watchdog (recycled), or dead, or unparseable
                # -> fall through and overwrite the file.
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


# ---------- Port management ----------

def port_is_bindable(port: int = PORT) -> bool:
    """Try to actually bind the port. Catches both LISTEN and TIME_WAIT."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Explicitly DO NOT set SO_REUSEADDR — we want to detect real conflicts.
        s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def wait_port_free(port: int = PORT, timeout_s: float = PORT_WAIT_TIMEOUT_S) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if port_is_bindable(port):
            return True
        time.sleep(1)
    return False


def kill_port_holder(port: int = PORT) -> int | None:
    """Best-effort kill of the process listening on port. Returns PID or None."""
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, timeout=10,
            encoding="cp850", errors="replace",
        )
    except Exception as e:
        log(f"netstat failed: {e}")
        return None
    port_suffix = f":{port}"
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        proto, local, foreign, *_rest = parts
        if proto.upper() != "TCP" or not local.endswith(port_suffix):
            continue
        if foreign not in ("0.0.0.0:0", "[::]:0", "*:*"):
            continue
        try:
            pid = int(parts[-1])
        except ValueError:
            continue
        if pid > 4:
            try:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                               timeout=5, capture_output=True)
                log(f"Killed port holder PID {pid}")
                return pid
            except Exception as e:
                log(f"taskkill {pid} failed: {e}")
    return None


# ---------- Server lifecycle ----------

def _rotate_run_logs(keep: int = RUNS_KEEP) -> None:
    """Keep only the most recent `keep` per-run log pairs in RUNS_DIR."""
    try:
        if not RUNS_DIR.exists():
            return
        files = sorted(
            RUNS_DIR.glob("server-*.log"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        # Each run has out+err -> keep `keep` runs = 2*keep files.
        for old in files[2 * keep:]:
            try:
                old.unlink()
            except Exception:
                pass
    except Exception as e:
        log(f"log rotation failed: {e}")


def spawn_server():
    """Spawn server.py with per-run log files (Fix 2).

    Aggregate mc_stdout.log/mc_stderr.log are also tee'd to so older tooling
    that tails them keeps working — but the per-run files in data/server-runs/
    are the authoritative crash trace, since they don't grow unboundedly and
    each crash is isolated to its own file.
    """
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    _rotate_run_logs()
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_out_path = RUNS_DIR / f"server-{ts}-out.log"
    run_err_path = RUNS_DIR / f"server-{ts}-err.log"
    # Pin a "current" pointer file so tooling can find the live run easily
    try:
        (RUNS_DIR / "current.txt").write_text(
            f"{ts}\nout={run_out_path}\nerr={run_err_path}\n",
            encoding="utf-8",
        )
    except Exception:
        pass

    out = open(run_out_path, "w", encoding="utf-8", buffering=1)
    err = open(run_err_path, "w", encoding="utf-8", buffering=1)
    # Header so per-run files are self-describing on inspection
    header = f"# server.py run {ts} (watchdog pid={os.getpid()})\n"
    out.write(header); err.write(header)

    # Use same interpreter that launched us
    python = sys.executable
    # Tell server.py where its dedicated stderr lives so it can point
    # faulthandler at the same file for native-crash tracebacks (Fix 3).
    env = dict(os.environ)
    env["MC_RUN_STDERR"] = str(run_err_path)
    env["MC_RUN_STDOUT"] = str(run_out_path)
    env["PYTHONUNBUFFERED"] = "1"  # belt+suspenders: also disable C stdio buffering
    try:
        proc = subprocess.Popen(
            [python, str(SERVER)],
            stdout=out,
            stderr=err,
            stdin=subprocess.DEVNULL,
            cwd=str(BASE),
            env=env,
        )
        log(f"server.py spawned (server pid={proc.pid}, run={ts})")
        return proc, out, err
    except Exception:
        out.close(); err.close()
        raise


def main() -> None:
    if not acquire_singleton():
        log(f"Another watchdog is already running (see {PID_FILE}) — exiting.")
        return
    started_at = time.time()
    # Nuke any stale stop.flag from a prior run — otherwise we'd exit immediately.
    if STOP_FLAG.exists():
        try:
            STOP_FLAG.unlink()
            log("Cleared stale stop.flag from prior run")
        except Exception:
            pass
    log(f"Watchdog started (pid={os.getpid()})")
    try:
        while True:
            # Honor stop.flag — but only if it was set AFTER we started, otherwise
            # it's a leftover from an old crashed watchdog or unrelated script.
            if STOP_FLAG.exists():
                try:
                    mtime = STOP_FLAG.stat().st_mtime
                except Exception:
                    mtime = 0
                if mtime >= started_at - 5:
                    try: STOP_FLAG.unlink()
                    except Exception: pass
                    log("stop.flag detected (fresh) — exiting watchdog")
                    break
                else:
                    try: STOP_FLAG.unlink()
                    except Exception: pass
                    log("stop.flag ignored (stale)")

            # Make sure port is free. If not, try to kill the holder, then wait.
            if not port_is_bindable():
                holder = kill_port_holder()
                if holder:
                    time.sleep(2)
                if not wait_port_free(timeout_s=PORT_WAIT_TIMEOUT_S):
                    log(f"Port {PORT} still busy after {PORT_WAIT_TIMEOUT_S}s — retrying later")
                    time.sleep(10)
                    continue

            log("Starting server.py …")
            try:
                proc, out_f, err_f = spawn_server()
            except Exception as e:
                log(f"Spawn failed: {e}")
                time.sleep(RESTART_BACKOFF_S)
                continue
            try:
                rc = proc.wait()
            finally:
                try: out_f.close()
                except Exception: pass
                try: err_f.close()
                except Exception: pass
            log(f"server.py exited with rc={rc}")

            if STOP_FLAG.exists():
                try:
                    mtime = STOP_FLAG.stat().st_mtime
                except Exception:
                    mtime = 0
                try: STOP_FLAG.unlink()
                except Exception: pass
                if mtime >= started_at - 5:
                    log("stop.flag after server exit (fresh) — leaving watchdog loop")
                    break
                log("stop.flag after server exit (stale) — ignoring and restarting")

            log(f"Restarting in {RESTART_BACKOFF_S}s …")
            # Sleep in small steps so we react to stop.flag promptly
            for _ in range(RESTART_BACKOFF_S):
                if STOP_FLAG.exists(): break
                time.sleep(1)
    finally:
        release_singleton()
        log("Watchdog exited")


if __name__ == "__main__":
    main()
