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
TRIGGER_FILE = BASE_DIR / "data" / "restart.trigger"
STOP_FLAG = BASE_DIR / "data" / "stop.flag"
LOG_FILE = BASE_DIR / "data" / "watcher.log"
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
    # Signal existing start.bat loop to exit after python dies (prevents crash-loop)
    STOP_FLAG.touch()
    kill_mc_processes()
    if wait_port_free(8090, timeout_s=15.0):
        log("Port 8090 free")
    else:
        log("WARN: port 8090 still busy after wait — forcing second kill pass")
        kill_mc_processes()
        time.sleep(1.5)

    if start_mc():
        log("MC restart dispatched")
    else:
        log("ERROR: Failed to restart MC")

    try:
        TRIGGER_FILE.unlink()
        log("Trigger file removed")
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"Trigger unlink failed: {e}")

    # Clean up stop.flag in case start.bat didn't consume it
    STOP_FLAG.unlink(missing_ok=True)

    time.sleep(3)  # cooldown


def main() -> None:
    log(f"Watcher started (pid={os.getpid()}, trigger={TRIGGER_FILE})")
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


if __name__ == "__main__":
    main()
