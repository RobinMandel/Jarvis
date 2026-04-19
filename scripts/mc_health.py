"""Mission Control health check.

Runs periodically (via Scheduled Task, every 15 min). Cleans zombies, detects
stuck state, monitors stderr for new tracebacks. DOES NOT restart the server
or modify code — only cleanup and reporting. Notifies via ntfy when something
looks broken.

Exit code is always 0 so the scheduler doesn't retry-loop on transient issues.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

import psutil
import urllib.request
import urllib.error


MC_ROOT = Path(r"C:\Users\Robin\Jarvis\Mission-Control")
DATA_DIR = Path(r"C:\Users\Robin\Jarvis\data")
HEALTH_LOG = DATA_DIR / "mc-health.log"
STATE_FILE = DATA_DIR / "mc-health-state.json"
STDERR_LOG = MC_ROOT / "mc_stderr.log"
SESSIONS_JSON = MC_ROOT / "data" / "sessions.json"
MC_CONFIG = MC_ROOT / "config.json"
MC_HEALTH_URL = "http://localhost:8090/"


def log(msg: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with HEALTH_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def ntfy_push(title: str, message: str, priority: int = 3, tags: str = "warning") -> None:
    """Send an ntfy push using the topic configured in MC's config.json."""
    try:
        cfg = json.loads(MC_CONFIG.read_text(encoding="utf-8"))
        topic = cfg.get("ntfy_topic")
        server = cfg.get("ntfy_server", "https://ntfy.sh")
        if not topic:
            return
        url = f"{server}/{topic}"
        req = urllib.request.Request(
            url,
            data=message.encode("utf-8"),
            headers={
                "Title": title.encode("utf-8").decode("latin-1", errors="replace"),
                "Priority": str(priority),
                "Tags": tags,
            },
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        log(f"ntfy push failed: {e}")


# ── Checks ────────────────────────────────────────────────────────────────


def find_mc_procs() -> tuple[list[psutil.Process], list[psutil.Process]]:
    """Return (server_procs, watchdog_procs) — cmd.exe with start.bat, python with server.py."""
    servers = []
    watchdogs = []
    for p in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        try:
            name = (p.info["name"] or "").lower()
            cmdline = " ".join(p.info["cmdline"] or [])
            if name == "python.exe" and "server.py" in cmdline:
                servers.append(p)
            elif name == "cmd.exe" and "start.bat" in cmdline.lower():
                watchdogs.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return servers, watchdogs


def check_duplicate_watchdogs(watchdogs: list[psutil.Process]) -> list[str]:
    """More than one watchdog means they will cannibalize each other via the port-kill logic."""
    issues = []
    if len(watchdogs) > 1:
        # keep the oldest, kill the rest
        watchdogs.sort(key=lambda p: p.info["create_time"])
        keep = watchdogs[0]
        to_kill = watchdogs[1:]
        issues.append(f"duplicate watchdogs: {len(watchdogs)} (keeping PID {keep.pid}, killing {[p.pid for p in to_kill]})")
        for p in to_kill:
            try:
                p.kill()
            except Exception:
                pass
    return issues


def check_duplicate_servers(servers: list[psutil.Process]) -> list[str]:
    """More than one server.py means one grabbed the port and the others are zombie-crashed, but any still alive wastes resources."""
    issues = []
    if len(servers) > 1:
        servers.sort(key=lambda p: p.info["create_time"])
        keep = servers[-1]  # keep the newest — it likely holds the port
        to_kill = [p for p in servers if p.pid != keep.pid]
        issues.append(f"duplicate servers: {len(servers)} (keeping PID {keep.pid}, killing {[p.pid for p in to_kill]})")
        for p in to_kill:
            try:
                p.kill()
            except Exception:
                pass
    return issues


def check_cloudflared() -> list[str]:
    """Ensure Windows cloudflared service is running; auto-start if not. Reports on action taken."""
    issues = []
    try:
        import subprocess
        r = subprocess.run(
            ["sc", "query", "cloudflared"],
            capture_output=True, text=True, timeout=5,
        )
        if "RUNNING" in r.stdout:
            return issues
        # service exists but is not running → try to start
        start = subprocess.run(
            ["sc", "start", "cloudflared"],
            capture_output=True, text=True, timeout=10,
        )
        if start.returncode == 0:
            issues.append("cloudflared was stopped — auto-restarted")
        else:
            issues.append(f"cloudflared stopped AND auto-restart failed: {start.stderr.strip() or start.stdout.strip()}")
    except Exception as e:
        issues.append(f"cloudflared check error: {e}")
    return issues


def check_http() -> list[str]:
    issues = []
    try:
        req = urllib.request.Request(MC_HEALTH_URL)
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                issues.append(f"HTTP {resp.status} on /")
    except Exception as e:
        issues.append(f"HTTP unreachable: {e}")
    return issues


def check_stuck_streams(server_alive: bool) -> list[str]:
    """Sessions flagged _stream_active=True but no live subprocess → clear flag in sessions.json.

    Only runs if we believe the server is OK (we don't want to mangle state while a real run happens).
    """
    issues = []
    if not server_alive:
        return issues
    if not SESSIONS_JSON.exists():
        return issues
    try:
        data = json.loads(SESSIONS_JSON.read_text(encoding="utf-8"))
    except Exception as e:
        issues.append(f"sessions.json parse error: {e}")
        return issues
    # any claude.exe children of MC server?
    claude_alive = False
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower() == "claude.exe" and any("server.py" in " ".join((pp.cmdline() or [])) for pp in p.parents() if pp):
                claude_alive = True
                break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if claude_alive:
        return issues
    # No live claude subprocess but sessions marked active → flag them for cleanup.
    # We DON'T write to sessions.json directly (race with the running server).
    # We just report; server will clean on its own turn OR next restart via our auto-resume logic.
    stuck = [sid for sid, s in data.items() if s.get("_stream_active")]
    if stuck:
        issues.append(f"{len(stuck)} session(s) flagged _stream_active but no claude subprocess: {[s[:8] for s in stuck]}")
    return issues


def check_new_tracebacks(state: dict) -> list[str]:
    """Tail mc_stderr.log since last run; if tracebacks appear, summarize them."""
    issues = []
    if not STDERR_LOG.exists():
        return issues
    try:
        size = STDERR_LOG.stat().st_size
    except Exception:
        return issues
    last_offset = state.get("stderr_offset", 0)
    # if file got rotated/smaller, reset
    if last_offset > size:
        last_offset = 0
    if size == last_offset:
        return issues
    try:
        with STDERR_LOG.open("rb") as f:
            f.seek(last_offset)
            chunk = f.read(size - last_offset).decode("utf-8", errors="replace")
    except Exception as e:
        issues.append(f"stderr read error: {e}")
        return issues
    state["stderr_offset"] = size

    # count error signatures
    sigs: dict[str, int] = {}
    for line in chunk.splitlines():
        line = line.strip()
        if any(
            marker in line
            for marker in ("Error:", "Exception:", "Traceback", "OSError")
        ):
            # normalize to a stable key
            key = line[:120]
            sigs[key] = sigs.get(key, 0) + 1

    if sigs:
        top = sorted(sigs.items(), key=lambda x: -x[1])[:5]
        summary = "; ".join(f"{c}× {msg}" for msg, c in top)
        issues.append(f"new stderr tracebacks since last check: {summary}")
    return issues


def check_restart_churn(state: dict) -> list[str]:
    """Count recent 'Server stopped (exit X)' entries — too many = crash-loop."""
    issues = []
    restart_log = MC_ROOT / "server_restart.log"
    if not restart_log.exists():
        return issues
    try:
        size = restart_log.stat().st_size
    except Exception:
        return issues
    last_offset = state.get("restart_offset", 0)
    if last_offset > size:
        last_offset = 0
    try:
        with restart_log.open("rb") as f:
            f.seek(last_offset)
            chunk = f.read(size - last_offset).decode("utf-8", errors="replace")
    except Exception:
        return issues
    state["restart_offset"] = size
    stops = chunk.count("Server stopped")
    if stops > 5:
        issues.append(f"crash-loop suspected: {stops} Server-stopped events since last check (15 min)")
    return issues


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> int:
    state = load_state()
    all_issues: list[str] = []

    try:
        servers, watchdogs = find_mc_procs()
        all_issues += check_duplicate_watchdogs(watchdogs)
        all_issues += check_duplicate_servers(servers)
        all_issues += check_cloudflared()
        http_issues = check_http()
        all_issues += http_issues
        server_alive = not http_issues
        all_issues += check_stuck_streams(server_alive)
        all_issues += check_new_tracebacks(state)
        all_issues += check_restart_churn(state)
    except Exception as e:
        tb = traceback.format_exc()
        all_issues.append(f"health-check itself errored: {e}")
        log(f"CRASH: {tb}")

    save_state(state)

    if not all_issues:
        log("OK")
        return 0

    for i in all_issues:
        log(f"ISSUE: {i}")

    # Escalation: HTTP unreachable OR crash-loop → priority 5 (urgent)
    urgent = any(
        "HTTP unreachable" in i
        or "crash-loop" in i
        or "cloudflared stopped AND auto-restart failed" in i
        for i in all_issues
    )
    title = "MC Health: PROBLEM" if urgent else "MC Health: Warnung"
    body = "\n".join(all_issues)[:1500]
    ntfy_push(
        title=title,
        message=body,
        priority=5 if urgent else 3,
        tags="rotating_light" if urgent else "warning",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
