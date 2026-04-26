"""
Detached restart watcher for Mission Control.
Runs as its own process (scheduled task), monitors restart.trigger file.
When the trigger exists: kills MC server, waits, restarts via start.bat.
"""

import time
import os
import sys
import subprocess
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent
# v2 path: isolates any still-running pre-lock watcher that polls the old path.
TRIGGER_FILE = BASE_DIR / "data" / "restart.v2.trigger"
STOP_FLAG = BASE_DIR / "data" / "stop.flag"
LOG_FILE = BASE_DIR / "data" / "watcher.log"
PID_FILE = BASE_DIR / "data" / "watcher.pid"
POLL_INTERVAL = 0.5

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except AttributeError:
        pass


def log(msg: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def find_listener_pids(port: int = 8090) -> set[int]:
    """Find PIDs of processes listening on the given port.

    Works with localized netstat output (German: ABHÖREN, English: LISTENING)
    by matching on address format rather than state string:
    the listener row has Local Address ending in ':<port>' and
    Foreign Address equal to '0.0.0.0:0' (IPv4) or '[::]:0' (IPv6).
    """
    pids: set[int] = set()
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, timeout=10,
            encoding="cp850", errors="replace",
        )
    except Exception as e:
        log(f"netstat failed: {e}")
        return pids

    port_suffix = f":{port}"
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        # Expected: Proto Local Foreign State PID
        proto, local, foreign, *_rest = parts
        if proto.upper() != "TCP":
            continue
        if not local.endswith(port_suffix):
            continue
        if foreign not in ("0.0.0.0:0", "[::]:0", "*:*"):
            continue
        try:
            pid = int(parts[-1])
        except ValueError:
            continue
        if pid > 4:
            pids.add(pid)
    return pids


def kill_mc_processes() -> None:
    pids = find_listener_pids(8090)
    if not pids:
        log("No listener found on port 8090")
        return
    for pid in pids:
        log(f"Killing listener PID {pid}")
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                timeout=5, capture_output=True,
            )
        except Exception as e:
            log(f"taskkill PID {pid} failed: {e}")


def wait_port_free(port: int = 8090, timeout_s: float = 15.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not find_listener_pids(port):
            return True
        time.sleep(0.3)
    return False


def start_mc() -> bool:
    start_bat = BASE_DIR / "start.bat"
    if not start_bat.exists():
        log(f"ERROR: {start_bat} not found")
        return False
    try:
        subprocess.Popen(
            f'cmd /c "{start_bat}"',
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(BASE_DIR),
            creationflags=0x00000200,  # CREATE_NEW_PROCESS_GROUP
        )
        log(f"Started MC via {start_bat}")
        return True
    except Exception as e:
        log(f"Error starting MC: {e}")
        return False


def handle_trigger() -> None:
    log("Restart trigger detected")
    # Just kill the running server — the (singleton) watchdog.py will auto-restart
    # it after its ~15s backoff. Spawning our own start.bat here would collide with
    # the existing watchdog's own restart attempt and reintroduces the race this
    # whole layer was meant to prevent.
    kill_mc_processes()
    if wait_port_free(8090, timeout_s=15.0):
        log("Port 8090 free — watchdog will relaunch server in ~15s")
    else:
        log("WARN: port 8090 still busy after wait — forcing second kill pass")
        kill_mc_processes()
        time.sleep(1.5)

    try:
        TRIGGER_FILE.unlink()
        log("Trigger file removed")
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"Trigger unlink failed: {e}")

    time.sleep(3)  # cooldown before next poll iteration


def _is_alive(pid: int) -> bool:
    try:
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
            return True
    except Exception:
        pass
    return False


def _acquire_singleton() -> bool:
    if PID_FILE.exists():
        try:
            other = int(PID_FILE.read_text().strip())
            if other != os.getpid() and _is_alive(other):
                return False
        except Exception:
            pass
    try:
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(os.getpid()))
    except Exception as e:
        log(f"PID file write failed: {e}")
    return True


def main() -> None:
    if not _acquire_singleton():
        log(f"Another watcher already running (see {PID_FILE}) — exiting.")
        return
    log(f"Watcher started (pid={os.getpid()}, trigger={TRIGGER_FILE})")
    try:
        while True:
            try:
                if TRIGGER_FILE.exists():
                    handle_trigger()
                time.sleep(POLL_INTERVAL)
            except KeyboardInterrupt:
                log("Shutting down (KeyboardInterrupt)")
                break
            except Exception as e:
                log(f"Unexpected error: {e}")
                time.sleep(1)
    finally:
        try:
            if PID_FILE.exists() and int(PID_FILE.read_text().strip()) == os.getpid():
                PID_FILE.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    main()
