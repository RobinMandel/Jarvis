"""Mission Control V3  -  Backend Server
aiohttp-based server bridging Claude Code CLI to a web dashboard.
"""

import asyncio
import json
import time
import uuid
import os
import sys
from pathlib import Path
from datetime import datetime

import aiohttp
from aiohttp import web

from notify import send_push

BASE_DIR = Path(__file__).parent
_JARVIS_ROOT = BASE_DIR.parent
# Mission-Control/ must come before Jarvis root so that Mission-Control/rag/
# takes priority over any rag/ package that may exist in the Jarvis root.
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))
if str(_JARVIS_ROOT) not in sys.path:
    sys.path.append(str(_JARVIS_ROOT))

# Suppress console windows when spawning subprocesses on Windows
_SUBPROCESS_FLAGS = {}
if sys.platform == 'win32':
    import subprocess as _sp
    _si = _sp.STARTUPINFO()
    _si.dwFlags |= _sp.STARTF_USESHOWWINDOW
    _si.wShowWindow = 0  # SW_HIDE
    _SUBPROCESS_FLAGS = {
        'creationflags': 0x08000000,  # CREATE_NO_WINDOW
        'startupinfo': _si,
    }
    # Force UTF-8 stdout/stderr so Unicode chars like → don't crash on cp1252
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except AttributeError:
        pass
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS_DIR = DATA_DIR / "transcripts"
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)


def atomic_write_text(path, content, *, encoding="utf-8", keep_backup=True):
    """Crash-safe write: tmp-file + rename, keeps a .bak of the previous good copy.

    Prevents half-written sessions.json / tasks.json when the server is killed
    mid-write (Ctrl+C, crash, power loss). If the write succeeds we rotate the
    previous file to .bak so the on-load fallback has something to recover from.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding=encoding)
    if keep_backup and path.exists():
        try:
            bak = path.with_suffix(path.suffix + ".bak")
            if bak.exists():
                bak.unlink()
            path.replace(bak)
        except Exception:
            pass  # Backup is best-effort; don't block the actual write
    tmp.replace(path)


def safe_read_json(path, default=None):
    """Read JSON with automatic fallback to .bak if the main file is corrupt."""
    path = Path(path)
    for candidate in (path, path.with_suffix(path.suffix + ".bak")):
        if not candidate.exists():
            continue
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[Persist] {candidate.name} corrupt ({e}); trying fallback", flush=True)
    return default

# Redirect stdout/stderr to log file so all print() calls are captured
import logging as _logging
_log_path = DATA_DIR / "server.log"
_log_fh = open(_log_path, "a", encoding="utf-8", buffering=1)

class _Tee:
    """Write to both original stream and log file."""
    def __init__(self, orig, fh):
        self._orig = orig
        self._fh = fh
    def write(self, s):
        try:
            self._orig.write(s)
        except UnicodeEncodeError:
            self._orig.write(s.encode('utf-8', errors='replace').decode(
                getattr(self._orig, 'encoding', 'utf-8') or 'utf-8', errors='replace'))
        self._fh.write(s)
    def flush(self):
        self._orig.flush()
        self._fh.flush()
    def __getattr__(self, name):
        return getattr(self._orig, name)

sys.stdout = _Tee(sys.stdout, _log_fh)
sys.stderr = _Tee(sys.stderr, _log_fh)
print(f"[Boot] Mission Control started at {datetime.now().isoformat()}", flush=True)
STATIC_DIR = BASE_DIR / "static"
with open(Path(__file__).parent / "config.json") as _cf:
    _config_memory = json.load(_cf).get("memory_dir", "data/memory")
MEMORY_DIR = Path(_config_memory) if Path(_config_memory).is_absolute() else BASE_DIR / _config_memory
AVATARS_DIR = BASE_DIR / "avatars"

with open(BASE_DIR / "config.json") as f:
    CONFIG = json.load(f)

import re


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------

class _SafeLock(asyncio.Lock):
    """asyncio.Lock whose context-manager exit tolerates a prior force_unlock().

    Without this, `force_unlock()` releasing the lock mid-run causes the `async
    with`'s __aexit__ to raise RuntimeError('Lock is not acquired.'), which
    kills the `_run_claude` Task silently — the frontend then sees no chat.done
    event and hangs forever in "crunching...".
    """

    async def __aexit__(self, exc_type, exc, tb):
        try:
            self.release()
        except RuntimeError:
            pass


class ClaudeSession:
    """Represents a single chat session with Claude CLI."""

    def __init__(self, session_id=None):
        self.session_id = session_id or str(uuid.uuid4())
        self.cli_session_id = None
        self.process = None
        self.locked = False
        self.lock = _SafeLock()
        self.created_at = datetime.now().isoformat()
        self.message_count = 0
        self.history = []
        self.custom_title = None
        self.auto_title = "Neue Session"
        self.topic = None
        self.topic_color = None
        self.last_message = None
        self.last_heartbeat = None  # updated on stream-start and message-done; shows real liveness
        self._streaming_partial = None  # partial response text saved during streaming
        self._lock_acquired_at = None  # timestamp when lock was acquired
        self.needs_resume = False  # set on load if stream was interrupted by server restart
        self._stream_active = False  # True while Claude subprocess is running; persisted

    async def cancel(self):
        """Kill the running Claude subprocess if any."""
        if self.process and self.process.returncode is None:
            self.process.kill()
            await self.process.wait()
            self.process = None
        self._stream_active = False
        self._streaming_partial = None

    def force_unlock(self):
        """Force-release lock if stuck (e.g. after WS disconnect or crash)."""
        if self.lock.locked():
            try:
                self.lock.release()
                print(f"[Session] Force-unlocked session {self.session_id[:8]}")
            except RuntimeError:
                pass  # already unlocked

    def to_dict(self):
        """Serialize session for JSON persistence and API responses."""
        import re as _re
        last_preview = ''
        for msg in reversed(self.history):
            if msg.get('role') == 'assistant':
                raw = msg.get('content', '')
                clean = _re.sub(r'```[\s\S]*?```', '', raw)
                clean = _re.sub(r'[#*_`~>\[\]()!|]', '', clean)
                clean = ' '.join(clean.split())
                last_preview = clean[:110]
                break
        return {
            "session_id": self.session_id,
            "cli_session_id": self.cli_session_id,
            "created_at": self.created_at,
            "message_count": self.message_count,
            "history": self.history,
            "custom_title": self.custom_title,
            "auto_title": self.auto_title,
            "title": self.custom_title or self.auto_title,
            "topic": self.topic,
            "topic_color": self.topic_color,
            "last_message": self.last_message,
            "last_heartbeat": self.last_heartbeat,
            "last_preview": last_preview,
        }


class SessionManager:
    """Manages all chat sessions, persisted to data/sessions.json."""

    def __init__(self):
        self.sessions: dict[str, ClaudeSession] = {}
        self._file = DATA_DIR / "sessions.json"
        self._topic_file = DATA_DIR / "topic-colors.json"
        self._load()

    def _load(self):
        """Load sessions from disk (with .bak fallback on corruption)."""
        raw = safe_read_json(self._file, default=None)
        if raw is not None:
            try:
                _skipped = 0
                for sid, data in raw.items():
                    if not isinstance(data, dict) or "history" not in data:
                        _skipped += 1
                        print(f"[Sessions] Skip dead session {sid[:8]} — invalid data (keys: {list(data.keys()) if isinstance(data, dict) else type(data).__name__})", flush=True)
                        continue
                    s = ClaudeSession(session_id=sid)
                    # Don't restore cli_session_id — old CLI sessions are unreliable
                    # after server restart and cause zombie processes with --resume
                    s.cli_session_id = None
                    s.created_at = data.get("created_at", s.created_at)
                    s.message_count = data.get("message_count", 0)
                    s.history = data.get("history", [])
                    s.custom_title = data.get("custom_title")
                    s.auto_title = data.get("auto_title")
                    s.topic = data.get("topic")
                    s.topic_color = data.get("topic_color")
                    s.last_message = data.get("last_message")
                    s.last_heartbeat = data.get("last_heartbeat", s.last_message)
                    # Recover partial streaming response from crash. If the
                    # partial exists, append it as truncated assistant reply.
                    partial = data.get("_streaming_partial")
                    interrupted_stream = bool(partial) and (
                        not s.history or s.history[-1].get("role") != "assistant"
                    )
                    if interrupted_stream:
                        s.history.append({"role": "assistant", "content": partial + "\n\n_(unvollständig — Server wurde neugestartet)_"})
                        print(f"[Sessions] Recovered partial response for {sid[:8]} ({len(partial)} chars)")
                    s._streaming_partial = None  # clear after recovery
                    # Auto-resume trigger: _stream_active was True at last persist
                    # means the subprocess was alive when the server died — even
                    # if no text tokens had streamed yet (tool-phase kill).
                    if data.get("_stream_active"):
                        s.needs_resume = True
                        print(f"[Sessions] Session {sid[:8]} was mid-stream at shutdown → queued for resume")
                    s._stream_active = False  # reset after load
                    self.sessions[sid] = s
            except Exception as e:
                _skipped = 0
                print(f"[Sessions] Failed to parse sessions.json payload: {e}")
        else:
            _skipped = 0
        skip_note = f", {_skipped} tot übersprungen" if _skipped else ""
        print(f"[Sessions] Loaded {len(self.sessions)} session(s) from disk{skip_note}", flush=True)

    def persist(self):
        """Save all sessions to disk."""
        data = {}
        for sid, s in self.sessions.items():
            data[sid] = {
                "cli_session_id": s.cli_session_id,
                "created_at": s.created_at,
                "message_count": s.message_count,
                "history": s.history,
                "custom_title": s.custom_title,
                "auto_title": s.auto_title,
                "topic": s.topic,
                "topic_color": s.topic_color,
                "last_message": s.last_message,
                "last_heartbeat": s.last_heartbeat,
                "_streaming_partial": s._streaming_partial,
                "_stream_active": s._stream_active,
            }
        atomic_write_text(self._file, json.dumps(data, ensure_ascii=False, indent=2))

    def list_sessions(self):
        """Return dict of all sessions (serialized for API/WS responses)."""
        result = {}
        for sid, s in self.sessions.items():
            result[sid] = s.to_dict()
        return result

    def create_session(self, session_id=None):
        """Create a new session and persist."""
        s = ClaudeSession(session_id=session_id)
        self.sessions[s.session_id] = s
        self.persist()
        return s

    def get_or_create(self, session_id=None):
        """Get existing session by ID or create a new one."""
        if session_id and session_id in self.sessions:
            return self.sessions[session_id]
        return self.create_session(session_id=session_id)

    def delete_session(self, sid):
        """Delete a session by ID and persist."""
        if sid in self.sessions:
            del self.sessions[sid]
            self.persist()

    def rename_session(self, sid, title):
        """Set a custom title for a session."""
        if sid in self.sessions:
            self.sessions[sid].custom_title = title
            self.persist()

    def set_session_topic(self, session_id, topic, color):
        """Assign a topic and color to a session."""
        if session_id in self.sessions:
            self.sessions[session_id].topic = topic
            self.sessions[session_id].topic_color = color
            self.persist()

    def get_topics(self):
        """Return dict of topic name -> color from all sessions."""
        topics = {}
        for s in self.sessions.values():
            if s.topic and s.topic_color:
                topics[s.topic] = s.topic_color
        return topics

    def _topic_colors(self):
        """Load topic color mapping from topic-colors.json."""
        if self._topic_file.exists():
            try:
                return json.loads(self._topic_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, Exception):
                pass
        return {}

    def _save_topic_color(self, topic, color):
        """Save a topic->color mapping to topic-colors.json."""
        colors = self._topic_colors()
        colors[topic] = color
        atomic_write_text(self._topic_file, json.dumps(colors, ensure_ascii=False, indent=2))

    @staticmethod
    def _default_color(topic):
        """Generate a deterministic color from a topic name."""
        palette = [
            "#f59e0b", "#06b6d4", "#6366f1", "#e11d48",
            "#10b981", "#8b5cf6", "#ec4899", "#14b8a6",
            "#f97316", "#3b82f6", "#a855f7", "#ef4444",
        ]
        h = sum(ord(c) for c in topic)
        return palette[h % len(palette)]


sessions = SessionManager()


# ---------------------------------------------------------------------------
# Window Hider  -  hide any console windows spawned by Claude CLI / MCP
# ---------------------------------------------------------------------------
if sys.platform == 'win32':
    import ctypes
    import ctypes.wintypes as _wt

    _user32 = ctypes.windll.user32
    _WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, _wt.HWND, _wt.LPARAM)
    _SW_HIDE = 0
    _GW_OWNER = 4

    def _hide_console_windows():
        """Find and hide any visible console windows from claude/cmd/node MCP."""
        targets = {b'claude', b'cmd', b'node', b'npx'}

        @_WNDENUMPROC
        def _cb(hwnd, _):
            if not _user32.IsWindowVisible(hwnd):
                return True
            # Skip owned windows (dialogs etc.)
            if _user32.GetWindow(hwnd, _GW_OWNER):
                return True
            buf = ctypes.create_string_buffer(512)
            _user32.GetWindowTextA(hwnd, buf, 512)
            title = buf.value.lower()
            if any(t in title for t in targets):
                pid = _wt.DWORD()
                _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                # Don't hide our own terminal or user-opened windows
                # Only hide windows whose PID matches a known Claude subprocess
                # DISABLED: _user32.ShowWindow(hwnd, _SW_HIDE)
                print(f"[WinHider] Hidden window: '{buf.value.decode(errors='replace')}' PID={pid.value}")
            return True

        _user32.EnumWindows(_cb, 0)

    async def _window_hider_loop():
        return  # DISABLED — was hiding all windows with "claude" in title
else:
    async def _window_hider_loop():
        return  # no-op on non-Windows


# ---------------------------------------------------------------------------
# System Prompt Builder
# ---------------------------------------------------------------------------

def _build_system_prompt():
    """Build full system prompt — identity + memory + context."""
    parts = []
    # SOUL.md — core identity
    soul = MEMORY_DIR / "SOUL.md"
    if soul.exists():
        parts.append(soul.read_text(encoding="utf-8", errors="replace"))
    # Identity + key memory files
    for name in ("identity.md", "robin.md", "decisions.md", "projects.md", "todos.md"):
        p = MEMORY_DIR / name
        if p.exists():
            content = p.read_text(encoding="utf-8", errors="replace")
            parts.append(f"--- {name} ---\n{content}")
    # Claude Code memory files (feedback, project state) — check all relevant project dirs
    for proj_dir in ("C--WINDOWS-system32", "C--Users-Robin-Jarvis-Mission-Control"):
        claude_memory = Path.home() / ".claude" / "projects" / proj_dir / "memory"
        if not claude_memory.exists():
            continue
        for f in claude_memory.glob("*.md"):
            try:
                content = f.read_text(encoding="utf-8", errors="replace")
                if content.strip():
                    parts.append(f"--- Claude Memory: {f.name} ---\n{content}")
            except Exception:
                pass
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Memory Files API (reconstructed after accidental deletion)
# ---------------------------------------------------------------------------

async def api_memory_list(request):
    """List all memory/vault files for the Memory tab."""
    daily_claude = []
    daily_openclaw = []
    meta_files = []
    other_files = []
    CLAUDE_CODE_START = "2026-04-10"

    if not MEMORY_DIR.exists():
        return web.json_response([])

    for f in MEMORY_DIR.rglob("*.md"):
        stat = f.stat()
        entry = {
            "name": f.name,
            "path": str(f.relative_to(MEMORY_DIR)),
            "size": stat.st_size,
            "modified": stat.st_mtime,
        }

        if f.name[:4].isdigit() and len(f.name) == 13:
            if f.name[:10] >= CLAUDE_CODE_START:
                entry["era"] = "claude-code"
                daily_claude.append(entry)
            else:
                entry["era"] = "openclaw"
                daily_openclaw.append(entry)
        elif f.name in ("SOUL.md", "identity.md", "robin.md", "decisions.md",
                        "projects.md", "todos.md", "inbox.md", "failsafe.md",
                        "INDEX.md", "README.md"):
            entry["type"] = "meta"
            meta_files.append(entry)
        else:
            entry["type"] = "other"
            other_files.append(entry)

    # Sort: meta first, then claude daily (newest first), then openclaw daily (newest first), then other
    daily_claude.sort(key=lambda x: x["name"], reverse=True)
    daily_openclaw.sort(key=lambda x: x["name"], reverse=True)
    meta_files.sort(key=lambda x: x["name"])
    other_files.sort(key=lambda x: x["name"])

    all_files = meta_files + daily_claude + daily_openclaw + other_files
    return web.json_response(all_files)


# ---------------------------------------------------------------------------
# Tasks / Timeline APIs (reconstructed after accidental deletion)
# ---------------------------------------------------------------------------

async def api_tasks(request):
    """CRUD for simple task list stored in data/tasks.json."""
    tasks_file = DATA_DIR / "tasks.json"
    if request.method == "GET":
        if tasks_file.exists():
            return web.json_response(json.loads(tasks_file.read_text(encoding="utf-8")))
        return web.json_response([])
    # PUT or POST — save tasks
    body = await request.json()
    atomic_write_text(tasks_file, json.dumps(body, ensure_ascii=False, indent=2))
    return web.json_response({"ok": True})


async def api_timeline(request):
    """Return timeline events from data/timeline.json."""
    tl_file = DATA_DIR / "timeline.json"
    if tl_file.exists():
        return web.json_response(json.loads(tl_file.read_text(encoding="utf-8")))
    return web.json_response([])


async def api_memory_file(request):
    name = request.match_info["filename"]
    if not name.endswith(".md"):
        raise web.HTTPNotFound()
    # Search in Memory, Knowledge, then Vault root + ChatGPT-Import hubs
    VAULT_BASE = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain")
    candidates = [
        MEMORY_DIR / name,
        VAULT_BASE / "Jarvis-Knowledge" / name,
        VAULT_BASE / name,
        VAULT_BASE / "ChatGPT-Import" / "_Hubs" / name,
    ]
    for path in candidates:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            return web.Response(text=text, content_type="text/plain", charset="utf-8")
    raise web.HTTPNotFound()


async def api_sessions(request):
    return web.json_response(sessions.list_sessions())


# ---------------------------------------------------------------------------
# New Panel APIs: Email, Calendar, System
# ---------------------------------------------------------------------------

SCRIPTS_DIR = Path("C:/Users/Robin/Jarvis/scripts")
JARVIS_DATA = Path("C:/Users/Robin/Jarvis/data")


async def _run_script(cmd, timeout=20):
    """Run a python script and return stdout."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8",
           "MS_CLIENT_ID": "2fbe99b8-e739-4dfa-860f-bc8d2396700a",
           "MS_TENANT_ID": "common"}
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env, **_SUBPROCESS_FLAGS,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return stdout.decode("utf-8", errors="replace").strip()
    except asyncio.TimeoutError:
        proc.kill()
        return ""


async def api_email(request):
    """Get unread emails from Outlook + Uni."""
    outlook_raw = await _run_script([
        sys.executable, str(SCRIPTS_DIR / "outlook_graph.py"), "unread", "--top", "15"
    ])
    # Parse outlook output
    outlook_mails = []
    for line in outlook_raw.split("\n"):
        if line.startswith("- "):
            parts = line[2:].split(" | ")
            if len(parts) >= 3:
                outlook_mails.append({
                    "date": parts[0].strip(),
                    "from": parts[1].strip(),
                    "subject": parts[2].strip(),
                    "account": "Outlook"
                })

    # Uni mail via IMAP
    uni_mails = []
    try:
        import imaplib
        import ssl
        cred_file = Path("C:/Users/Robin/Jarvis/secrets/uni-mail-cred.json")
        if cred_file.exists():
            creds = json.loads(cred_file.read_text(encoding="utf-8"))
            ctx = ssl.create_default_context()
            m = imaplib.IMAP4_SSL("imap.uni-ulm.de", 993, ssl_context=ctx)
            m.login("robin.mandel@uni-ulm.de", creds["password"])
            m.select("INBOX")
            _, data = m.search(None, "UNSEEN")
            ids = data[0].split()
            for mid in ids[-10:]:
                _, msg_data = m.fetch(mid, "(BODY[HEADER.FIELDS (FROM SUBJECT DATE)])")
                raw = msg_data[0][1].decode("utf-8", errors="replace")
                mail = {"account": "Uni", "from": "", "subject": "", "date": ""}
                for l in raw.strip().split("\n"):
                    l = l.strip()
                    if l.lower().startswith("from:"): mail["from"] = l[5:].strip()
                    elif l.lower().startswith("subject:"): mail["subject"] = l[8:].strip()
                    elif l.lower().startswith("date:"): mail["date"] = l[5:].strip()
                if mail["subject"] or mail["from"]:
                    uni_mails.append(mail)
            m.logout()
    except Exception as e:
        print(f"[Email] Uni error: {e}")

    return web.json_response({
        "outlook": outlook_mails,
        "uni": uni_mails,
        "total_unread": len(outlook_mails) + len(uni_mails)
    })


async def api_calendar(request):
    """Get upcoming calendar events."""
    days = request.query.get("days", "7")
    raw = await _run_script([
        sys.executable, str(SCRIPTS_DIR / "icloud-calendar.py"),
        "list-events", "--days", days, "--json"
    ], timeout=30)
    try:
        events = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        events = []
    return web.json_response({"events": events, "days": int(days)})


async def api_quick_action(request):
    """Unified quick-action endpoint: Anki card / Email / Calendar event.
    POST body: {"type": "anki|email|calendar", ...params}
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

    action_type = (data.get("type") or "").lower()

    if action_type == "anki":
        deck = (data.get("deck") or "Default").strip()
        front = (data.get("front") or "").strip()
        back = (data.get("back") or "").strip()
        tags = data.get("tags") or []
        if not front or not back:
            return web.json_response({"ok": False, "error": "front/back required"}, status=400)
        payload = {
            "action": "addNote",
            "version": 6,
            "params": {"note": {
                "deckName": deck,
                "modelName": "Basic",
                "fields": {"Front": front, "Back": back},
                "tags": tags if isinstance(tags, list) else [str(tags)],
                "options": {"allowDuplicate": False},
            }},
        }
        try:
            import urllib.request
            req = urllib.request.Request(
                "http://localhost:8765",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=get_action_timeout("anki.quick")) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            if result.get("error"):
                return web.json_response({"ok": False, "error": result["error"]}, status=500)
            return web.json_response({"ok": True, "note_id": result.get("result"), "deck": deck})
        except Exception as e:
            return web.json_response({"ok": False, "error": f"anki_unreachable: {e}"}, status=500)

    elif action_type == "email":
        to = (data.get("to") or "").strip()
        subject = (data.get("subject") or "").strip()
        body = (data.get("body") or "").strip()
        if not to:
            return web.json_response({"ok": False, "error": "to required"}, status=400)
        # write body to tmp file to avoid shell escaping issues
        import tempfile
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".txt") as f:
            f.write(body)
            body_path = f.name
        try:
            out = await _run_script([
                sys.executable, str(SCRIPTS_DIR / "outlook_graph.py"), "send",
                "--to", to, "--subject", subject, "--body-file", body_path,
            ], timeout=get_action_timeout("email.send"))
        finally:
            try: os.unlink(body_path)
            except Exception: pass
        ok = "OK" in (out or "")
        return web.json_response({"ok": ok, "output": out})

    elif action_type == "calendar":
        title = (data.get("title") or "").strip()
        start = (data.get("start") or "").strip()  # ISO string
        duration = int(data.get("duration") or 60)
        location = (data.get("location") or "").strip()
        description = (data.get("description") or "").strip()
        if not title or not start:
            return web.json_response({"ok": False, "error": "title/start required"}, status=400)
        cmd = [
            sys.executable, str(SCRIPTS_DIR / "icloud-calendar.py"), "create-event",
            "--title", title, "--start", start, "--duration", str(duration),
        ]
        if location: cmd += ["--location", location]
        if description: cmd += ["--description", description]
        out = await _run_script(cmd, timeout=get_action_timeout("calendar.create"))
        ok = "error" not in (out or "").lower() and "traceback" not in (out or "").lower()
        return web.json_response({"ok": ok, "output": out})

    return web.json_response({"ok": False, "error": f"unknown type: {action_type}"}, status=400)


async def api_system(request):
    """Get system status: scheduled tasks, bridge, heartbeat."""
    result = {"tasks": [], "bridge": {}, "heartbeat": {}, "telegram": {}}

    # Heartbeat state
    hb = JARVIS_DATA / "heartbeat-state.json"
    if hb.exists():
        try:
            result["heartbeat"] = json.loads(hb.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Telegram bridge state
    lock = JARVIS_DATA / "telegram-bridge.lock"
    result["bridge"]["running"] = lock.exists()
    tg_state = JARVIS_DATA / "telegram-state.json"
    if tg_state.exists():
        try:
            result["telegram"] = json.loads(tg_state.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Memory sync state
    sync = JARVIS_DATA / "memory-sync-state.json"
    if sync.exists():
        try:
            result["memory_sync"] = json.loads(sync.read_text(encoding="utf-8"))
        except Exception:
            pass

    return web.json_response(result)



# ---------------------------------------------------------------------------
# RAG — Semantic search over Obsidian Vault + Dissertation
# ---------------------------------------------------------------------------

def _rag_available() -> bool:
    try:
        from rag.search import stats
        return True
    except Exception:
        return False


async def api_rag_search(request):
    """POST /api/rag/search  {query, n_results?, type?}"""
    try:
        body = await request.json()
        q = (body.get("query") or "").strip()
        if not q:
            return web.json_response({"error": "query required"}, status=400)
        n = int(body.get("n_results", 5))
        src_type = body.get("type")  # "markdown" | "pdf" | None

        import asyncio
        from rag.search import query as rag_query
        loop = asyncio.get_event_loop()
        hits = await loop.run_in_executor(None, lambda: rag_query(q, n, src_type))
        return web.json_response({"results": hits})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_rag_status(request):
    """GET /api/rag/status"""
    try:
        from rag.search import stats
        import asyncio
        loop = asyncio.get_event_loop()
        s = await loop.run_in_executor(None, stats)
        return web.json_response({"ok": True, **s})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def api_rag_reindex(request):
    """POST /api/rag/reindex  {force?}"""
    try:
        body = await request.json() if request.content_length else {}
        force = bool(body.get("force", False))
        import asyncio
        from rag.ingest import build_index
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: build_index(force=force))
        return web.json_response({"ok": True, **result})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def api_rag_reload(request):
    """POST /api/rag/reload  -  Invalidate in-process Chroma singleton and reload stats."""
    try:
        import asyncio
        import sys
        # Ensure rag package is loaded first
        from rag import store as store_mod
        from rag.search import stats
        # Reset singletons so next call opens a fresh PersistentClient
        with store_mod._lock:
            store_mod._client = None
            store_mod._collection = None
        loop = asyncio.get_event_loop()
        s = await loop.run_in_executor(None, stats)
        print(f"[RAG] Singleton reloaded: {s['total_chunks']} chunks")
        return web.json_response({"ok": True, "reloaded": True, **s})
    except Exception as e:
        import traceback
        return web.json_response({"ok": False, "error": str(e), "trace": traceback.format_exc()}, status=500)


async def api_system_restart(request):
    """POST /api/system/restart  -  Trigger detached MC restart via watcher.

    Creates data/restart.trigger file. The restart_watcher.py process monitors
    this file and kills/restarts MC without blocking the chat session.
    """
    try:
        trigger_file = DATA_DIR / "restart.trigger"
        trigger_file.write_text(f"restart at {datetime.now().isoformat()}")
        print(f"[System] Restart triggered via {trigger_file}")
        return web.json_response({
            "ok": True,
            "message": "Restart triggered. Watcher will restart MC in ~2-3 seconds.",
            "trigger_file": str(trigger_file),
        })
    except Exception as e:
        print(f"[System] Restart trigger failed: {e}")
        return web.json_response({
            "ok": False,
            "error": str(e),
        }, status=500)


async def api_bots(request):
    """Get all cron jobs (Windows Scheduled Tasks) + active bot/session status."""
    import subprocess

    result = {
        "cron_jobs": [],
        "services": [],
        "mc_sessions": [],
    }

    # ? Windows Scheduled Tasks ?
    try:
        ps = (
            "$tasks = Get-ScheduledTask | Where-Object {$_.TaskName -match 'Jarvis|Mission Control|Telegram|Claude|Token|Dream|Trading|Bridge' -and $_.TaskPath -notmatch 'Microsoft'};"
            "$tasks | ForEach-Object {"
            "  $info = $_ | Get-ScheduledTaskInfo;"
            "  [PSCustomObject]@{"
            "    TaskName    = $_.TaskName;"
            "    State       = [int]$_.State;"
            "    Description = $_.Description;"
            "    LastRun     = if($info.LastRunTime -gt [DateTime]'2000-01-01'){$info.LastRunTime.ToString('o')}else{$null};"
            "    NextRun     = if($info.NextRunTime -gt [DateTime]'2000-01-01'){$info.NextRunTime.ToString('o')}else{$null};"
            "  }"
            "} | ConvertTo-Json -Compress"
        )
        proc = subprocess.run(
            ["powershell", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=10,
            **_SUBPROCESS_FLAGS,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            raw = json.loads(proc.stdout.strip())
            if isinstance(raw, dict):
                raw = [raw]
            STATE_MAP = {0: "unknown", 1: "disabled", 2: "queued", 3: "ready", 4: "running"}
            for t in raw:
                state_num = t.get("State", 0)
                state = STATE_MAP.get(state_num, str(state_num))
                # parse timestamps
                def _fmt(ts):
                    if not ts:
                        return None
                    try:
                        from datetime import timezone
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if dt.year < 2000:
                            return None
                        return dt.strftime("%Y-%m-%d %H:%M")
                    except Exception:
                        return None
                result["cron_jobs"].append({
                    "name": t.get("TaskName", ""),
                    "state": state,
                    "last_run": _fmt(t.get("LastRun")),
                    "next_run": _fmt(t.get("NextRun")),
                    "description": t.get("Description") or "",
                })
    except Exception as e:
        result["cron_jobs_error"] = str(e)

    # ? Running Services / Bots ?
    services = []

    # Mission Control (this server)
    services.append({"name": "Mission Control", "type": "server", "status": "running",
                     "detail": "Port 8090", "icon": "✅"})

    # Telegram Bridge
    lock = JARVIS_DATA / "telegram-bridge.lock"
    tg_running = lock.exists()
    tg_state = {}
    tg_state_file = JARVIS_DATA / "telegram-state.json"
    if tg_state_file.exists():
        try:
            tg_state = json.loads(tg_state_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    services.append({
        "name": "Telegram Bridge",
        "type": "bot",
        "status": "running" if tg_running else "stopped",
        "detail": f"@RobinMandels_Jarvis_bot" + (f" · {tg_state.get('last_msg_time','')}" if tg_state.get('last_msg_time') else ""),
        "icon": "⚙",
    })

    # Trading Bot (Port 8080)
    try:
        import socket
        s = socket.socket()
        s.settimeout(0.5)
        s.connect(("127.0.0.1", 8080))
        s.close()
        trading_running = True
    except Exception:
        trading_running = False
    services.append({
        "name": "Trading Bot Engine",
        "type": "bot",
        "status": "running" if trading_running else "stopped",
        "detail": "Port 8080",
        "icon": "📈",
    })

    # Night Research cron last result
    night_dir = JARVIS_DATA / "night-results"
    night_last = None
    if night_dir.exists():
        files = sorted(night_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
        if files:
            night_last = files[0].name
    services.append({
        "name": "Nacht-Recherche",
        "type": "cron",
        "status": "scheduled",
        "detail": f"Letztes Ergebnis: {night_last}" if night_last else "Noch kein Ergebnis",
        "icon": "🔬",
    })

    # Memory Sync
    sync_state = {}
    sync_file = JARVIS_DATA / "memory-sync-state.json"
    if sync_file.exists():
        try:
            sync_state = json.loads(sync_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    services.append({
        "name": "Memory Sync",
        "type": "cron",
        "status": "scheduled",
        "detail": f"Letzter Sync: {sync_state.get('last_sync', '?')}",
        "icon": "🧠",
    })

    # RAG Index
    rag_manifest = JARVIS_DATA.parent / "chroma" / "files.json"
    rag_detail = "Nicht indexiert"
    rag_status = "stopped"
    if rag_manifest.exists():
        try:
            m = json.loads(rag_manifest.read_text(encoding="utf-8"))
            n_files = len(m)
            mtime = datetime.fromtimestamp(rag_manifest.stat().st_mtime).strftime("%d.%m. %H:%M")
            rag_detail = f"{n_files} Dateien · Stand {mtime}"
            rag_status = "running"
        except Exception:
            pass
    services.append({
        "name": "RAG Index",
        "type": "cron",
        "status": rag_status,
        "detail": rag_detail,
        "icon": "🔍",
    })

    result["services"] = services

    # ? MC Chat Sessions ?
    result["mc_sessions"] = sessions.list_sessions()

    return web.json_response(result)


async def api_bots_diss_research(request):
    """Return all night-research results for the Diss-Recherche bot detail view."""
    night_dir = JARVIS_DATA / "night-results"
    results = []
    if night_dir.exists():
        for f in sorted(night_dir.glob("*-diss-recherche.json"), reverse=True):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                results.append(data)
            except Exception:
                pass
    # Aggregate: all unique papers across all runs, deduplicated by doi/title
    seen = set()
    all_papers = []
    for run in results:
        for item in run.get("items", []):
            key = item.get("doi") or item.get("title", "")
            if key and key not in seen:
                seen.add(key)
                all_papers.append({**item, "run_date": run.get("date")})
    # Sort by stars desc
    all_papers.sort(key=lambda p: p.get("stars", 0), reverse=True)
    return web.json_response({
        "runs": results,
        "all_papers": all_papers,
        "total_papers": len(all_papers),
        "total_runs": len(results),
    })


async def api_knowledge_graph(request):
    """Scan Jarvis-Memory and Jarvis-Knowledge for nodes and wikilinks."""
    import re
    OBSIDIAN_BASE = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain")
    scan_dirs = [
        ("daily",     OBSIDIAN_BASE / "Jarvis-Memory"),
        ("knowledge", OBSIDIAN_BASE / "Jarvis-Knowledge"),
        ("knowledge", OBSIDIAN_BASE),                          # root-level .md files
        ("knowledge", OBSIDIAN_BASE / "ChatGPT-Import" / "_Hubs"),  # ChatGPT hub pages
    ]
    CLAUDE_CODE_START = "2026-04-10"
    META_NAMES = {
        "SOUL.md", "identity.md", "robin.md", "decisions.md",
        "projects.md", "todos.md", "inbox.md", "failsafe.md",
        "INDEX.md", "README.md",
    }
    wikilink_re = re.compile(r'\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]')

    nodes = []
    links = []
    seen_nodes = set()

    for default_type, folder in scan_dirs:
        if not folder.exists():
            continue
        # Root vault dir: only direct files (not recursive, to avoid double-scanning subdirs)
        use_glob = (folder == OBSIDIAN_BASE)
        for f in (folder.glob("*.md") if use_glob else folder.rglob("*.md")):
            name = f.stem  # node id = filename without .md
            size = f.stat().st_size

            # Determine type
            if f.name in META_NAMES:
                ntype = "meta"
            elif f.name[:4].isdigit() and len(f.name) == 13:
                ntype = "daily"
            else:
                ntype = default_type

            if name not in seen_nodes:
                seen_nodes.add(name)
                nodes.append({"id": name, "type": ntype, "size": size})

            # Extract wikilinks
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for target in wikilink_re.findall(text):
                target = target.strip()
                if target and target != name:
                    links.append({"source": name, "target": target})
                    # Ensure target node exists (may be in another folder)
                    if target not in seen_nodes:
                        seen_nodes.add(target)
                        nodes.append({"id": target, "type": "knowledge", "size": 0})

    return web.json_response({"nodes": nodes, "links": links})


# ---------------------------------------------------------------------------
# Smart Tasks  -  Claude CLI Worker Queue
# ---------------------------------------------------------------------------

SMART_TASKS_FILE = Path("C:/Users/Robin/Jarvis/data/smart-tasks.json")
CLAUDE_EXE = r"C:\Users\Robin\.local\bin\claude.exe"

# Timeouts (seconds) pro Action-Typ fuer Bot-Orchestrierung.
# Zentrale Quelle — jede neue Action hier eintragen statt Magic-Numbers im Code.
# Greift automatisch via get_action_timeout() und api_quick_action.
ACTION_TIMEOUTS: dict = {
    # Quick-Actions (api_quick_action)
    "anki.quick":        15,   # AnkiConnect HTTP call
    "email.send":        45,   # outlook_graph.py send
    "calendar.create":   45,   # icloud-calendar.py create-event
    # LLM-basierte Generatoren
    "anki.generate":     240,  # anki-from-text.py (Claude-subprocess drin)
    "lernplan.generate": 240,  # lernplan-generator.py
    # Bot-Orchestrierung
    "smart_task.run":    900,  # voller claude -p run (hartes Limit)
    "arena.turn":        180,  # ein Bot-Turn in einer Arena-Diskussion
    "claude.bg":         600,  # generischer Claude-Background-Run
    # Fallback
    "_default":          30,
}


def get_action_timeout(name: str, default: int | None = None) -> int:
    """Liefert Timeout (s) fuer eine Action. Fallback: ACTION_TIMEOUTS['_default']."""
    if name in ACTION_TIMEOUTS:
        return int(ACTION_TIMEOUTS[name])
    if default is not None:
        return int(default)
    return int(ACTION_TIMEOUTS.get("_default", 30))

# Dict of running subprocesses: task_id -> asyncio.subprocess.Process
_running_tasks: dict = {}


_smart_tasks_lock = asyncio.Lock() if hasattr(asyncio, 'Lock') else None

def _load_smart_tasks() -> list:
    return safe_read_json(SMART_TASKS_FILE, default=[]) or []


def _save_smart_tasks(tasks: list):
    atomic_write_text(SMART_TASKS_FILE, json.dumps(tasks, ensure_ascii=False, indent=2))


def _update_task_field(task_id: str, **fields):
    """Thread-safe update of a single task's fields."""
    tasks = _load_smart_tasks()
    for t in tasks:
        if t["id"] == task_id:
            t.update(fields)
            break
    _save_smart_tasks(tasks)


def _find_task(tasks: list, task_id: str):
    for t in tasks:
        if t["id"] == task_id:
            return t
    return None


# ── Task Sizer ────────────────────────────────────────────────────────────────

_SIZE_LARGE_KEYWORDS = {
    "refactor", "refaktoriere", "implementiere", "implementier", "baue", "build",
    "erstelle", "create", "system", "architektur", "migration", "migriere",
    "redesign", "komplett", "vollständig", "umstrukturiere", "pipeline",
    "framework", "integration", "scraper", "crawler", "dashboard", "analyse",
    "analyze", "research", "recherche", "alle", "multiple", "several",
}
_SIZE_SMALL_KEYWORDS = {
    "zeig", "show", "liste", "list", "check", "prüf", "was", "what",
    "wann", "when", "wie viel", "how many", "status", "get", "find",
    "such", "öffne", "open", "schreib kurz", "kurze", "quick", "fix",
    "fixe", "korrigiere", "rename", "umbenennen", "delete", "lösch",
}

def classify_task_size(title: str, description: str = "") -> dict:
    """Heuristic classifier: returns size (small/medium/large) with confidence and reason."""
    combined = f"{title} {description}".lower().strip()
    word_count = len(combined.split())

    score = 0  # negative = small, positive = large

    # Length signals
    if word_count <= 8:
        score -= 2
    elif word_count <= 20:
        score -= 1
    elif word_count >= 40:
        score += 2
    elif word_count >= 25:
        score += 1

    # Keyword signals
    for kw in _SIZE_LARGE_KEYWORDS:
        if kw in combined:
            score += 2
            break
    for kw in _SIZE_SMALL_KEYWORDS:
        if kw in combined:
            score -= 2
            break

    # Multi-step signals
    step_markers = combined.count("\n") + combined.count("- ") + combined.count(". ")
    multi_keywords = ["außerdem", "zusätzlich", "dann", "anschließend", "danach", "furthermore"]
    step_markers += sum(1 for mk in multi_keywords if mk in combined)
    if step_markers >= 4:
        score += 2
    elif step_markers >= 2:
        score += 1

    # File/path mentions suggest real work
    if "/" in combined or "\\" in combined or ".py" in combined or ".js" in combined:
        score += 1

    if score <= -2:
        size, reason = "small", "Kurze/einfache Anfrage, einzelne Aktion"
    elif score <= 1:
        size, reason = "medium", "Mehrstufige Anfrage mit klarem Scope"
    else:
        size, reason = "large", "Komplexe Aufgabe, viele Schritte oder System-Level"

    return {"size": size, "score": score, "reason": reason, "word_count": word_count}


async def api_smart_tasks_size(request):
    """POST /api/smart-tasks/size  -  Klassifiziert einen Task als small/medium/large."""
    body = await request.json()
    title = body.get("title", "")
    description = body.get("description", "")
    result = classify_task_size(title, description)
    return web.json_response(result)


async def api_smart_tasks_list(request):
    """GET /api/smart-tasks  -  Liste aller Tasks."""
    tasks = _load_smart_tasks()
    return web.json_response(tasks)


async def api_smart_tasks_create(request):
    """POST /api/smart-tasks  -  Neuen Task erstellen."""
    body = await request.json()
    task = {
        "id": str(uuid.uuid4()),
        "title": body.get("title", "Unbenannter Task"),
        "description": body.get("description", ""),
        "original_request": body.get("original_request", ""),
        "chat_context": body.get("chat_context", ""),
        "priority": body.get("priority", "medium"),
        "status": "pending",
        "created": datetime.now().isoformat(),
        "started": None,
        "completed": None,
        "output": "",
        "error": "",
    }
    sizing = classify_task_size(task["title"], task["description"])
    task["size"] = sizing["size"]
    task["size_reason"] = sizing["reason"]
    tasks = _load_smart_tasks()
    tasks.append(task)
    _save_smart_tasks(tasks)
    return web.json_response(task, status=201)


async def _run_smart_task(task_id: str):
    """Startet claude -p als Subprocess mit vollem Jarvis-Kontext."""
    tasks = _load_smart_tasks()
    task = _find_task(tasks, task_id)
    if not task:
        return

    task["status"] = "running"
    task["started"] = datetime.now().isoformat()
    task["output"] = ""
    task["error"] = ""
    _save_smart_tasks(tasks)

    desc = task.get('description', '') or ''
    original = task.get('original_request', '') or ''
    chat_context = task.get('chat_context', '') or ''

    # Build rich prompt with full context
    context_parts = [f"# Aufgabe: {task['title']}"]
    if original:
        context_parts.append(f"\n## Original-Anfrage\n{original}")
    if desc:
        context_parts.append(f"\n## Beschreibung\n{desc}")
    if chat_context:
        context_parts.append(f"\n## Chat-Kontext (letzte Nachrichten)\n{chat_context}")
    context_parts.append(
        "\n## Anweisungen"
        "\n- Fuehre diese Aufgabe Schritt fuer Schritt aus."
        "\n- Lies zuerst CLAUDE.md fuer Projektkontext und Regeln."
        "\n- Wenn die Aufgabe Code/Scripts beinhaltet: schreibe die Dateien direkt."
        "\n- Pruefe dein Ergebnis bevor du es als fertig meldest."
        "\n- Antworte am Ende mit einer kurzen Zusammenfassung was du gemacht hast."
        "\n- Sprache: Deutsch."
    )
    prompt = "\n".join(context_parts)

    cmd = [
        CLAUDE_EXE,
        "-p", prompt,
        "--output-format", "text",
        "--max-turns", "25",
    ]

    # (encoding-fixed) print(f"[SmartTask] Start: {task_id[:8]} €" {task['title'][:50]}")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        _running_tasks[task_id] = proc

        # Use communicate()  -  text format buffers everything until done
        _st_timeout = get_action_timeout("smart_task.run")
        try:
            stdout_data, stderr_data = await asyncio.wait_for(
                proc.communicate(), timeout=_st_timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            _update_task_field(task_id,
                status="error", error=f"Timeout nach {_st_timeout}s",
                output="", completed=datetime.now().isoformat())
            _running_tasks.pop(task_id, None)
            return

        full_output = stdout_data.decode("utf-8", errors="replace").strip()
        stderr_text = stderr_data.decode("utf-8", errors="replace").strip()

        if proc.returncode == 0:
            _update_task_field(task_id,
                status="done", output=full_output or "(Kein Output)",
                error="", completed=datetime.now().isoformat())
        else:
            _update_task_field(task_id,
                status="error", output=full_output,
                error=stderr_text or f"Exit code {proc.returncode}",
                completed=datetime.now().isoformat())

        # (encoding-fixed) print(f"[SmartTask] Done: {task_id[:8]} €" exit={proc.returncode}")

    except Exception as e:
        # (encoding-fixed) print(f"[SmartTask] Error: {task_id[:8]} €" {e}")
        _update_task_field(task_id,
            status="error", error=str(e),
            completed=datetime.now().isoformat())
    finally:
        _running_tasks.pop(task_id, None)


async def api_smart_tasks_start(request):
    """POST /api/smart-tasks/{id}/start  -  Task starten."""
    task_id = request.match_info["id"]
    tasks = _load_smart_tasks()
    task = _find_task(tasks, task_id)
    if not task:
        raise web.HTTPNotFound(reason="Task nicht gefunden")
    if task["status"] == "running":
        return web.json_response({"ok": False, "error": "Task laeuft bereits"}, status=409)

    # Reset für Neustart
    task["status"] = "pending"
    _save_smart_tasks(tasks)

    asyncio.create_task(_run_smart_task(task_id))
    return web.json_response({"ok": True, "task_id": task_id})


async def api_smart_tasks_get(request):
    """GET /api/smart-tasks/{id}  -  Task-Status + Output."""
    task_id = request.match_info["id"]
    tasks = _load_smart_tasks()
    task = _find_task(tasks, task_id)
    if not task:
        raise web.HTTPNotFound(reason="Task nicht gefunden")
    return web.json_response(task)


async def api_smart_tasks_delete(request):
    """DELETE /api/smart-tasks/{id}  -  Task löschen."""
    task_id = request.match_info["id"]
    # Laufenden Prozess abbrechen falls vorhanden
    proc = _running_tasks.get(task_id)
    if proc and proc.returncode is None:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except asyncio.TimeoutError:
            proc.kill()
        _running_tasks.pop(task_id, None)

    tasks = _load_smart_tasks()
    new_tasks = [t for t in tasks if t["id"] != task_id]
    if len(new_tasks) == len(tasks):
        raise web.HTTPNotFound(reason="Task nicht gefunden")
    _save_smart_tasks(new_tasks)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Roadmap / projects.md Endpoints
# ---------------------------------------------------------------------------

PROJECTS_MD_PATH = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory/projects.md")


def _item_id(text: str) -> str:
    """Stabiler Hash aus Item-Text (8 Hex-Zeichen)."""
    import hashlib, unicodedata
    normalized = unicodedata.normalize("NFC", text.strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]


def _parse_projects_md() -> dict:
    """Parst projects.md und gibt strukturiertes JSON zurück."""
    import re
    if not PROJECTS_MD_PATH.exists():
        return {"categories": [], "stats": {"total": 0, "done": 0, "open": 0, "percent": 0}}

    text = PROJECTS_MD_PATH.read_text(encoding="utf-8")
    lines = text.splitlines()

    categories = []
    current_cat = None

    for line in lines:
        # Kategorie-Überschrift: ## 1. Titel
        m = re.match(r'^##\s+(.+)', line)
        if m:
            current_cat = {"name": m.group(1).strip(), "items": []}
            categories.append(current_cat)
            continue

        if current_cat is None:
            continue

        # Item mit ✅ oder ⬜
        m_done = re.match(r'^\s*-\s+✅\s+(.+)', line)
        m_open = re.match(r'^\s*-\s+⬜\s+(.+)', line)

        if m_done:
            txt = m_done.group(1).strip()
            current_cat["items"].append({
                "id": _item_id(txt),
                "text": txt,
                "done": True,
            })
        elif m_open:
            txt = m_open.group(1).strip()
            current_cat["items"].append({
                "id": _item_id(txt),
                "text": txt,
                "done": False,
            })

    total = sum(len(c["items"]) for c in categories)
    done  = sum(sum(1 for i in c["items"] if i["done"]) for c in categories)
    open_ = total - done
    pct   = round(done / total * 100) if total else 0

    return {
        "categories": categories,
        "stats": {"total": total, "done": done, "open": open_, "percent": pct},
    }


def _find_roadmap_item(item_id: str):
    """Gibt (kategorie_name, item_dict) zurück oder (None, None)."""
    data = _parse_projects_md()
    for cat in data["categories"]:
        for item in cat["items"]:
            if item["id"] == item_id:
                return cat["name"], item
    return None, None


async def api_roadmap_get(request):
    """GET /api/roadmap  -  Parst projects.md, gibt JSON zurück."""
    return web.json_response(_parse_projects_md())


async def api_roadmap_toggle(request):
    """POST /api/roadmap/{id}/toggle  -  Togglet ✅/â¬œ in projects.md."""
    item_id = request.match_info["id"]
    _, item = _find_roadmap_item(item_id)
    if not item:
        raise web.HTTPNotFound(reason="Item nicht gefunden")

    text = PROJECTS_MD_PATH.read_text(encoding="utf-8")
    import re

    item_text_escaped = re.escape(item["text"])
    if item["done"]:
        # ✅ â†' â¬œ
        pattern = r'(- )✅( ' + item_text_escaped + r')'
        replacement = r'\1⬜\2'
    else:
        # â¬œ â†' ✅
        pattern = r'(- )⬜( ' + item_text_escaped + r')'
        replacement = r'\1✅\2'

    new_text = re.sub(pattern, replacement, text, count=1)
    if new_text == text:
        return web.json_response({"ok": False, "error": "Kein Match gefunden"}, status=400)

    PROJECTS_MD_PATH.write_text(new_text, encoding="utf-8")
    return web.json_response({"ok": True, "done": not item["done"]})


async def api_roadmap_build(request):
    """POST /api/roadmap/{id}/build  -  Erstellt Smart-Task für Item und startet ihn."""
    item_id = request.match_info["id"]
    cat_name, item = _find_roadmap_item(item_id)
    if not item:
        raise web.HTTPNotFound(reason="Item nicht gefunden")
    if item["done"]:
        return web.json_response({"ok": False, "error": "Item ist bereits erledigt"}, status=400)

    # Check if there's an original request stored for this item
    context_file = JARVIS_DATA / "roadmap-context.json"
    original_request = ""
    if context_file.exists():
        try:
            ctx = json.loads(context_file.read_text(encoding="utf-8"))
            original_request = ctx.get(item_id, "")
        except Exception:
            pass

    # Smart-Task erstellen
    task = {
        "id": str(uuid.uuid4()),
        "title": item["text"],
        "description": (
            f"Jarvis-Roadmap Item aus Kategorie '{cat_name}'.\n"
            f"Baue / implementiere: {item['text']}"
        ),
        "original_request": original_request,
        "priority": "high",
        "status": "pending",
        "created": datetime.now().isoformat(),
        "started": None,
        "completed": None,
        "output": "",
        "error": "",
        "roadmap_id": item_id,
    }
    tasks = _load_smart_tasks()
    tasks.append(task)
    _save_smart_tasks(tasks)

    # Direkt starten
    asyncio.create_task(_run_smart_task(task["id"]))

    return web.json_response({"ok": True, "task_id": task["id"]}, status=201)


async def api_roadmap_suggest(request):
    """POST /api/roadmap/suggest  -  Idee -> Claude -> Items in projects.md einfügen."""
    import re
    import subprocess

    body = await request.json()
    message = body.get("message", "").strip()
    if not message:
        raise web.HTTPBadRequest(reason="message darf nicht leer sein")

    prompt = (
        f'Du bist Jarvis. Robin hat eine Idee fuer ein neues Feature:\n'
        f'"{message}"\n\n'
        f'Wandle das in 1-3 konkrete, umsetzbare Todo-Items um.\n'
        f'Bestimme fuer jedes Item die passende Kategorie aus dieser Liste:\n'
        f'1. Grundsystem & Identitaet\n'
        f'2. Gedaechtnis & Selbstverbesserung\n'
        f'3. Heartbeats & Cronjobs\n'
        f'4. Modelle & Routing\n'
        f'5. Skills\n'
        f'6. Agents\n'
        f'7. Kommunikation\n'
        f'8. Email & Kalender\n'
        f'9. Studium & Forschung\n'
        f'10. Mission Control\n'
        f'11. Trading\n'
        f'12. Infrastruktur\n'
        f'13. Medien-KI\n\n'
        f'Antworte NUR als JSON Array:\n'
        f'[{{"category": "3. Heartbeats & Cronjobs", "text": "Morning Briefing per Telegram"}}]'
    )

    print(f"[RoadmapSuggest] Calling Claude for: {message[:60]}")
    try:
        result = subprocess.run(
            [CLAUDE_EXE, "-p", prompt, "--output-format", "json",
             "--max-turns", "1",
             "--system-prompt", "Antworte NUR als JSON Array. Keine Tools nutzen.",
             "--disallowed-tools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
            timeout=90,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        raw_output = result.stdout.strip()
        print(f"[RoadmapSuggest] Raw output ({len(raw_output)} bytes)")
    except subprocess.TimeoutExpired:
        raise web.HTTPInternalServerError(reason="Claude Timeout (90s)")
    except Exception as e:
        raise web.HTTPInternalServerError(reason=f"Claude Fehler: {e}")

    # Parse Claude JSON envelope
    try:
        envelope = json.loads(raw_output)
        inner = envelope.get("result", raw_output)
    except json.JSONDecodeError:
        inner = raw_output

    # Extract JSON array from response (might be wrapped in markdown or extra text)
    # Try multiple strategies
    items = None
    # Strategy 1: direct parse
    try:
        parsed = json.loads(inner)
        if isinstance(parsed, list):
            items = parsed
    except (json.JSONDecodeError, TypeError):
        pass

    # Strategy 2: find array with bracket matching
    if items is None:
        start = inner.find('[')
        if start >= 0:
            depth = 0
            end = start
            for i, ch in enumerate(inner[start:], start):
                if ch == '[': depth += 1
                elif ch == ']': depth -= 1
                if depth == 0:
                    end = i + 1
                    break
            try:
                items = json.loads(inner[start:end])
            except json.JSONDecodeError:
                pass

    if not items or not isinstance(items, list):
        raise web.HTTPInternalServerError(reason=f"Kein JSON-Array in Antwort: {inner[:200]}")

    if not PROJECTS_MD_PATH.exists():
        raise web.HTTPInternalServerError(reason="projects.md nicht gefunden")

    text = PROJECTS_MD_PATH.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    inserted = []

    for item in items:
        cat_name = item.get("category", "").strip()
        item_text = item.get("text", "").strip()
        if not item_text or not cat_name:
            continue

        # Find the category header line
        # Match: ## <number>. <rest> or ## <cat_name> exactly
        cat_number = cat_name.split(".")[0].strip() if "." in cat_name else ""
        cat_rest   = cat_name.split(".", 1)[1].strip() if "." in cat_name else cat_name

        insert_idx = None
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("##"):
                header = stripped.lstrip("#").strip()
                # Match by full name or by number prefix
                if header == cat_name or header.startswith(cat_number + "."):
                    # Find end of this category's block (next ## or EOF)
                    j = i + 1
                    while j < len(lines):
                        if lines[j].strip().startswith("##"):
                            break
                        j += 1
                    # Insert before next category or at end of file
                    insert_idx = j
                    break

        if insert_idx is None:
            # Category not found  -  append at end
            insert_idx = len(lines)

        new_line = f"- ⬜ {item_text}\n"
        lines.insert(insert_idx, new_line)
        inserted.append({
            "category": cat_name,
            "text": item_text,
            "id": _item_id(item_text),
            "original_request": message,  # Preserve Robin's original input
        })
        print(f"[RoadmapSuggest] Inserted '{item_text}' into '{cat_name}' at line {insert_idx}")

    PROJECTS_MD_PATH.write_text("".join(lines), encoding="utf-8")

    # Save original request context for each item (so Build knows what Robin wanted)
    context_file = JARVIS_DATA / "roadmap-context.json"
    ctx = {}
    if context_file.exists():
        try:
            ctx = json.loads(context_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    for item in inserted:
        ctx[item["id"]] = message
    context_file.write_text(json.dumps(ctx, ensure_ascii=False, indent=2), encoding="utf-8")

    return web.json_response({"ok": True, "inserted": inserted})


async def api_diss_research(request):
    """Get night research results for dissertation."""
    night_dir = JARVIS_DATA / "night-results"
    results = []
    if night_dir.exists():
        for f in sorted(night_dir.glob("*diss*"), reverse=True)[:5]:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    results.append({
                        "date": f.stem.split("-diss")[0],
                        "takeaway": data.get("takeaway", ""),
                        "papers": data.get("papers", []),
                    })
                else:
                    results.append({"date": f.stem, "takeaway": str(data)[:200]})
            except Exception:
                pass
    return web.json_response({"results": results})


DISS_WIKI_DIR = Path("E:/OneDrive/Dokumente/Studium/!!Medizin/03 Doktorarbeit/ITI/Jarvis Workspace/wiki")
DISS_SESSION_TOPIC_FILE = JARVIS_DATA / "diss-session-topic.json"


async def api_diss_session_topic(request):
    """GET/POST current dissertation session topic."""
    if request.method == "POST":
        data = await request.json()
        DISS_SESSION_TOPIC_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return web.json_response({"ok": True})
    if DISS_SESSION_TOPIC_FILE.exists():
        return web.json_response(json.loads(DISS_SESSION_TOPIC_FILE.read_text(encoding="utf-8")))
    return web.json_response({"topic": "", "date": ""})


async def api_diss_wiki_log(request):
    """GET recent wiki log entries."""
    log_file = DISS_WIKI_DIR / "log.md"
    if not log_file.exists():
        return web.json_response({"entries": []})
    content = log_file.read_text(encoding="utf-8")
    entries = []
    current = None
    for line in content.split("\n"):
        if line.startswith("## ["):
            if current:
                entries.append(current)
            current = {"header": line[3:].strip(), "body": ""}
        elif current and line.strip():
            current["body"] += line.strip() + " "
    if current:
        entries.append(current)
    return web.json_response({"entries": entries[:8]})


MEDIZIN_LOG_FILE = Path("C:/Users/Robin/Jarvis/data/medizin-log.json")

async def api_medizin_log(request):
    """GET or POST Medizin knowledge log entries."""
    if request.method == "POST":
        try:
            data = await request.json()
            entries = []
            if MEDIZIN_LOG_FILE.exists():
                entries = json.loads(MEDIZIN_LOG_FILE.read_text(encoding="utf-8"))
            entries.insert(0, {
                "title":   data.get("title", "Unbenannt"),
                "type":    data.get("type", "sonstiges"),
                "preview": data.get("preview", ""),
                "ts":      data.get("ts", ""),
            })
            # Keep last 200 entries
            entries = entries[:200]
            MEDIZIN_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            MEDIZIN_LOG_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
    else:
        if not MEDIZIN_LOG_FILE.exists():
            return web.json_response({"entries": []})
        try:
            entries = json.loads(MEDIZIN_LOG_FILE.read_text(encoding="utf-8"))
            return web.json_response({"entries": entries})
        except Exception:
            return web.json_response({"entries": []})


async def api_anki_generate(request):
    """POST /api/anki/generate — Erzeugt Anki-Karten aus Vorlesungstext.
    Body: { text, deck?, title?, tags? }
    Ruft scripts/anki-from-text.py auf (Claude CLI + AnkiConnect)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

    text = (body.get("text") or "").strip()
    if not text:
        return web.json_response({"ok": False, "error": "text ist leer"}, status=400)

    deck = body.get("deck") or "Medizin::Sem8::Auto"
    title = body.get("title") or ""
    tags = body.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]

    script = Path("C:/Users/Robin/Jarvis/scripts/anki-from-text.py")
    if not script.exists():
        return web.json_response({"ok": False, "error": f"Script fehlt: {script}"}, status=500)

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(script),
            "--deck", deck,
            "--title", title,
            "--tags", ",".join(tags),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(text.encode("utf-8")),
            timeout=get_action_timeout("anki.generate"),
        )
        out = stdout.decode("utf-8", errors="replace").strip()
        # Script printet JSON auf stdout
        try:
            result = json.loads(out)
        except Exception:
            result = {
                "ok": False,
                "error": "Konnte Script-Output nicht parsen",
                "stdout": out[:500],
                "stderr": stderr.decode("utf-8", errors="replace")[:500],
            }
        return web.json_response(result)
    except asyncio.TimeoutError:
        return web.json_response({"ok": False, "error": f"Timeout nach {get_action_timeout('anki.generate')}s"}, status=504)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def api_diss_wiki_index(request):
    """GET wiki index.md content."""
    index_file = DISS_WIKI_DIR / "index.md"
    if not index_file.exists():
        return web.json_response({"content": "Wiki-Index nicht gefunden."})
    return web.json_response({"content": index_file.read_text(encoding="utf-8")})


async def api_medizin_lernplan(request):
    """POST Lernplan erzeugen + optional in iCloud schreiben.
    Body: { topic, exam_date, start_date?, time?, duration?, subtopics?, calendar?, dry_run? }
    Ruft scripts/lernplan-generator.py auf und gibt JSON zurueck.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

    topic = (body.get("topic") or "").strip()
    exam_date = (body.get("exam_date") or "").strip()
    if not topic or not exam_date:
        return web.json_response({"ok": False, "error": "topic + exam_date required"}, status=400)

    script = SCRIPTS_DIR / "lernplan-generator.py"
    if not script.exists():
        return web.json_response({"ok": False, "error": f"Script fehlt: {script}"}, status=500)

    cmd = [
        sys.executable, str(script),
        "--topic", topic,
        "--exam-date", exam_date,
        "--duration", str(int(body.get("duration") or 45)),
        "--time", (body.get("time") or "18:00"),
        "--calendar", (body.get("calendar") or "Kalender"),
        "--json",
    ]
    if body.get("start_date"):
        cmd += ["--start-date", body["start_date"]]
    subtopics = body.get("subtopics") or ""
    if isinstance(subtopics, list):
        subtopics = ",".join(subtopics)
    if subtopics:
        cmd += ["--subtopics", subtopics]
    if body.get("dry_run"):
        cmd.append("--dry-run")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=get_action_timeout("lernplan.generate"))
        out = stdout.decode("utf-8", errors="replace").strip()
        try:
            result = json.loads(out)
        except Exception:
            result = {
                "ok": False,
                "error": "Konnte Script-Output nicht parsen",
                "stdout": out[:500],
                "stderr": stderr.decode("utf-8", errors="replace")[:500],
            }
        return web.json_response(result)
    except asyncio.TimeoutError:
        return web.json_response({"ok": False, "error": f"Timeout nach {get_action_timeout('lernplan.generate')}s"}, status=504)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def api_trading_account(request):
    """Get Alpaca account info."""
    try:
        cred_file = Path("C:/Users/Robin/Jarvis/secrets/alpaca-cred.json")
        if not cred_file.exists():
            return web.json_response({"error": "No Alpaca credentials"})
        creds = json.loads(cred_file.read_text(encoding="utf-8"))
        import requests as req
        headers = {
            "APCA-API-KEY-ID": creds.get("key_id", creds.get("api_key", "")),
            "APCA-API-SECRET-KEY": creds.get("secret_key", creds.get("api_secret", "")),
        }
        base = creds.get("base_url", "https://paper-api.alpaca.markets")
        r = req.get(f"{base}/v2/account", headers=headers, timeout=10)
        if r.status_code != 200:
            return web.json_response({"error": f"HTTP {r.status_code}"})
        acc = r.json()
        return web.json_response({
            "equity": acc.get("equity"),
            "cash": acc.get("cash"),
            "buying_power": acc.get("buying_power"),
            "pnl": float(acc.get("equity", 0)) - float(acc.get("last_equity", 0)),
            "position_count": acc.get("position_count", 0),
        })
    except Exception as e:
        return web.json_response({"error": str(e)})


async def api_trading_positions(request):
    """Get Alpaca positions."""
    try:
        cred_file = Path("C:/Users/Robin/Jarvis/secrets/alpaca-cred.json")
        if not cred_file.exists():
            return web.json_response([])
        creds = json.loads(cred_file.read_text(encoding="utf-8"))
        import requests as req
        headers = {
            "APCA-API-KEY-ID": creds.get("key_id", creds.get("api_key", "")),
            "APCA-API-SECRET-KEY": creds.get("secret_key", creds.get("api_secret", "")),
        }
        base = creds.get("base_url", "https://paper-api.alpaca.markets")
        r = req.get(f"{base}/v2/positions", headers=headers, timeout=10)
        if r.status_code != 200:
            return web.json_response([])
        return web.json_response(r.json())
    except Exception:
        return web.json_response([])


async def api_trading_summary(request):
    """Get latest trading summary from night results."""
    night_dir = JARVIS_DATA / "night-results"
    if night_dir.exists():
        files = sorted(night_dir.glob("*trading*"), reverse=True)
        if files:
            try:
                data = json.loads(files[0].read_text(encoding="utf-8"))
                return web.json_response(data)
            except Exception:
                pass
    return web.json_response({})


def _alpaca_headers():
    """Read Alpaca credentials and return (headers_dict, base_url)."""
    cred_path = Path("C:/Users/Robin/Jarvis/secrets/alpaca-cred.json")
    creds = json.loads(cred_path.read_text(encoding="utf-8"))
    headers = {
        "APCA-API-KEY-ID": creds.get("key_id", creds.get("api_key", "")),
        "APCA-API-SECRET-KEY": creds.get("secret_key", creds.get("api_secret", "")),
    }
    base = creds.get("base_url", "https://paper-api.alpaca.markets")
    return headers, base


async def api_trading_orders(request):
    """GET /api/trading/orders  -  Recent orders from Alpaca."""
    try:
        headers, base = _alpaca_headers()
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(f"{base}/v2/orders?status=all&limit=20&direction=desc") as resp:
                data = await resp.json()
                return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_trading_history(request):
    """GET /api/trading/history  -  Portfolio equity history from Alpaca."""
    period = request.query.get("period", "1D")
    period_map = {
        "1D": ("1D", "5Min"),
        "1W": ("1W", "1H"),
        "1M": ("1M", "1D"),
        "3M": ("3M", "1D"),
    }
    p, tf = period_map.get(period, ("1D", "15Min"))

    try:
        headers, base = _alpaca_headers()
        async with aiohttp.ClientSession(headers=headers) as session:
            url = f"{base}/v2/account/portfolio/history?period={p}&timeframe={tf}"
            async with session.get(url) as resp:
                data = await resp.json()
                return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_trading_order(request):
    """POST /api/trading/order  -  Place a market order."""
    body = await request.json()
    symbol = body.get("symbol", "").upper().strip()
    qty = int(body.get("qty", 0))
    side = body.get("side", "buy").lower()

    if not symbol or qty < 1 or side not in ("buy", "sell"):
        return web.json_response({"error": "Invalid order params"}, status=400)

    try:
        headers, base = _alpaca_headers()
        headers["Content-Type"] = "application/json"
        order_data = {
            "symbol": symbol,
            "qty": str(qty),
            "side": side,
            "type": "market",
            "time_in_force": "day",
        }
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.post(f"{base}/v2/orders", json=order_data) as resp:
                data = await resp.json()
                if resp.status >= 400:
                    return web.json_response({"error": data.get("message", str(data))}, status=resp.status)
                return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Trading Bots  -  Start / Stop / Restart Grundgeruest
# ---------------------------------------------------------------------------
import trading_bot_manager as _tbm  # noqa: E402


async def api_trading_bots_list(request):
    """GET /api/trading/bots  -  Liste aller registrierten Bots (mit Live-Status)."""
    try:
        return web.json_response({"bots": _tbm.list_bots()})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_trading_bots_create(request):
    """POST /api/trading/bots  -  Neuen Bot registrieren.

    Body: {name, strategy?, params?, interval_sec?}
    """
    try:
        body = await request.json() if request.content_length else {}
    except Exception:
        body = {}
    name = (body.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    try:
        bot = _tbm.create_bot(
            name=name,
            strategy=body.get("strategy") or "demo",
            params=body.get("params") or {},
            interval_sec=int(body.get("interval_sec") or 60),
        )
        return web.json_response(bot, status=201)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_trading_bots_get(request):
    bot_id = request.match_info["id"]
    bot = _tbm.get_bot(bot_id)
    if not bot:
        raise web.HTTPNotFound(reason="Bot not found")
    return web.json_response(bot)


async def api_trading_bots_update(request):
    bot_id = request.match_info["id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    updated = _tbm.update_bot(bot_id, body)
    if not updated:
        raise web.HTTPNotFound(reason="Bot not found")
    return web.json_response(updated)


async def api_trading_bots_delete(request):
    bot_id = request.match_info["id"]
    ok = _tbm.delete_bot(bot_id)
    if not ok:
        raise web.HTTPNotFound(reason="Bot not found")
    return web.json_response({"ok": True})


async def api_trading_bots_start(request):
    bot_id = request.match_info["id"]
    try:
        result = _tbm.start_bot(bot_id)
        return web.json_response(result)
    except KeyError:
        raise web.HTTPNotFound(reason="Bot not found")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_trading_bots_stop(request):
    bot_id = request.match_info["id"]
    try:
        result = _tbm.stop_bot(bot_id)
        return web.json_response(result)
    except KeyError:
        raise web.HTTPNotFound(reason="Bot not found")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_trading_bots_restart(request):
    bot_id = request.match_info["id"]
    try:
        result = _tbm.restart_bot(bot_id)
        return web.json_response(result)
    except KeyError:
        raise web.HTTPNotFound(reason="Bot not found")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# World Monitor  -  Intelligence Dashboard (kostenlose APIs, kein Key nötig)
# ---------------------------------------------------------------------------

import csv
import io
from collections import Counter

# Cache: (data_dict, timestamp_float) oder None
_world_monitor_cache: tuple | None = None
_WORLD_MONITOR_TTL = 900  # 15 Minuten


async def _fetch_json(session, url: str, timeout: int = 10) -> dict | list | None:
    """GET-Request mit Timeout, gibt None bei Fehler zurück."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout),
                               headers={"User-Agent": "Jarvis-MissionControl/4.0"}) as resp:
            if resp.status != 200:
                # (encoding-fixed) print(f"[WorldMonitor] HTTP {resp.status} €" {url}")
                return None
            return await resp.json(content_type=None)
    except Exception as e:
        print(f"[WorldMonitor] Error {url}: {e}")
        return None


async def _fetch_text(session, url: str, timeout: int = 10) -> str | None:
    """GET-Request, gibt Plaintext zurück."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout),
                               headers={"User-Agent": "Jarvis-MissionControl/4.0"}) as resp:
            if resp.status != 200:
                # (encoding-fixed) print(f"[WorldMonitor] HTTP {resp.status} €" {url}")
                return None
            return await resp.text()
    except Exception as e:
        print(f"[WorldMonitor] Error {url}: {e}")
        return None


async def _fetch_news(session) -> list:
    """Reddit r/worldnews  -  Top 10 Weltnachrichten (kein API Key noetig)."""
    url = "https://www.reddit.com/r/worldnews/.json?limit=10"
    data = await _fetch_json(session, url)
    if not data:
        return []
    posts = data.get("data", {}).get("children", [])
    return [
        {
            "title": p["data"].get("title", ""),
            "url": p["data"].get("url", ""),
            "source": p["data"].get("domain", "reddit"),
            "date": datetime.utcfromtimestamp(p["data"].get("created_utc", 0)).isoformat() + "Z",
            "score": p["data"].get("score", 0),
        }
        for p in posts[:10] if p.get("data")
    ]


async def _fetch_earthquakes(session) -> dict:
    """USGS  -  Erdbeben weltweit M4.5+ (letzter Tag, immer verfuegbar)."""
    url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"
    data = await _fetch_json(session, url)
    if not data:
        return {"count": 0, "quakes": []}
    features = data.get("features", [])
    quakes = []
    for f in features[:10]:
        props = f.get("properties", {})
        coords = f.get("geometry", {}).get("coordinates", [0, 0, 0])
        quakes.append({
            "place": props.get("place", ""),
            "mag": props.get("mag", 0),
            "time": datetime.utcfromtimestamp(props.get("time", 0) / 1000).isoformat() + "Z",
            "lat": coords[1] if len(coords) > 1 else 0,
            "lon": coords[0] if len(coords) > 0 else 0,
        })
    return {"count": len(features), "quakes": quakes}


async def _fetch_crypto(session) -> list:
    """CoinGecko  -  BTC, ETH, SOL Preise (kein API Key noetig)."""
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
    data = await _fetch_json(session, url)
    if not data:
        return []
    result = []
    names = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL"}
    for coin_id, label in names.items():
        if coin_id in data:
            result.append({
                "symbol": label,
                "price": data[coin_id].get("usd", 0),
                "change_24h": round(data[coin_id].get("usd_24h_change", 0), 2),
            })
    return result


async def _fetch_weather_alerts(session) -> list:
    """NOAA Weather.gov  -  Aktive US Wetterwarnungen."""
    url = "https://api.weather.gov/alerts/active?status=actual&limit=10"
    data = await _fetch_json(session, url)
    if not data:
        return []
    features = data.get("features") or []
    alerts = []
    for f in features[:10]:
        props = f.get("properties", {})
        alerts.append({
            "headline": props.get("headline", ""),
            "severity": props.get("severity", ""),
            "event": props.get("event", ""),
            "area": props.get("areaDesc", ""),
        })
    return alerts


async def _fetch_flights(session) -> dict:
    """OpenSky Network  -  Flüge über DACH Region (lamin=45..55, lomin=5..15)."""
    url = "https://opensky-network.org/api/states/all?lamin=45&lamax=55&lomin=5&lomax=15"
    data = await _fetch_json(session, url, timeout=15)
    if not data:
        return {"count": 0, "region": "DACH", "error": "no_data"}
    states = data.get("states") or []
    return {"count": len(states), "region": "DACH"}


async def _fetch_conflicts(session) -> list:
    """GDELT GeoJSON  -  Konfliktereignisse der letzten 24h."""
    url = "https://api.gdeltproject.org/api/v2/geo/geo?query=conflict+OR+war+OR+military&mode=PointData&format=GeoJSON&timespan=24h&maxpoints=30"
    data = await _fetch_json(session, url, timeout=15)
    if not data:
        return []
    features = data.get("features", [])
    return [
        {
            "lat": f["geometry"]["coordinates"][1],
            "lon": f["geometry"]["coordinates"][0],
            "name": f.get("properties", {}).get("name", ""),
            "url": f.get("properties", {}).get("url", ""),
            "type": f.get("properties", {}).get("eventtype", ""),
        }
        for f in features[:30] if f.get("geometry", {}).get("coordinates")
    ]


async def _fetch_market_indices(session) -> list:
    """Yahoo Finance  -  VIX, Gold, S&P 500."""
    indices = []
    for symbol, name in [("^VIX", "VIX"), ("GC=F", "Gold"), ("^GSPC", "S&P 500"), ("^GDAXI", "DAX")]:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1d"
        data = await _fetch_json(session, url, timeout=8)
        if data:
            try:
                meta = data["chart"]["result"][0]["meta"]
                price = meta.get("regularMarketPrice", 0)
                prev = meta.get("chartPreviousClose", 0)
                change = ((price - prev) / prev * 100) if prev else 0
                indices.append({"symbol": name, "price": round(price, 2), "change": round(change, 2)})
            except (KeyError, IndexError):
                pass
    return indices


async def api_world_monitor(request):
    """GET /api/world-monitor  -  Aggregiertes Intelligence Dashboard."""
    import time

    global _world_monitor_cache

    now = time.time()
    if _world_monitor_cache is not None:
        cached_data, cached_ts = _world_monitor_cache
        if now - cached_ts < _WORLD_MONITOR_TTL:
            print(f"[WorldMonitor] Cache hit ({int(now - cached_ts)}s old)")
            return web.json_response(cached_data)

    print("[WorldMonitor] Fetching fresh data from all sources…")

    async with aiohttp.ClientSession() as session:
        results = await asyncio.gather(
            _fetch_news(session),
            _fetch_earthquakes(session),
            _fetch_crypto(session),
            _fetch_weather_alerts(session),
            _fetch_flights(session),
            _fetch_conflicts(session),
            _fetch_market_indices(session),
            return_exceptions=True,
        )

    def safe(val, fallback):
        return fallback if isinstance(val, Exception) else val

    data = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "news":           safe(results[0], []),
        "earthquakes":    safe(results[1], {"count": 0, "quakes": []}),
        "crypto":         safe(results[2], []),
        "weather_alerts": safe(results[3], []),
        "flights":        safe(results[4], {"count": 0, "region": "DACH", "error": "fetch_failed"}),
        "conflicts":      safe(results[5], []),
        "market_indices": safe(results[6], []),
    }

    _world_monitor_cache = (data, now)
    print(f"[WorldMonitor] Done - news:{len(data['news'])} quakes:{data['earthquakes'].get('count',0)} "
          f"crypto:{len(data['crypto'])} alerts:{len(data['weather_alerts'])} "
          f"flights:{data['flights'].get('count',0)} conflicts:{len(data['conflicts'])} "
          f"markets:{len(data['market_indices'])}")

    return web.json_response(data)


# ---------------------------------------------------------------------------
# Skills endpoint
# ---------------------------------------------------------------------------

SKILLS_DIR = Path("C:/Users/Robin/Jarvis/skills")

async def api_skills(request):
    """GET /api/skills  -  Alle installierten Skills mit Metadaten."""
    import re as _re
    skills = []
    if SKILLS_DIR.exists():
        for skill_dir in sorted(SKILLS_DIR.iterdir()):
            if not skill_dir.is_dir():
                continue
            slug = skill_dir.name
            name = slug
            description = ""
            version = None
            tags = []
            triggers = []
            capabilities = []
            # Try SKILL.md frontmatter first
            for fname in ["SKILL.md", "README.md"]:
                fpath = skill_dir / fname
                if fpath.exists():
                    try:
                        content = fpath.read_text(encoding="utf-8", errors="ignore")
                        body_text = content
                        if content.startswith("---"):
                            end = content.find("---", 3)
                            if end != -1:
                                fm = content[3:end].strip()
                                body_text = content[end+3:].strip()
                                in_triggers = False
                                for line in fm.splitlines():
                                    stripped = line.strip()
                                    if line.startswith("name:"):
                                        name = line[5:].strip().strip('"')
                                        in_triggers = False
                                    elif line.startswith("description:"):
                                        description = line[12:].strip().strip('"')
                                        in_triggers = False
                                    elif line.startswith("version:"):
                                        version = line[8:].strip().strip('"')
                                        in_triggers = False
                                    elif line.startswith("tags:"):
                                        raw = line[5:].strip()
                                        tags = [t.strip().strip('"') for t in raw.strip("[]").split(",") if t.strip()]
                                        in_triggers = False
                                    elif line.startswith("triggers:") or line.startswith("trigger:"):
                                        raw = line.split(":", 1)[1].strip()
                                        if raw.startswith("["):
                                            triggers = [t.strip().strip('"\'') for t in raw.strip("[]").split(",") if t.strip()]
                                        elif raw:
                                            triggers = [raw.strip('"\'')]
                                        in_triggers = True
                                    elif in_triggers and stripped.startswith("- "):
                                        triggers.append(stripped[2:].strip().strip('"\''))
                                    elif stripped and not stripped.startswith("-"):
                                        in_triggers = False
                        # If no frontmatter description, take first non-empty line after frontmatter
                        if not description:
                            for bline in body_text.splitlines():
                                stripped = bline.strip().lstrip("#").strip()
                                if stripped and not stripped.startswith("---"):
                                    description = stripped[:200]
                                    break
                        # Extract capabilities: first 3 bullet points from body
                        for m in _re.finditer(r'^[-*]\s+(.+)', body_text, _re.MULTILINE):
                            cap = m.group(1).strip()
                            if len(cap) > 8 and not cap.lower().startswith("trigger"):
                                capabilities.append(cap[:120])
                            if len(capabilities) >= 3:
                                break
                    except Exception:
                        pass
                    break
            # Try _meta.json for version
            meta_path = skill_dir / "_meta.json"
            if meta_path.exists():
                try:
                    import json as _json
                    meta = _json.loads(meta_path.read_text(encoding="utf-8"))
                    if not version:
                        version = meta.get("version")
                except Exception:
                    pass
            cc_wrapper = Path.home() / ".claude" / "skills" / f"{slug}.md"
            skills.append({
                "slug": slug,
                "name": name,
                "description": description,
                "version": version,
                "tags": tags,
                "triggers": triggers[:3],
                "capabilities": capabilities[:3],
                "hasSkillMd": (skill_dir / "SKILL.md").exists(),
                "hasReadme": (skill_dir / "README.md").exists(),
                "hasWrapper": cc_wrapper.exists(),
            })
    return web.json_response({"skills": skills, "total": len(skills)})


# ---------------------------------------------------------------------------
# Skill detail + usage stats
# ---------------------------------------------------------------------------

_TRANSCRIPTS_DIR = Path.home() / ".claude" / "projects"
_usage_cache = {}      # slug -> count
_usage_cache_ts = 0.0  # timestamp of last scan

def _scan_skill_usage():
    """Scan session transcripts for skill usage. Returns {slug: session_count}.
    Fast approach: full-text search per session file, skip very short slugs."""
    global _usage_cache, _usage_cache_ts
    import time
    now = time.time()
    if _usage_cache and (now - _usage_cache_ts) < 600:  # cache 10 min
        return _usage_cache
    counts = {}
    if not SKILLS_DIR.exists():
        return counts
    # Only count slugs >= 5 chars and skip generic English words that cause false positives
    _NOISY_SLUGS = {"adapt", "audit", "shape", "polish", "connect", "layout", "clarify",
                    "animate", "optimize", "distill", "delight", "critique", "harden",
                    "bolder", "quieter", "kaizen", "overdrive", "marketing", "evaluation",
                    "playwright", "remotion", "typeset", "colorize", "imagen"}
    slugs = [d.name for d in SKILLS_DIR.iterdir()
             if d.is_dir() and len(d.name) >= 5 and d.name not in _NOISY_SLUGS]
    # Only scan Jarvis project transcripts (not all projects)
    jarvis_dir = _TRANSCRIPTS_DIR / "C--Users-Robin-Jarvis"
    if not jarvis_dir.exists():
        _usage_cache = counts
        _usage_cache_ts = now
        return counts
    for jsonl in jarvis_dir.glob("*.jsonl"):
        try:
            text = jsonl.read_text(encoding="utf-8", errors="ignore")
            # Quick check: only count if slug appears in user content
            # Filter out the skill_listing block which lists all skill names
            for slug in slugs:
                # Check for the slug in contexts that indicate actual usage:
                # - user typed it or mentioned it
                # - skill was invoked
                # Simple heuristic: count if slug appears AND the file has user content
                if slug in text:
                    # Verify it's not ONLY in system prompts by checking multiple occurrences
                    # or presence in non-system content
                    idx = text.find(slug)
                    # Check a window around the match — if it's in "skill_listing" skip
                    window_start = max(0, idx - 200)
                    window = text[window_start:idx + len(slug) + 50]
                    if 'skill_listing' not in window and 'system-reminder' not in window:
                        counts[slug] = counts.get(slug, 0) + 1
        except Exception:
            continue
    _usage_cache = counts
    _usage_cache_ts = now
    return counts


def _skill_file_tree(skill_dir, prefix=""):
    """Return list of files in skill dir as [{name, size, type}]."""
    entries = []
    try:
        for item in sorted(skill_dir.iterdir()):
            rel = item.name
            if item.is_dir():
                children = _skill_file_tree(item, prefix + rel + "/")
                entries.append({"name": rel, "type": "dir", "children": children})
            else:
                try:
                    size = item.stat().st_size
                except Exception:
                    size = 0
                entries.append({"name": rel, "type": "file", "size": size})
    except Exception:
        pass
    return entries


def _parse_skill_md(content):
    """Parse SKILL.md frontmatter + body into structured data."""
    meta = {}
    body = content
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            fm = content[3:end].strip()
            body = content[end+3:].strip()
            current_key = None
            current_list = []
            for line in fm.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("- ") and current_key:
                    current_list.append(stripped[2:].strip().strip('"\''))
                    meta[current_key] = current_list
                    continue
                if ":" in stripped:
                    if current_key and isinstance(meta.get(current_key), list):
                        pass  # already saved
                    key, val = stripped.split(":", 1)
                    key = key.strip()
                    val = val.strip().strip('"\'')
                    current_key = key
                    current_list = []
                    if val.startswith("["):
                        # inline list
                        items = [t.strip().strip('"\'') for t in val.strip("[]").split(",") if t.strip()]
                        meta[key] = items
                        current_list = items
                    elif val:
                        meta[key] = val
                    else:
                        meta[key] = []
                        current_list = meta[key]
    return meta, body


async def api_skill_detail(request):
    """GET /api/skills/{slug} - Full detail for one skill."""
    slug = request.match_info["slug"]
    skill_dir = SKILLS_DIR / slug
    if not skill_dir.exists() or not skill_dir.is_dir():
        return web.json_response({"error": "Skill nicht gefunden"}, status=404)

    # Basic metadata
    name = slug
    description = ""
    version = None
    tags = []
    skill_md_content = ""
    readme_content = ""
    meta = {}
    body = ""

    # Read SKILL.md
    skill_md_path = skill_dir / "SKILL.md"
    if skill_md_path.exists():
        try:
            skill_md_content = skill_md_path.read_text(encoding="utf-8", errors="ignore")
            meta, body = _parse_skill_md(skill_md_content)
            name = meta.get("name", name)
            description = meta.get("description", "")
            version = meta.get("version")
            if isinstance(meta.get("tags"), list):
                tags = meta["tags"]
        except Exception:
            pass

    # Read README.md as fallback
    readme_path = skill_dir / "README.md"
    if readme_path.exists():
        try:
            readme_content = readme_path.read_text(encoding="utf-8", errors="ignore")[:5000]
            if not name or name == slug:
                rm_meta, rm_body = _parse_skill_md(readme_content)
                name = rm_meta.get("name", name)
                if not description:
                    description = rm_meta.get("description", "")
        except Exception:
            pass

    # _meta.json
    meta_json = {}
    meta_path = skill_dir / "_meta.json"
    if meta_path.exists():
        try:
            import json as _json
            meta_json = _json.loads(meta_path.read_text(encoding="utf-8"))
            if not version:
                version = meta_json.get("version")
        except Exception:
            pass

    # File tree
    file_tree = _skill_file_tree(skill_dir)
    total_files = sum(1 for _ in skill_dir.rglob("*") if _.is_file())
    total_size = sum(f.stat().st_size for f in skill_dir.rglob("*") if f.is_file())

    # Check for Claude Code wrapper
    cc_wrapper = Path.home() / ".claude" / "skills" / f"{slug}.md"
    has_wrapper = cc_wrapper.exists()
    wrapper_content = ""
    if has_wrapper:
        try:
            wrapper_content = cc_wrapper.read_text(encoding="utf-8", errors="ignore")[:2000]
        except Exception:
            pass

    # Triggers
    triggers = meta.get("triggers", meta.get("trigger", []))
    if isinstance(triggers, str):
        triggers = [triggers]

    # Usage stats
    usage = _scan_skill_usage()
    usage_count = usage.get(slug, 0)

    # Extract examples from body
    examples = []
    if body:
        import re
        for m in re.finditer(r'(?:example|beispiel)[^\n]*\n(.*?)(?=\n#|\n---|\Z)', body, re.IGNORECASE | re.DOTALL):
            ex = m.group(1).strip()[:500]
            if ex:
                examples.append(ex)

    return web.json_response({
        "slug": slug,
        "name": name,
        "description": description,
        "version": version,
        "tags": tags,
        "triggers": triggers,
        "hasSkillMd": skill_md_path.exists(),
        "hasReadme": readme_path.exists(),
        "hasWrapper": has_wrapper,
        "skillMdContent": skill_md_content[:8000],
        "readmeContent": readme_content[:5000],
        "wrapperContent": wrapper_content,
        "fileTree": file_tree,
        "totalFiles": total_files,
        "totalSize": total_size,
        "usageCount": usage_count,
        "meta": {k: v for k, v in meta.items() if k not in ("name", "description", "version", "tags")},
        "metaJson": meta_json,
        "examples": examples[:3],
        "body": body[:4000],
    })


async def api_skills_usage(request):
    """GET /api/skills/usage - Usage stats for all skills."""
    usage = _scan_skill_usage()
    return web.json_response({"usage": usage, "total_sessions_scanned": sum(1 for p in _TRANSCRIPTS_DIR.rglob("*.jsonl"))})


async def api_skills_install(request):
    """POST /api/skills  -  Neuen Skill anlegen. Akzeptiert:
    - {"content": "---\\nname: ...\\n..."} â†' parsed Slug aus name: Frontmatter
    - {"content": "https://github.com/..."} â†' fetched SKILL.md von GitHub
    """
    import re as _re
    import aiohttp as _aiohttp
    try:
        data = await request.json()
        raw = data.get("content", "").strip()
        if not raw:
            return web.json_response({"error": "Inhalt erforderlich"}, status=400)

        content = raw
        # If it looks like a URL, fetch SKILL.md from GitHub
        if raw.startswith("http://") or raw.startswith("https://"):
            url = raw.rstrip("/")
            # Try common SKILL.md locations
            candidates = []
            if "github.com" in url:
                parts = url.replace("https://github.com/", "").replace("http://github.com/", "").split("/")
                if len(parts) >= 2:
                    user, repo = parts[0], parts[1]
                    sub_path = "/".join(parts[4:]) if len(parts) > 4 else ""
                    for branch in ["main", "master"]:
                        if sub_path:
                            candidates.append(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{sub_path}/SKILL.md")
                        candidates.append(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/SKILL.md")
            if not candidates and "github.com" not in url:
                return web.json_response({"error": "URL nicht erkannt  -  nur GitHub URLs oder direkter SKILL.md Inhalt"}, status=400)

            # Helper to fetch a single SKILL.md and install it
            installed = []
            async with _aiohttp.ClientSession() as sess:
                async def _fetch(u):
                    try:
                        async with sess.get(u, timeout=_aiohttp.ClientTimeout(total=10)) as r:
                            return (await r.text()) if r.status == 200 else None
                    except Exception:
                        return None

                # 1) Try direct candidates
                content = None
                for cand_url in candidates:
                    content = await _fetch(cand_url)
                    if content:
                        break

                # 2) If not found, scan repo for skill directories
                if not content and "github.com" in url:
                    parts = url.replace("https://github.com/", "").replace("http://github.com/", "").split("/")
                    user, repo = parts[0], parts[1]
                    # Search common skill folder locations
                    skill_dirs_found = []
                    for search_path in ["skills", ".claude/skills", ""]:
                        api_url = f"https://api.github.com/repos/{user}/{repo}/contents/{search_path}".rstrip("/")
                        try:
                            async with sess.get(api_url, timeout=_aiohttp.ClientTimeout(total=10)) as resp:
                                if resp.status == 200:
                                    dirs = await resp.json()
                                    for d in dirs:
                                        if d.get("type") == "dir":
                                            name = d["name"]
                                            if search_path == "" and (name.startswith(".") or name in {"docs", "tests", "test", "node_modules", "__pycache__", ".github", "assets", "images", "img"}):
                                                continue
                                            prefix = f"{search_path}/" if search_path else ""
                                            skill_dirs_found.append(f"{prefix}{name}")
                                    if skill_dirs_found:
                                        break
                        except Exception:
                            continue

                    # Install ALL found skills
                    if skill_dirs_found:
                        for skill_path in skill_dirs_found:
                            skill_content = None
                            for branch in ["main", "master"]:
                                skill_url = f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{skill_path}/SKILL.md"
                                skill_content = await _fetch(skill_url)
                                if skill_content:
                                    break
                            if not skill_content:
                                continue
                            # Derive slug
                            s_slug = skill_path.split("/")[-1].lower().replace(" ", "-")
                            s_slug = _re.sub(r"[^a-z0-9\-_]", "", s_slug)
                            if not s_slug:
                                continue
                            s_dir = SKILLS_DIR / s_slug
                            if s_dir.exists():
                                installed.append({"slug": s_slug, "skipped": True})
                                continue
                            s_dir.mkdir(parents=True, exist_ok=True)
                            (s_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")
                            installed.append({"slug": s_slug, "ok": True})

                        if installed:
                            new_count = sum(1 for i in installed if i.get("ok"))
                            skip_count = sum(1 for i in installed if i.get("skipped"))
                            return web.json_response({
                                "ok": True,
                                "slug": f"{new_count} neu, {skip_count} übersprungen",
                                "installed": installed,
                                "batch": True
                            })

            if not content and not installed:
                # Fallback: try README.md + package.json
                if "github.com" in url:
                    parts = url.replace("https://github.com/", "").replace("http://github.com/", "").split("/")
                    if len(parts) >= 2:
                        user, repo = parts[0], parts[1]
                        async with _aiohttp.ClientSession() as sess:
                            async def _qf(u):
                                try:
                                    async with sess.get(u, timeout=_aiohttp.ClientTimeout(total=10)) as r:
                                        return (await r.text()) if r.status == 200 else None
                                except Exception:
                                    return None
                            readme_text = None
                            pkg_data = {}
                            for branch in ["main", "master"]:
                                if not readme_text:
                                    readme_text = await _qf(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/README.md")
                                pkg_raw = await _qf(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/package.json")
                                if pkg_raw:
                                    try:
                                        pkg_data = json.loads(pkg_raw)
                                    except Exception:
                                        pass
                                if readme_text:
                                    break
                            if readme_text or pkg_data:
                                gen_name = pkg_data.get("name", repo).replace("@", "").replace("/", "-")
                                gen_desc = pkg_data.get("description", "")
                                gen_version = pkg_data.get("version", "")
                                if not gen_desc and readme_text:
                                    for line in readme_text.splitlines():
                                        stripped = line.strip()
                                        if stripped and not stripped.startswith("#") and not stripped.startswith("!") and not stripped.startswith("<") and len(stripped) > 20:
                                            gen_desc = stripped[:300]
                                            break
                                content = f"---\nname: {gen_name}\ndescription: {gen_desc}\nversion: {gen_version}\n---\n\n"
                                if readme_text:
                                    content += readme_text[:3000]
                if not content and not installed:
                    return web.json_response({"error": "Kein Skill gefunden — weder SKILL.md, README.md noch package.json im Repo."}, status=404)

        # Extract slug from frontmatter name: field
        slug = None
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                fm = content[3:end]
                for line in fm.splitlines():
                    if line.strip().startswith("name:"):
                        name_val = line.split(":", 1)[1].strip().strip('"').strip("'")
                        slug = name_val.lower().replace(" ", "-")
                        break

        # Fallback: use first 40 chars of content as slug
        if not slug:
            slug = _re.sub(r"[^a-z0-9]+", "-", raw[:40].lower()).strip("-") or "unnamed-skill"

        slug = _re.sub(r"[^a-z0-9\-_]", "", slug)
        if not slug:
            return web.json_response({"error": "Konnte keinen Slug ableiten"}, status=400)

        skill_dir = SKILLS_DIR / slug
        if skill_dir.exists():
            return web.json_response({"error": f"Skill '{slug}' existiert bereits"}, status=409)
        skill_dir.mkdir(parents=True, exist_ok=False)
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
        return web.json_response({"ok": True, "slug": slug})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


def _skill_recommendation(skill_names, is_batch=False, repo_name="", name="", description="", verdict=""):
    """Generate a Jarvis recommendation based on skill content + Robin's profile."""
    text = " ".join(skill_names).lower() + " " + name.lower() + " " + description.lower()

    # Robin's interests: medical, research, trading, anki, code, data, writing
    relevant = []
    irrelevant = []
    INTEREST_KEYWORDS = {
        "medizin": ["medical", "health", "clinical", "pubmed", "osce", "anki", "flashcard"],
        "research": ["research", "paper", "academic", "science", "zotero", "deep-research"],
        "trading": ["trading", "stock", "market", "finance", "alpaca", "crypto"],
        "code/dev": ["code", "debug", "git", "dev", "python", "refactor", "test", "api", "mcp"],
        "data": ["data", "csv", "excel", "analytics", "extract"],
        "writing": ["write", "doc", "essay", "content", "article"],
        "design": ["design", "ui", "ux", "css", "canvas", "image"],
        "audio": ["voice", "tts", "speech", "transcrib", "mikro", "audio", "whisper", "elevenlabs"],
    }
    for category, keywords in INTEREST_KEYWORDS.items():
        matches = [k for k in keywords if k in text]
        if matches:
            relevant.append(category)

    # Detect clearly irrelevant skills
    IRRELEVANT_KEYWORDS = ["invoice", "lead-research-assistant", "internal-comms", "competitive-ads",
                           "developer-growth", "langsmith", "composio", "connect-apps"]
    irrelevant_hits = [k for k in IRRELEVANT_KEYWORDS if k in text]

    if is_batch:
        useful = [n for n in skill_names if any(k in n.lower() for cat_kws in INTEREST_KEYWORDS.values() for k in cat_kws)]
        noise = len(skill_names) - len(useful)
        if useful:
            rec_text = f"Davon für dich relevant: {', '.join(useful[:5])}{'…' if len(useful) > 5 else ''}."
            if noise > len(useful):
                rec_text += f" Aber {noise} von {len(skill_names)} sind eher Business/Marketing-Skills die du nicht brauchst."
                rec_action = "selektiv"
                rec_reason = "Einzelne Skills rauspicken statt alles installieren — die meisten sind für SaaS/Business, nicht für Medizin oder Dev."
            else:
                rec_action = "ja"
                rec_reason = "Gutes Verhältnis von nützlichen zu irrelevanten Skills."
        else:
            rec_text = "Keiner der Skills passt direkt zu deinem Setup (Medizin, Research, Trading, Dev)."
            rec_action = "nein"
            rec_reason = "Eher Business/Marketing-Fokus, nicht dein Bereich."
    else:
        if verdict == "schwach":
            rec_action = "nein"
            rec_text = "Qualität zu niedrig — keine Beschreibung oder Triggers."
            rec_reason = "Ein Skill ohne klare Beschreibung und Trigger ist Ballast."
        elif relevant:
            rec_action = "ja"
            rec_text = f"Passt zu: {', '.join(relevant)}."
            rec_reason = f"Direkt relevant für dein {relevant[0]}-Setup."
        elif irrelevant_hits:
            rec_action = "nein"
            rec_text = "Kein Match mit deinem Profil."
            rec_reason = "Eher für Business/SaaS, nicht für Medizinstudium oder Dev."
        else:
            rec_action = "vielleicht"
            rec_text = "Nicht klar einzuordnen."
            rec_reason = "Kein direkter Match, aber auch nicht offensichtlich irrelevant."

    return {
        "action": rec_action,  # ja, nein, vielleicht, selektiv
        "text": rec_text,
        "reason": rec_reason,
        "relevant_categories": relevant,
    }


async def api_skills_preview(request):
    """POST /api/skills/preview  -  Fetch + parse skill, return review without installing."""
    import re as _re
    import aiohttp as _aiohttp
    try:
        data = await request.json()
        raw = data.get("content", "").strip()
        if not raw:
            return web.json_response({"error": "Inhalt erforderlich"}, status=400)

        content = raw
        source_url = None

        # Fetch from URL if needed
        if raw.startswith("http://") or raw.startswith("https://"):
            source_url = raw.rstrip("/")
            candidates = []
            if "github.com" in source_url:
                parts = source_url.replace("https://github.com/", "").replace("http://github.com/", "").split("/")
                if len(parts) >= 2:
                    user, repo = parts[0], parts[1]
                    sub_path = "/".join(parts[4:]) if len(parts) > 4 else ""
                    for branch in ["main", "master"]:
                        if sub_path:
                            candidates.append(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{sub_path}/SKILL.md")
                        candidates.append(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/SKILL.md")
            if not candidates:
                return web.json_response({"error": "Nur GitHub-URLs oder direkter SKILL.md Inhalt"}, status=400)

            content = None
            async with _aiohttp.ClientSession() as sess:
                for cand_url in candidates:
                    try:
                        async with sess.get(cand_url, timeout=_aiohttp.ClientTimeout(total=10)) as r:
                            if r.status == 200:
                                content = await r.text()
                                break
                    except Exception:
                        continue

            if not content:
                if "github.com" in source_url:
                    parts = source_url.replace("https://github.com/", "").replace("http://github.com/", "").split("/")
                    user, repo = parts[0], parts[1]

                    # Strategy 1: Scan for skill dirs (batch repo)
                    skill_names = []
                    async with _aiohttp.ClientSession() as sess:
                        async def _qfetch(u):
                            try:
                                async with sess.get(u, timeout=_aiohttp.ClientTimeout(total=10)) as r:
                                    return (await r.text()) if r.status == 200 else None
                            except Exception:
                                return None

                        for search_path in ["skills", ".claude/skills", ""]:
                            api_url = f"https://api.github.com/repos/{user}/{repo}/contents/{search_path}".rstrip("/")
                            try:
                                async with sess.get(api_url, timeout=_aiohttp.ClientTimeout(total=8)) as resp:
                                    if resp.status == 200:
                                        dirs = await resp.json()
                                        dir_names = [d["name"] for d in dirs if d.get("type") == "dir"]
                                        if search_path == "":
                                            skip = {".github", "docs", "tests", "test", "node_modules", "__pycache__", ".vscode", "assets", "images", "img"}
                                            dir_names = [n for n in dir_names if n not in skip and not n.startswith(".")]
                                            if len(dir_names) >= 3:
                                                skill_names = dir_names
                                                break
                                        else:
                                            skill_names = dir_names
                                            break
                            except Exception:
                                continue

                        if skill_names:
                            already = [d.name for d in SKILLS_DIR.iterdir() if d.is_dir()] if SKILLS_DIR.exists() else []
                            new_skills = [s for s in skill_names if s not in already]
                            rec = _skill_recommendation(skill_names, is_batch=True, repo_name=f"{user}/{repo}")
                            return web.json_response({
                                "ok": True, "batch": True,
                                "skill_count": len(skill_names), "new_count": len(new_skills),
                                "skill_names": skill_names[:20],
                                "name": f"Skill-Paket: {user}/{repo}",
                                "description": f"{len(skill_names)} Skills gefunden, davon {len(new_skills)} neu.",
                                "verdict": "batch", "content": raw, "recommendation": rec,
                            })

                        # Strategy 2: Fallback — README.md + package.json → auto-generate SKILL.md
                        readme_text = None
                        pkg_data = {}
                        for branch in ["main", "master"]:
                            if not readme_text:
                                readme_text = await _qfetch(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/README.md")
                            pkg_raw = await _qfetch(f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/package.json")
                            if pkg_raw:
                                try:
                                    pkg_data = json.loads(pkg_raw)
                                except Exception:
                                    pass
                            if readme_text:
                                break

                        if readme_text or pkg_data:
                            # Build a synthetic SKILL.md from what we found
                            gen_name = pkg_data.get("name", repo).replace("@", "").replace("/", "-")
                            gen_desc = pkg_data.get("description", "")
                            gen_version = pkg_data.get("version", "")
                            if not gen_desc and readme_text:
                                # Grab first non-heading, non-empty line from README
                                for line in readme_text.splitlines():
                                    stripped = line.strip()
                                    if stripped and not stripped.startswith("#") and not stripped.startswith("!") and not stripped.startswith("<") and len(stripped) > 20:
                                        gen_desc = stripped[:300]
                                        break

                            # Extract capabilities from README headers/lists
                            caps = []
                            if readme_text:
                                import re as _re2
                                for m in _re2.finditer(r'^(?:[-*]|\d+\.)\s+[`*]*([^`*\n]{10,80})', readme_text, _re2.MULTILINE):
                                    cap = m.group(1).strip().rstrip('.')
                                    if cap and not cap.startswith("http") and not cap.startswith("npm") and not cap.startswith("git"):
                                        caps.append(cap)
                                    if len(caps) >= 8:
                                        break

                            content = f"---\nname: {gen_name}\ndescription: {gen_desc}\nversion: {gen_version}\n---\n\n"
                            if readme_text:
                                content += readme_text[:3000]

                            # Check if already installed
                            gen_slug = _re.sub(r"[^a-z0-9\-_]", "", gen_name.lower().replace(" ", "-"))
                            already_installed = (SKILLS_DIR / gen_slug).exists() if gen_slug else False

                            rec = _skill_recommendation([], name=gen_name, description=gen_desc)
                            return web.json_response({
                                "ok": True, "batch": False,
                                "name": gen_name, "description": gen_desc, "version": gen_version,
                                "source": "readme", "source_url": source_url,
                                "capabilities": caps,
                                "already_installed": already_installed,
                                "verdict": "ok",
                                "score": max(2, min(5, len(caps))), "max_score": 7,
                                "pros": [p for p in [
                                    f"README vorhanden ({len(readme_text)} Zeichen)" if readme_text else None,
                                    f"package.json mit Version {gen_version}" if gen_version else None,
                                    f"{len(caps)} Features erkannt" if caps else None,
                                ] if p],
                                "cons": ["Kein SKILL.md — wurde aus README/package.json generiert"],
                                "triggers": [],
                                "content": content,
                                "recommendation": rec,
                            })

                return web.json_response({"error": "Kein Skill gefunden — weder SKILL.md, README.md noch package.json im Repo."}, status=404)

        # Parse frontmatter
        name, description, triggers, when_to_use, version = "", "", [], "", ""
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                fm = content[3:end]
                body = content[end+3:].strip()
                for line in fm.splitlines():
                    line = line.strip()
                    if line.startswith("name:"):
                        name = line.split(":", 1)[1].strip().strip('"\'')
                    elif line.startswith("description:"):
                        description = line.split(":", 1)[1].strip().strip('"\'')
                    elif line.startswith("version:"):
                        version = line.split(":", 1)[1].strip()
                    elif line.startswith("triggers:") or line.startswith("trigger:"):
                        val = line.split(":", 1)[1].strip()
                        if val:
                            triggers.append(val.strip('"\''))
                    elif line.startswith("-") and triggers is not None:
                        triggers.append(line.lstrip("- ").strip('"\''))
        else:
            body = content

        if not name:
            name = _re.sub(r"[^a-z0-9]+", "-", raw[:40].lower()).strip("-") or "Unbekannt"

        # Derive slug
        slug = _re.sub(r"[^a-z0-9\-_]", "", name.lower().replace(" ", "-"))

        # Heuristic quality score
        score = 0
        pros, cons = [], []
        if name and len(name) > 3:
            score += 1
        if description and len(description) > 20:
            score += 2
            pros.append("Klare Beschreibung vorhanden")
        else:
            cons.append("Beschreibung fehlt oder sehr kurz")
        if triggers:
            score += 2
            pros.append(f"{len(triggers)} Trigger-Bedingung(en) definiert")
        else:
            cons.append("Keine Trigger definiert — manueller Aufruf nötig")
        if len(content) > 300:
            score += 1
            pros.append("Detaillierte Anweisungen")
        if "SKILL.md" in content or "skill" in content.lower():
            score += 1
        if slug in [d.name for d in SKILLS_DIR.iterdir() if d.is_dir()] if SKILLS_DIR.exists() else []:
            return web.json_response({
                "ok": True,
                "already_installed": True,
                "slug": slug,
                "name": name,
                "description": description,
            })

        # Verdict
        if score >= 5:
            verdict = "empfohlen"
        elif score >= 3:
            verdict = "ok"
        else:
            verdict = "schwach"

        rec = _skill_recommendation([slug], is_batch=False, name=name, description=description, verdict=verdict)
        return web.json_response({
            "ok": True,
            "batch": False,
            "slug": slug,
            "name": name,
            "description": description,
            "version": version,
            "triggers": triggers[:5],
            "score": score,
            "max_score": 7,
            "pros": pros,
            "cons": cons,
            "verdict": verdict,
            "content_len": len(content),
            "already_installed": False,
            "recommendation": rec,
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# File Upload endpoint
# ---------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB

async def api_upload(request):
    """POST /api/upload  -  multipart/form-data, stores file in data/uploads/."""
    try:
        reader = await request.multipart()
        field = await reader.next()
        if field is None or field.name != "file":
            return web.json_response({"error": "No file field"}, status=400)

        original_name = field.filename or "upload"
        # Sanitize filename
        safe_name = "".join(c for c in original_name if c.isalnum() or c in "._- ").strip()
        if not safe_name:
            safe_name = "upload"
        # Unique prefix to avoid collisions
        unique_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
        dest = UPLOADS_DIR / unique_name

        size = 0
        with dest.open("wb") as f:
            while True:
                chunk = await field.read_chunk(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    f.close()
                    dest.unlink(missing_ok=True)
                    return web.json_response({"error": "File too large (max 20 MB)"}, status=413)
                f.write(chunk)

        print(f"[Upload] Saved {unique_name} ({size} bytes)")
        return web.json_response({"filename": unique_name, "size": size})
    except Exception as e:
        print(f"[Upload] Error: {e}")
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Knowledge Funnel  -  ingest any content into Obsidian Brain
# ---------------------------------------------------------------------------

KNOWLEDGE_DIR = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Knowledge")
FUNNEL_LOG    = DATA_DIR / "funnel-log.json"


def _funnel_load_log() -> list:
    """Load funnel log from disk."""
    if FUNNEL_LOG.exists():
        try:
            return json.loads(FUNNEL_LOG.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _funnel_save_log(items: list):
    """Save funnel log to disk."""
    FUNNEL_LOG.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


async def api_funnel_log(request):
    """GET /api/funnel/log  -  Return log of all ingested items."""
    items = _funnel_load_log()
    return web.json_response({"items": items})


async def api_funnel_ingest(request):
    """POST /api/funnel/ingest  -  Ingest text/files into Obsidian Knowledge Base.

    Body: { type, tags, text, files: [{filename, original, size}] }
    Creates a smart-task that runs Claude to process the content.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    content_type  = body.get("type", "general")
    tags          = body.get("tags", [])
    text          = (body.get("text") or "").strip()
    files         = body.get("files", [])

    if not text and not files:
        return web.json_response({"error": "Kein Inhalt"}, status=400)

    type_labels = {
        "notes":   "Eigene Notizen",
        "paper":   "Paper/Abstract",
        "data":    "Daten/Ergebnisse",
        "quote":   "Zitat/Beobachtung",
        "general": "Allgemein",
        "file":    "Datei",
    }
    type_label = type_labels.get(content_type, content_type)
    tags_str   = ", ".join(tags) if tags else "keine"

    # Build prompt for Claude
    parts = [
        f"Du bist Jarvis. Ingestiere den folgenden Inhalt in die Wissensbasis.",
        f"",
        f"**Typ:** {type_label}",
        f"**Tags:** {tags_str}",
        f"**Ziel-Ordner:** {KNOWLEDGE_DIR}",
        f"",
        f"**Aufgabe:**",
        f"1. Entscheide in welchem Unterordner der Inhalt am besten passt (Forschung, Medizin, Technik, Kontext, Skills, Meta — oder neuer Ordner)",
        f"2. Erstelle eine strukturierte Markdown-Note mit passendem Dateinamen",
        f"3. Füge YAML-Frontmatter ein mit: tags, type, date, source (falls erkennbar)",
        f"4. Setze Obsidian-Wikilinks zu verwandten existierenden Notes",
        f"5. Aktualisiere `{KNOWLEDGE_DIR}/INDEX.md` (neue Zeile in der passenden Kategorie-Tabelle)",
        f"6. Gib am Ende aus: NOTE_CREATED: <relativer Pfad>",
    ]

    if text:
        parts += ["", "**INHALT:**", text]

    if files:
        parts += ["", "**DATEIEN:**"]
        for f in files:
            orig = f.get("original", f.get("filename", ""))
            fpath = UPLOADS_DIR / f.get("filename", "")
            parts.append(f"- {orig} (gespeichert als: {fpath})")

    prompt = "\n".join(parts)

    # Generate title preview
    preview = text[:80] if text else (files[0].get("original", "") if files else "")
    title = (text.split("\n")[0][:60] if text else (files[0].get("original", "Upload") if files else "Ingest"))

    # Log entry
    log_id  = uuid.uuid4().hex[:12]
    log_item = {
        "id":      log_id,
        "title":   title,
        "preview": preview,
        "type":    content_type,
        "tags":    tags,
        "date":    datetime.now().strftime("%d.%m.%Y %H:%M"),
        "files":   [f.get("original", "") for f in files],
        "status":  "processing",
    }
    items = _funnel_load_log()
    items.insert(0, log_item)
    _funnel_save_log(items)

    # Create and start smart-task (use shared smart-tasks storage)
    task_id  = str(uuid.uuid4())
    task_obj = {
        "id":               task_id,
        "title":            f"Brain-Ingest: {title[:50]}",
        "description":      f"Knowledge-Funnel Ingest ({type_label})",
        "prompt":           prompt,
        "original_request": prompt,
        "chat_context":     "",
        "priority":         "medium",
        "status":           "pending",
        "created":          datetime.now().isoformat(),
        "started":          None,
        "completed":        None,
        "output":           "",
        "error":            "",
        "funnel_log_id":    log_id,
    }
    tasks = _load_smart_tasks()
    tasks.append(task_obj)
    _save_smart_tasks(tasks)

    # Start task async (funnel-specific runner)
    asyncio.create_task(_run_funnel_task(task_id, log_id))

    print(f"[Funnel] Ingest started: {title[:40]} ({content_type}) -> task {task_id}")
    return web.json_response({"ok": True, "task_id": task_id, "log_id": log_id})


async def _run_funnel_task(task_id: str, funnel_log_id: str = None):
    """Run a brain-ingest task via Claude CLI, no WS streaming."""
    _activity_set("funnel", active=True)
    # Mark running
    _update_task_field(task_id, status="running", started=datetime.now().isoformat())

    # Find prompt
    tasks   = _load_smart_tasks()
    task_obj = _find_task(tasks, task_id)
    if not task_obj:
        return

    prompt = task_obj.get("prompt", "") or task_obj.get("original_request", "")

    try:
        claude_exe = r"C:\Users\Robin\.local\bin\claude.exe"
        cwd        = r"C:\Users\Robin\Jarvis"
        cmd = [claude_exe, "-p", prompt,
               "--model", "sonnet",
               "--max-turns", "12",
               "--tools", "Bash,Read,Write,Edit,Glob,Grep,LS"]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            stdin=asyncio.subprocess.DEVNULL,
            **_SUBPROCESS_FLAGS,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        output = (stdout or b"").decode("utf-8", errors="replace").strip()

        _update_task_field(task_id, status="done", completed=datetime.now().isoformat(),
                           output=output)

        # Update funnel log entry
        if funnel_log_id:
            items = _funnel_load_log()
            for it in items:
                if it.get("id") == funnel_log_id:
                    it["status"] = "done"
                    m = re.search(r"NOTE_CREATED:\s*(.+)", output)
                    if m: it["note_path"] = m.group(1).strip()
            _funnel_save_log(items)

    except asyncio.TimeoutError:
        _update_task_field(task_id, status="error", error="Timeout (5 min)")
        if funnel_log_id:
            items = _funnel_load_log()
            for it in items:
                if it.get("id") == funnel_log_id:
                    it["status"] = "error"
            _funnel_save_log(items)
    except Exception as e:
        _update_task_field(task_id, status="error", error=str(e))
        print(f"[Funnel] Task error: {e}")
    finally:
        _activity_set("funnel", active=False, pending_delta=1)


# ---------------------------------------------------------------------------
# Smart Model Routing  -  pick cheapest model that can handle the request
# ---------------------------------------------------------------------------

def _pick_model(message: str, session) -> str:
    """Pick the right model based on message complexity.

    - haiku: greetings, short questions, status checks, simple lookups
    - sonnet: code edits, explanations, medium tasks, most conversations
    - opus: deep analysis, architecture, multi-step reasoning, research

    Returns model string for --model flag.
    """
    import re
    msg = message.lower().strip()
    word_count = len(msg.split())

    # Config override: if user set a specific model, always use it
    forced = CONFIG.get("claude_model_force")
    if forced:
        return forced

    # === HAIKU: quick, simple, cheap ===
    haiku_patterns = [
        r'^(hi|hey|hallo|moin|guten (morgen|tag|abend)|wie geht)',
        r'^(ja|nein|ok|okay|danke|passt|perfekt|genau|klar|cool|nice|gut)[\s!?.]*$',
        r'^(was ist|wie heisst|wann ist|wo ist|wer ist)',
        r'^(status|zeit|uhrzeit|datum|wetter)',
        r'^(test|ping|check)[\s!?.]*$',
    ]
    if word_count <= 8 and any(re.search(p, msg) for p in haiku_patterns):
        print(f"[Router] haiku  -  short/simple ({word_count} words)")
        return "haiku"

    # === OPUS: complex, deep reasoning ===
    opus_patterns = [
        r'(analysier|analyse|architektur|refactor|design|strategie)',
        r'(erkl.r.*detail|tief.*eintauchen|ausf.hrlich)',
        r'(dissertation|doktorarbeit|paper|forschung|literatur)',
        r'(vergleich.*und.*und|trade.?off|vor.*und.*nachteil)',
        r'(debug.*komplex|multi.?file|mehrere dateien)',
        r'(plan.*erstell|roadmap|konzept.*entwickl)',
        r'(warum.*funktioniert.*nicht|root.?cause)',
    ]
    if any(re.search(p, msg) for p in opus_patterns):
        print(f"[Router] opus  -  complex task detected")
        return "opus"

    # Long messages (>100 words) or with code blocks â†' opus
    if word_count > 100 or '```' in message:
        print(f"[Router] opus  -  long/code message ({word_count} words)")
        return "opus"

    # === SONNET: default, good balance ===
    print(f"[Router] sonnet  -  default ({word_count} words)")
    return "sonnet"


# ---------------------------------------------------------------------------
# Bot Arena  -  Multi-Bot Discussion Rooms
# ---------------------------------------------------------------------------
ARENA_FILE = Path("C:/Users/Robin/Jarvis/data/arena-rooms.json")
ARENA_CRASH_DIR = Path("C:/Users/Robin/Jarvis/data/arena-crashes")

_arena_rooms: dict = {}  # room_id -> ArenaRoom state


def _log_arena_crash(room_id: str, bot_name: str, turn: int, kind: str,
                     cmd: list, returncode, stderr: str, stdout_tail: str,
                     timeout_s: int, exception: str = "") -> dict:
    """Persist crash details to data/arena-crashes/ and return a short summary dict.

    kind: one of 'timeout', 'exception', 'empty_response', 'budget_exhausted'.
    Returns dict with 'file' (path str), 'summary' (one-line str) for room messaging.
    """
    try:
        ARENA_CRASH_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_bot = "".join(c if c.isalnum() else "_" for c in bot_name)[:30]
        fname = f"{ts}_{room_id[:8]}_{safe_bot}_t{turn}_{kind}.json"
        fpath = ARENA_CRASH_DIR / fname
        payload = {
            "timestamp": datetime.now().isoformat(),
            "room_id": room_id,
            "bot_name": bot_name,
            "turn": turn,
            "kind": kind,
            "cmd": cmd,
            "returncode": returncode,
            "timeout_s": timeout_s,
            "exception": exception,
            "stderr": stderr or "",
            "stdout_tail": stdout_tail or "",
        }
        fpath.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        # Short summary for the arena room
        err_snip = (stderr or "").strip().splitlines()[-1][:200] if (stderr or "").strip() else ""
        if kind == "timeout":
            summary = f"⏱️ Timeout nach {timeout_s}s"
        elif kind == "exception":
            summary = f"💥 Exception: {exception[:200]}"
        elif kind == "budget_exhausted":
            summary = f"📋 Schritte-Budget aufgebraucht (max_turns erreicht, exit={returncode})"
        elif kind == "thinking_budget_exhausted":
            summary = f"🧠 Denk-Budget erschöpft (Thinking-Tokens aufgebraucht, exit={returncode})"
        else:
            summary = f"🕳️ Echte Leer-Antwort (stdout leer, kein bekannter Fehler, exit={returncode})"
        if err_snip:
            summary += f" — stderr: {err_snip}"
        return {"file": str(fpath), "summary": summary, "payload": payload}
    except Exception as log_err:
        print(f"[Arena] CRASH-LOG FAILED: {log_err}")
        return {"file": "", "summary": f"Crash ({kind}) — Log fehlgeschlagen: {log_err}", "payload": {}}


def _load_arena_rooms() -> list:
    if ARENA_FILE.exists():
        try:
            return json.loads(ARENA_FILE.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _save_arena_rooms(rooms: list):
    ARENA_FILE.parent.mkdir(parents=True, exist_ok=True)
    ARENA_FILE.write_text(
        json.dumps(rooms, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _get_arena_room(rooms, room_id):
    for r in rooms:
        if r["id"] == room_id:
            return r
    return None


ARENA_STALE_THRESHOLD_S = 300  # 5 min Stille → kein Blind-Revival


def _room_is_stale(room: dict) -> bool:
    """True wenn letzte Aktivität im Raum älter als 5 Minuten ist."""
    msgs = room.get("messages", [])
    last_ts_str = msgs[-1].get("timestamp", "") if msgs else ""
    if not last_ts_str:
        last_ts_str = room.get("last_active") or room.get("created", "")
    if not last_ts_str:
        return False
    try:
        last_ts = datetime.fromisoformat(last_ts_str)
        return (datetime.now() - last_ts).total_seconds() > ARENA_STALE_THRESHOLD_S
    except Exception:
        return False


async def api_arena_rooms(request):
    """GET /api/arena/rooms  -  List all arena rooms."""
    rooms = _load_arena_rooms()
    # Add live status
    for r in rooms:
        rid = r["id"]
        r["running"] = rid in _arena_rooms and _arena_rooms[rid].get("running", False)
    return web.json_response(rooms)


async def api_arena_create(request):
    """POST /api/arena/rooms  -  Create a new arena room."""
    body = await request.json()
    room = {
        "id": str(uuid.uuid4()),
        "title": body.get("title", "Neuer Raum"),
        "topic": body.get("topic", ""),
        "category": body.get("category", "general"),
        "bots": body.get("bots", [
            {"name": "Alpha", "model": "opus", "color": "#6366f1", "persona": "Du bist ein analytischer Denker. Argumentiere logisch und praezise. Erkenne gute Punkte der anderen an."},
            {"name": "Beta", "model": "opus", "color": "#22c55e", "persona": "Du bist ein kreativer Querdenker. Bringe unerwartete Perspektiven ein, aber erkenne auch gute Ideen an."},
            {"name": "Gamma", "model": "sonnet", "color": "#f59e0b", "persona": "Du bist ein pragmatischer Umsetzer. Fokussiere auf Machbarkeit und konkrete naechste Schritte."},
            {"name": "Delta", "model": "sonnet", "color": "#ec4899", "persona": "Du bist ein Vermittler. Finde Gemeinsamkeiten und schlage Kompromisse vor."},
        ]),
        "messages": [],
        "max_turns": body.get("max_turns", 20),
        "max_rounds": max(1, min(25, int(body.get("max_rounds", 8)))),
        "summarize_every": body.get("summarize_every", 10),
        "allow_read": body.get("allow_read", True),
        "created": datetime.now().isoformat(),
        "last_active": datetime.now().isoformat(),
        "status": "idle",
    }
    rooms = _load_arena_rooms()
    rooms.append(room)
    _save_arena_rooms(rooms)
    return web.json_response(room, status=201)


async def api_arena_delete(request):
    """DELETE /api/arena/rooms/{id}  -  Delete a room."""
    room_id = request.match_info["id"]
    # Stop if running
    if room_id in _arena_rooms:
        _arena_rooms[room_id]["running"] = False
    rooms = _load_arena_rooms()
    rooms = [r for r in rooms if r["id"] != room_id]
    _save_arena_rooms(rooms)
    return web.json_response({"ok": True})


async def api_arena_room(request):
    """GET /api/arena/rooms/{id}  -  Get room details."""
    room_id = request.match_info["id"]
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")
    room["running"] = room_id in _arena_rooms and _arena_rooms[room_id].get("running", False)
    return web.json_response(room)


async def api_arena_start(request):
    """POST /api/arena/rooms/{id}/start  -  Start bot discussion."""
    room_id = request.match_info["id"]
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")
    if room_id in _arena_rooms and _arena_rooms[room_id].get("running"):
        return web.json_response({"error": "Already running"}, status=409)

    body = await request.json() if request.content_length else {}
    if body.get("topic"):
        room["topic"] = body["topic"]
        _save_arena_rooms(rooms)

    room["last_active"] = datetime.now().isoformat()
    _save_arena_rooms(rooms)
    _arena_rooms[room_id] = {"running": True, "process": None}
    asyncio.create_task(_run_arena(room_id))
    return web.json_response({"ok": True, "room_id": room_id})


async def api_arena_stop(request):
    """POST /api/arena/rooms/{id}/stop  -  Stop bot discussion."""
    room_id = request.match_info["id"]
    if room_id in _arena_rooms:
        _arena_rooms[room_id]["running"] = False
        proc = _arena_rooms[room_id].get("process")
        if proc and proc.returncode is None:
            proc.kill()
    return web.json_response({"ok": True})


async def api_arena_inject(request):
    """POST /api/arena/rooms/{id}/inject  -  Robin injects a message into the discussion."""
    room_id = request.match_info["id"]
    body = await request.json()
    message = body.get("message", "").strip()
    image = (body.get("image") or "").strip()  # legacy single-image filename in data/uploads/
    attachments = body.get("attachments") or []  # list of filenames in data/uploads/
    # Backwards-compat: if only legacy `image` was sent, fold it into attachments
    if image and image not in attachments:
        attachments = [image] + list(attachments)
    # Sanitize: only keep strings, drop empties, dedupe
    attachments = [a for a in (str(x).strip() for x in attachments) if a]
    seen = set(); attachments = [a for a in attachments if not (a in seen or seen.add(a))]

    if not message and not attachments:
        return web.json_response({"error": "Empty message"}, status=400)

    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")

    placeholder = "(Datei eingeworfen)" if attachments else ""
    msg = {
        "role": "robin",
        "name": "Robin",
        "content": message or placeholder,
        "timestamp": datetime.now().isoformat(),
        "color": "#f59e0b",
    }
    if attachments:
        msg["attachments"] = attachments
        # Keep `image` for first image so existing frontend rendering still shows a preview.
        first_img = next((a for a in attachments if Path(a).suffix.lower() in
                          (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")), "")
        if first_img:
            msg["image"] = first_img
    room["messages"].append(msg)
    _save_arena_rooms(rooms)

    # Broadcast to all WS clients
    await _broadcast_all_ws({
        "type": "arena.message",
        "room_id": room_id,
        "message": msg,
    })
    return web.json_response({"ok": True})


async def api_arena_update(request):
    """PUT /api/arena/rooms/{id}  -  Update room settings (title, topic, bots, max_turns)."""
    room_id = request.match_info["id"]
    body = await request.json()
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")
    for key in ("title", "topic", "bots", "max_turns", "max_rounds", "category", "summarize_every", "allow_read", "auto_continue"):
        if key in body:
            if key == "max_rounds":
                try:
                    room[key] = max(1, min(25, int(body[key])))
                except (TypeError, ValueError):
                    pass
            else:
                room[key] = body[key]
    _save_arena_rooms(rooms)
    return web.json_response(room)


async def api_arena_execute(request):
    """POST /api/arena/rooms/{id}/execute  -  Enable execution mode for N turns."""
    room_id = request.match_info["id"]
    body = await request.json()
    execution_turns = body.get("turns", 2)  # Default: 2 bots each get 1 execution turn
    execution_turns = max(1, min(execution_turns, 10))  # Clamp 1-10
    brief = body.get("brief") or {}

    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")

    room["tools_enabled"] = True
    room["execution_turns_left"] = execution_turns
    # Persist the mini-brief on the room so UI + bots can reference it every turn
    if brief.get("goal"):
        room["current_brief"] = {
            "goal": brief.get("goal", "").strip(),
            "scope": brief.get("scope", "").strip(),
            "dod": brief.get("dod", "").strip(),
            "check": brief.get("check", "").strip(),
            "turns": execution_turns,
            "created": datetime.now().isoformat(),
        }
    _save_arena_rooms(rooms)

    # Build a structured briefing message so bots see a clear mission before they build
    if brief.get("goal"):
        parts = [
            "== MINI-AUFTRAG (Briefing vor dem Bau) ==",
            f"ZIEL: {brief.get('goal','').strip()}",
        ]
        if brief.get("scope"):
            parts.append(f"SCOPE / NICHT-ZIELE: {brief['scope'].strip()}")
        if brief.get("dod"):
            parts.append(f"DEFINITION OF DONE: {brief['dod'].strip()}")
        if brief.get("check"):
            parts.append(f"CHECKPOINT: {brief['check'].strip()}")
        parts.append(
            f"Ihr habt {execution_turns} Execution-Turn(s) mit vollen Tools. "
            f"Haltet euch strikt an Ziel und Scope. Liefert am Ende ein konkretes Ergebnis "
            f"und sagt klar, ob Definition of Done erreicht wurde."
        )
        content = "\n".join(parts)
    else:
        content = f"Setzt das um was ihr diskutiert habt. Ihr habt {execution_turns} Execution-Turns mit vollen Tools."

    msg = {
        "role": "robin",
        "name": "Robin",
        "content": content,
        "timestamp": datetime.now().isoformat(),
        "color": "#f59e0b",
        "brief": room.get("current_brief") if brief.get("goal") else None,
    }
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if room:
        room["messages"].append(msg)
        _save_arena_rooms(rooms)

    await _broadcast_all_ws({
        "type": "arena.message",
        "room_id": room_id,
        "message": msg,
    })
    await _broadcast_all_ws({
        "type": "arena.mode_change",
        "room_id": room_id,
        "mode": "execute",
        "turns_left": execution_turns,
    })

    return web.json_response({"ok": True, "tools_enabled": True, "execution_turns_left": execution_turns})


async def api_arena_orchestrator_chat(request):
    """POST /api/arena/rooms/{id}/orchestrator  -  Chat with the orchestrator about the discussion."""
    room_id = request.match_info["id"]
    body = await request.json()
    user_msg = body.get("message", "").strip()
    if not user_msg:
        raise web.HTTPBadRequest(reason="No message provided")

    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")

    # Build context from discussion
    recent_msgs = room.get("messages", [])[-30:]
    history_lines = [f"{m['name']}: {m['content']}" for m in recent_msgs]
    history_block = "\n\n".join(history_lines) if history_lines else "(Keine Nachrichten)"

    # Get existing summary if any
    existing_summary = room.get("orchestrator_summary", "")
    summary_ctx = f"\n\nLetzte Zusammenfassung des Orchestrators:\n{existing_summary}" if existing_summary else ""

    prompt = (
        f"Du bist der Orchestrator/Richter einer Bot-Diskussion. "
        f"Dein Job: Die Diskussion analysieren, zusammenfassen und Robin beraten.\n\n"
        f"Thema: {room.get('topic', 'Freie Diskussion')}\n\n"
        f"Bisherige Diskussion ({len(room.get('messages', []))} Nachrichten):\n{history_block}"
        f"{summary_ctx}\n\n"
        f"Robin fragt dich: {user_msg}\n\n"
        f"Antworte kurz, strukturiert, auf Deutsch. Wenn Robin fragt ob etwas umgesetzt werden soll, "
        f"gib konkrete Schritte. Wenn er Aenderungen will, schlage angepasste Plaene vor."
    )

    # Prompt via stdin - umgeht Windows 32K command-line limit
    cmd = [
        CLAUDE_EXE, "-p",
        "--model", "opus",
        "--output-format", "text",
        "--tools", "",
        "--max-turns", "1",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        stdout_data, stderr_data = await asyncio.wait_for(
            proc.communicate(input=prompt.encode("utf-8")), timeout=120
        )
        response = stdout_data.decode("utf-8", errors="replace").strip()
        if "Reached max turns" in response:
            lines = [l for l in response.splitlines() if "Reached max turns" not in l and "Error:" not in l]
            response = "\n".join(lines).strip()
        if not response:
            err = stderr_data.decode("utf-8", errors="replace").strip()[:300]
            response = f"(Keine Antwort vom Orchestrator — stderr: {err or 'leer'})"
    except asyncio.TimeoutError:
        response = "(Timeout — Orchestrator hat zu lange gebraucht)"
    except Exception as e:
        response = f"(Fehler: {e})"

    return web.json_response({"response": response})


async def api_arena_summarize(request):
    """POST /api/arena/rooms/{id}/summarize  -  Generate orchestrator summary on demand."""
    room_id = request.match_info["id"]
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")

    summary = await _generate_orchestrator_summary(room)

    # Save summary to room
    room["orchestrator_summary"] = summary
    room["orchestrator_summary_at"] = datetime.now().isoformat()
    _save_arena_rooms(rooms)

    # Also add as system message
    msg = {
        "role": "orchestrator",
        "name": "Orchestrator",
        "content": summary,
        "timestamp": datetime.now().isoformat(),
        "color": "#a855f7",
        "turn": len(room.get("messages", [])),
    }
    room["messages"].append(msg)
    _save_arena_rooms(rooms)

    await _broadcast_all_ws({
        "type": "arena.message",
        "room_id": room_id,
        "message": msg,
    })

    return web.json_response({"summary": summary})


async def api_arena_approve(request):
    """POST /api/arena/rooms/{id}/approve  -  Approve selected actions for execution by a separate bot."""
    room_id = request.match_info["id"]
    body = await request.json()
    actions_raw = body.get("actions", [])
    # Deduplicate: keep first occurrence, case-insensitive key
    seen_keys: set = set()
    actions = []
    for a in actions_raw:
        key = a.strip().lower()
        if key and key not in seen_keys:
            seen_keys.add(key)
            actions.append(a)
    rejected = body.get("rejected", [])  # Gegenstimmen: nicht-angewaehlte Alternativen
    rej_reason = (body.get("reject_reason") or "").strip()
    if not actions:
        return web.json_response({"ok": False, "error": "Keine Aktionen ausgewaehlt"})

    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")

    # Dedup gegen echten Raumzustand: bereits erfolgreich abgeschlossene Aktionen überspringen
    done_actions: set = set(room.get("done_actions", []))
    already_done = [a for a in actions if a.strip().lower() in done_actions]
    actions = [a for a in actions if a.strip().lower() not in done_actions]
    if not actions:
        return web.json_response({"ok": False, "error": "Alle Aktionen bereits abgeschlossen", "already_done": already_done})

    # Create approval message with tracked per-action status
    approval_id = f"appr-{int(datetime.now().timestamp()*1000)}"
    approval_msg = {
        "role": "approval",
        "name": "Robin",
        "approval_id": approval_id,
        "actions": [{"text": a, "status": "pending", "result": ""} for a in actions],
        "rejected": [{"text": r, "reason": rej_reason} for r in rejected],
        "content": (
            f"**Gruenes Licht** fuer {len(actions)} Aktion(en) — Umsetzung laeuft."
            + (f"  · {len(rejected)} Alternativ-Weg(e) verworfen (bleiben sichtbar)." if rejected else "")
        ),
        "timestamp": datetime.now().isoformat(),
        "color": "#f59e0b",
        "turn": len(room.get("messages", [])),
    }
    room["messages"].append(approval_msg)
    _save_arena_rooms(rooms)
    await _broadcast_all_ws({
        "type": "arena.message",
        "room_id": room_id,
        "message": approval_msg,
    })

    # Log each approved action as queued event
    for i, a in enumerate(actions):
        _append_action_log({
            "event": "action.queued",
            "room_id": room_id,
            "approval_id": approval_id,
            "action_idx": i,
            "action": a,
            "topic": room.get("topic", ""),
        })

    # Spawn executor bot in background (does NOT stop the discussion)
    asyncio.ensure_future(_run_executor(room_id, approval_id, actions))

    return web.json_response({"ok": True, "actions": len(actions), "approval_id": approval_id})


async def api_arena_file_peek(request):
    """GET /api/arena/file-peek?path=...  -  Return current file content + optional git diff.

    Used by the arena preview modal: Robin clicks a file path in the list, and
    the frontend opens an inline viewer with the current content (so he can
    check what the executor is about to touch). If the file has uncommitted
    changes relative to HEAD, we include the diff. If the file does not yet
    exist (will be created by the executor), we return an empty-ok marker.
    """
    raw = (request.query.get("path") or "").strip()
    if not raw:
        return web.json_response({"ok": False, "error": "path missing"}, status=400)
    # Normalize + contain inside Jarvis
    rel = raw.replace("\\", "/").lstrip("/")
    if ".." in rel.split("/"):
        return web.json_response({"ok": False, "error": "path traversal"}, status=400)
    JARVIS_ROOT = Path("C:/Users/Robin/Jarvis")
    target = (JARVIS_ROOT / rel).resolve()
    try:
        target.relative_to(JARVIS_ROOT.resolve())
    except Exception:
        return web.json_response({"ok": False, "error": "outside jarvis"}, status=400)
    if not target.exists():
        return web.json_response({
            "ok": True, "path": rel, "exists": False,
            "content": "", "diff": "", "size": 0,
            "note": "Datei existiert noch nicht — wird vom Executor neu angelegt."
        })
    if target.is_dir():
        return web.json_response({"ok": False, "error": "is a directory"}, status=400)
    try:
        size = target.stat().st_size
        # 300 KB cap — keep the modal fast
        if size > 300_000:
            return web.json_response({
                "ok": True, "path": rel, "exists": True,
                "size": size, "content": "", "diff": "",
                "note": f"Datei ist {size // 1024} KB — zu gross fuer Inline-Preview."
            })
        content = target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return web.json_response({"ok": False, "error": f"read failed: {e}"}, status=500)
    # Best-effort git diff HEAD -- <rel>
    diff_text = ""
    try:
        import subprocess
        proc = subprocess.run(
            ["git", "diff", "HEAD", "--", rel],
            cwd=str(JARVIS_ROOT), capture_output=True, text=True, timeout=3,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            diff_text = proc.stdout
            if len(diff_text) > 80_000:
                diff_text = diff_text[:80_000] + "\n... (gekuerzt)"
    except Exception:
        pass
    return web.json_response({
        "ok": True, "path": rel, "exists": True, "size": size,
        "content": content, "diff": diff_text,
    })


async def api_arena_files_status(request):
    """GET /api/arena/files-status?paths=a,b,c  -  Return existence + plausibility per path.

    Response: {ok: True, status: {path: bool}, plausible: {path: bool}}

    - status[p] = True  -> file exists at that relative path
    - plausible[p] = True -> file exists OR its parent directory exists
                             (so the executor could realistically create it there).
      False means the path looks like a hallucinated/fantasy name (e.g. "example.py"
      with no real parent in the repo) and the UI should hide it to avoid false hits.
    """
    raw = (request.query.get("paths") or "").strip()
    if not raw:
        return web.json_response({"ok": True, "status": {}, "plausible": {}})
    JARVIS_ROOT = Path("C:/Users/Robin/Jarvis")
    root_res = JARVIS_ROOT.resolve()
    status: dict = {}
    plausible: dict = {}
    items = [p.strip() for p in raw.replace("\n", ",").split(",") if p.strip()]
    for rel in items[:200]:
        norm = rel.replace("\\", "/").lstrip("/")
        if ".." in norm.split("/"):
            status[rel] = False
            plausible[rel] = False
            continue
        try:
            tgt = (JARVIS_ROOT / norm).resolve()
            tgt.relative_to(root_res)
            exists = tgt.exists() and tgt.is_file()
            status[rel] = exists
            if exists:
                plausible[rel] = True
            else:
                # Plausible only if parent dir exists AND path has a real dir segment.
                # A bare "example.py" with no slash is never plausible here.
                parts = norm.split("/")
                if len(parts) < 2:
                    plausible[rel] = False
                else:
                    parent = tgt.parent
                    try:
                        parent.relative_to(root_res)
                        plausible[rel] = parent.exists() and parent.is_dir()
                    except Exception:
                        plausible[rel] = False
        except Exception:
            status[rel] = False
            plausible[rel] = False
    return web.json_response({"ok": True, "status": status, "plausible": plausible})


# Cache fuer tiefe Vorschauen - gleicher Aktions-Block -> gleiches Ergebnis.
# Verhindert doppelte Claude-Calls in schneller Folge. In-memory, flueht bei Restart.
_DEEP_PREVIEW_CACHE: dict[str, tuple[float, list]] = {}
_DEEP_PREVIEW_TTL = 900  # 15 min


async def api_arena_deep_preview(request):
    """POST /api/arena/deep-preview  -  LLM-basierte Datei-Vorhersage.

    Fallback fuer die schnelle Regex-Vorschau (extractFilePreview in arena.js):
    Wenn das Regex-Muster keine plausiblen Pfade findet, ruft das Frontend
    diesen Endpoint ("tiefe Analyse nur bei Bedarf"). Antwortet mit einer
    kurzen Liste wahrscheinlich betroffener Dateien, basierend auf Topic +
    Aktionstexten.

    Request JSON: {actions: [str, ...], topic: str}
    Response JSON: {ok, files:[...], cached:bool, mode:"llm"|"empty"}
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    actions = [str(a or "").strip() for a in (body.get("actions") or []) if str(a or "").strip()]
    topic = str(body.get("topic") or "").strip()
    if not actions:
        return web.json_response({"ok": True, "files": [], "cached": False, "mode": "empty"})

    import hashlib as _hl
    key_src = topic + "\n---\n" + "\n".join(actions)
    cache_key = _hl.sha1(key_src.encode("utf-8", errors="replace")).hexdigest()
    now_ts = time.time()
    hit = _DEEP_PREVIEW_CACHE.get(cache_key)
    if hit and (now_ts - hit[0]) < _DEEP_PREVIEW_TTL:
        return web.json_response({"ok": True, "files": hit[1], "cached": True, "mode": "llm"})

    act_block = "\n".join(f"- {a}" for a in actions[:20])
    prompt = (
        "Du analysierst Bot-Arena-Aktionen und schaetzt, welche Dateien im Repo "
        "C:/Users/Robin/Jarvis davon betroffen sein werden.\n\n"
        f"Thema: {topic or '(unbekannt)'}\n\n"
        f"Aktionen:\n{act_block}\n\n"
        "Antworte AUSSCHLIESSLICH mit einer JSON-Liste relativer Pfade "
        "(max. 15). Keine Prosa, keine Markierungen, nur gueltiges JSON.\n"
        'Beispiel: ["Mission-Control/server.py", "Mission-Control/static/js/arena.js"]'
    )
    cmd = [
        CLAUDE_EXE, "-p",
        "--model", "sonnet",
        "--output-format", "text",
        "--tools", "",
        "--max-turns", "1",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        stdout_data, _ = await asyncio.wait_for(
            proc.communicate(input=prompt.encode("utf-8")), timeout=60
        )
        raw = stdout_data.decode("utf-8", errors="replace").strip()
        import re as _re
        m = _re.search(r"\[[^\[\]]*\]", raw, _re.DOTALL)
        files: list = []
        if m:
            try:
                parsed = json.loads(m.group(0))
                if isinstance(parsed, list):
                    files = [str(x).strip().replace("\\", "/").lstrip("./")
                             for x in parsed if isinstance(x, str) and x.strip()]
            except Exception:
                files = []
        seen = set()
        uniq: list = []
        for f in files:
            if f and f not in seen and len(f) > 2 and "." in f:
                seen.add(f)
                uniq.append(f)
            if len(uniq) >= 15:
                break
        _DEEP_PREVIEW_CACHE[cache_key] = (now_ts, uniq)
        return web.json_response({"ok": True, "files": uniq, "cached": False, "mode": "llm"})
    except asyncio.TimeoutError:
        return web.json_response({"ok": False, "error": "timeout"}, status=504)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)


async def api_arena_continue(request):
    """POST /api/arena/rooms/{id}/continue  -  Inject executor summary and resume discussion."""
    room_id = request.match_info["id"]
    body = await request.json()
    context_summary = body.get("context", "").strip()

    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        raise web.HTTPNotFound(reason="Room not found")

    inject_text = f"Folgende Schritte wurden gerade umgesetzt:\n\n{context_summary}\n\nBitte diskutiert weiter — was ist als naechstes sinnvoll?"
    msg = {
        "role": "robin",
        "name": "Robin",
        "content": inject_text,
        "timestamp": datetime.now().isoformat(),
        "color": "#f59e0b",
    }
    room["messages"].append(msg)
    _save_arena_rooms(rooms)
    await _broadcast_all_ws({"type": "arena.message", "room_id": room_id, "message": msg})

    # Re-start discussion from where we left off — but not if session went stale
    if room_id not in _arena_rooms or not _arena_rooms[room_id].get("running"):
        if _room_is_stale(room):
            stale_msg = {
                "role": "system",
                "name": "System",
                "content": "Session war >5 min still — kein automatischer Neustart. [Start] klicken um fortzufahren.",
                "timestamp": datetime.now().isoformat(),
                "color": "#6b7280",
            }
            room["messages"].append(stale_msg)
            _save_arena_rooms(rooms)
            await _broadcast_all_ws({"type": "arena.message", "room_id": room_id, "message": stale_msg})
        else:
            _arena_rooms[room_id] = {"running": True, "process": None}
            asyncio.create_task(_run_arena(room_id))

    return web.json_response({"ok": True})


ACTIONS_LOG = DATA_DIR / "actions.jsonl"
PREVIEW_OUTCOMES_LOG = DATA_DIR / "preview-outcomes.jsonl"

# Spiegelt die Vorschau-Regex aus static/js/arena.js (extractFilePreview).
# Wenn sich die Frontend-Regex aendert, MUSS diese hier mitziehen, sonst
# driftet die Lern-Statistik auseinander.
_PREVIEW_EXTS = (
    "py|js|ts|tsx|jsx|mjs|cjs|md|json|html|htm|css|scss|yaml|yml|sh|ps1|"
    "bat|toml|ini|cfg|txt|xml|svg|vue|rs|go|java|cpp|hpp|c|h|rb|php|sql|env"
)
_PREVIEW_PATH_RE = re.compile(r"([A-Za-z0-9_./\\-]+\.(?:" + _PREVIEW_EXTS + r"))\b")
_PREVIEW_DIR_RE = re.compile(r"(?:^|\s|`|\")([A-Za-z0-9_-]+/[A-Za-z0-9_./\\-]+)(?=\s|`|\"|$|,|;|\))")


def _predict_files_from_action(action_text: str) -> list:
    """Dieselbe Heuristik wie die UI-Vorschau — damit wir serverseitig
    nachrechnen koennen, was die schnelle Vorschau *geraten* haette."""
    files = set()
    txt = str(action_text or "")
    for m in _PREVIEW_PATH_RE.finditer(txt):
        p = m.group(1).replace("\\", "/").lstrip("./")
        if len(p) > 2 and not re.match(r"^\d+\.", p):
            files.add(p)
    for m in _PREVIEW_DIR_RE.finditer(txt):
        p = m.group(1).replace("\\", "/")
        if "." in p and len(p) > 3:
            files.add(p)
    return sorted(files)


def _log_preview_outcome(*, room_id: str, approval_id: str, action_idx: int,
                         action: str, changed_files: list, ok: bool) -> None:
    """Vergleicht die Vorschau-Schaetzung mit den Dateien, die der Executor
    tatsaechlich angefasst hat, und schreibt das Urteil nach
    data/preview-outcomes.jsonl — damit das System lernt, wann die schnelle
    Vorschau versagt (False-Negative: Executor aendert Dateien, die keiner
    erraten hat; Wrong: Vorschau hat komplett anderswohin gedeutet).

    Verdicts:
      - ok        : Vorschau deckt alle geaenderten Dateien ab
      - partial   : Vorschau hat einen Teil der Dateien vorhergesagt
      - miss      : Vorschau hat Dateien vorhergesagt, aber keine davon wurde angefasst
      - empty     : Vorschau-Heuristik fand nichts, Executor hat aber geschrieben
      - no_change : Executor hat nichts angefasst (separat auswertbar)
    """
    try:
        predicted = _predict_files_from_action(action)
        changed = [c for c in (changed_files or []) if c]
        pred_set = {p.lower() for p in predicted}
        changed_set = {c.lower() for c in changed}
        overlap = pred_set & changed_set

        if not changed:
            verdict = "no_change"
        elif not predicted:
            verdict = "empty"
        elif not overlap:
            verdict = "miss"
        elif overlap == changed_set:
            verdict = "ok"
        else:
            verdict = "partial"

        # Nur Versagens-Faelle + seltene ok-Stichproben loggen, um das Log
        # schlank zu halten. ok wird nur bei ungewoehnlich grossen Runs
        # (>=3 Dateien) aufgenommen - als Positiv-Beleg.
        should_log = verdict != "ok" or len(changed) >= 3

        if not should_log:
            return

        payload = {
            "ts": datetime.now().isoformat(),
            "event": "preview.outcome",
            "verdict": verdict,
            "room_id": room_id,
            "approval_id": approval_id,
            "action_idx": action_idx,
            "action": (action or "")[:500],
            "predicted": predicted[:30],
            "changed": changed[:30],
            "predicted_count": len(predicted),
            "changed_count": len(changed),
            "missed": sorted(changed_set - pred_set)[:20],
            "extra": sorted(pred_set - changed_set)[:20],
            "action_ok": bool(ok),
        }
        with open(PREVIEW_OUTCOMES_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as _e:
        try:
            print(f"[preview-outcomes.jsonl] write failed: {_e}")
        except Exception:
            pass


async def api_arena_preview_misclick(request):
    """POST /api/arena/preview-misclick — User flagt einen Vorschau-Treffer als
    daneben ("Fehlklick"). Wir appenden das Signal ans preview-outcomes.jsonl,
    damit die schnelle Regex-Heuristik (extractFilePreview) spaeter nachgeschaerft
    werden kann. Das ist der *User-Kanal* zum bereits bestehenden Auto-Verdict.

    Request JSON:
      { file: str, room_id?: str, actions?: [str,...], reason?: str }
    Response: { ok: true }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    file_clicked = str(body.get("file") or "").strip()
    if not file_clicked:
        return web.json_response({"ok": False, "error": "file missing"}, status=400)
    room_id = str(body.get("room_id") or "").strip()
    reason = str(body.get("reason") or "").strip()[:200]
    actions_raw = body.get("actions") or []
    if not isinstance(actions_raw, list):
        actions_raw = []
    actions = [str(a or "").strip() for a in actions_raw if str(a or "").strip()][:20]
    action_blob = "\n".join(actions)[:2000]
    predicted = _predict_files_from_action(action_blob) if action_blob else []
    payload = {
        "ts": datetime.now().isoformat(),
        "event": "preview.misclick",
        "verdict": "misclick",
        "room_id": room_id,
        "file": file_clicked.replace("\\", "/"),
        "reason": reason,
        "predicted": predicted[:30],
        "predicted_count": len(predicted),
        "actions": actions,
    }
    try:
        with open(PREVIEW_OUTCOMES_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)
    return web.json_response({"ok": True})


async def api_arena_preview_stats(request):
    """GET /api/arena/preview-stats — zeigt, was die schnelle Vorschau am oeftesten
    daneben legt. Liest die letzten N Zeilen aus preview-outcomes.jsonl und aggregiert
    Fehlklicks + Auto-Miss-Verdicts nach Dateiendung und Token.
    """
    try:
        limit = int(request.query.get("limit", "500"))
    except Exception:
        limit = 500
    limit = max(50, min(limit, 5000))
    lines: list[str] = []
    try:
        with open(PREVIEW_OUTCOMES_LOG, "r", encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
    except FileNotFoundError:
        return web.json_response({"ok": True, "count": 0, "misclicks": [], "verdicts": {}})
    misclick_files: dict[str, int] = {}
    verdict_counts: dict[str, int] = {}
    total = 0
    for ln in lines:
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        total += 1
        v = ev.get("verdict") or ev.get("event") or "?"
        verdict_counts[v] = verdict_counts.get(v, 0) + 1
        if ev.get("event") == "preview.misclick":
            f = (ev.get("file") or "").lower()
            if f:
                misclick_files[f] = misclick_files.get(f, 0) + 1
    top_misclicks = sorted(misclick_files.items(), key=lambda kv: -kv[1])[:20]
    return web.json_response({
        "ok": True,
        "count": total,
        "misclicks": [{"file": f, "count": c} for f, c in top_misclicks],
        "verdicts": verdict_counts,
    })


def _append_action_log(event: dict) -> None:
    """Append a single action event to data/actions.jsonl (best-effort, non-blocking)."""
    try:
        payload = {"ts": datetime.now().isoformat(), **event}
        with open(ACTIONS_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as _e:
        try:
            print(f"[actions.jsonl] write failed: {_e}")
        except Exception:
            pass


async def _update_approval_action(room_id: str, approval_id: str, action_idx: int, status: str, result: str = ""):
    """Persist per-action status change and broadcast to UI."""
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    action_text = ""
    if room:
        for m in room.get("messages", []):
            if m.get("approval_id") == approval_id and m.get("role") == "approval":
                if 0 <= action_idx < len(m.get("actions", [])):
                    m["actions"][action_idx]["status"] = status
                    if result:
                        m["actions"][action_idx]["result"] = result
                    action_text = m["actions"][action_idx].get("text", "")
                break
        _save_arena_rooms(rooms)
    _append_action_log({
        "event": f"action.{status}",
        "room_id": room_id,
        "approval_id": approval_id,
        "action_idx": action_idx,
        "action": action_text,
        "status": status,
        "result": result[:500] if result else "",
    })
    await _broadcast_all_ws({
        "type": "arena.action.status",
        "room_id": room_id,
        "approval_id": approval_id,
        "action_idx": action_idx,
        "status": status,
        "result": result,
    })


def _detect_file_changes_since(start_ts: float, max_files: int = 20) -> list:
    """Walk the Jarvis repo and return files modified/created since start_ts.
    Skips noisy directories (caches, logs, auto-memory, node_modules).
    Cheap enough for 10-minute executor runs - only stats existing files.
    """
    root = "C:/Users/Robin/Jarvis"
    skip_dirs = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        "data",  # Mission-Control/data holds logs+sessions that mutate on their own
        "Jarvis-Memory",  # Obsidian auto-updates
        ".claude-flow", ".swarm", ".hive-mind",
    }
    changed = []
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
            for fn in filenames:
                if fn.endswith((".pyc", ".log")) or fn.startswith("."):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    mt = os.path.getmtime(full)
                except OSError:
                    continue
                if mt >= start_ts:
                    rel = os.path.relpath(full, root).replace("\\", "/")
                    changed.append(rel)
                    if len(changed) >= max_files:
                        return changed
    except Exception:
        pass
    return changed


# --- Executor Budget-Stufen ------------------------------------------------
# Kleine Aufgaben fressen weniger: günstiges Modell, weniger Turns, kürzerer
# Timeout. Grosse bekommen Opus + voller Spielraum. Heuristik greift auf
# Action-Text-Länge und Schlüsselwörter zu; bei Unsicherheit "medium".
EXECUTOR_BUDGETS = {
    "small":  {"model": "haiku",  "max_turns": 10, "timeout": 180, "tool_calls_hint": 8},
    "medium": {"model": "sonnet", "max_turns": 20, "timeout": 360, "tool_calls_hint": 18},
    "large":  {"model": "opus",   "max_turns": 40, "timeout": 900, "tool_calls_hint": 35},
}

_LARGE_HINTS = (
    "refactor", "umbau", "umschreiben", "neu aufbauen", "integrier",
    "architektur", "migration", "rewrite", "komplett", "end-to-end",
    "mehrere module", "system", "pipeline", "neu strukturier",
    "spracherkennung", "voice pipeline", "speech recognition", "audio pipeline",
    "transkription einricht", "tts integrier", "voice system",
)
_SMALL_HINTS = (
    "typo", "rechtschreib", "rename", "umbenenn", "log-message", "log message",
    "kommentar", "konstante", "config-wert", "zeile", "flag umstell",
    "import ", "einzeiler", "eine zeile", "feld hinzuf", "farbe",
    "stimme wechsel", "voice switch", "voice id", "stimme umstell",
    "mikrofon", "mikro ein", "mikro aus", "mute", "unmute",
    "tts aktiv", "tts deaktiv", "tts umstell", "voice key",
)


def _classify_action_size(action: str) -> str:
    """Grobe Heuristik: small/medium/large. Reihenfolge:
    1. Explizite Keywords (large überstimmt small bei Konflikt)
    2. Länge der Action-Beschreibung als Tiebreaker.
    """
    text = (action or "").strip().lower()
    if not text:
        return "medium"
    has_large = any(h in text for h in _LARGE_HINTS)
    has_small = any(h in text for h in _SMALL_HINTS)
    if has_large and not has_small:
        return "large"
    if has_small and not has_large:
        return "small"
    # Längen-Fallback: sehr kurze Beschreibungen → klein, sehr lange → groß
    n = len(text)
    if n < 60:
        return "small"
    if n > 260:
        return "large"
    return "medium"


async def _run_single_action(topic: str, project_context: str, action: str, executor_bot: dict | None = None, changed_out: list | None = None, size: str | None = None) -> tuple:
    """Run one action via Claude subprocess. Returns (ok, result_text).

    Verification: action only counts as 'done' when at least one file was
    actually modified during the run. Pure-text responses are downgraded to
    failure so the arena UI does not falsely claim 'Fertig'.

    executor_bot: {name, persona} - if given, the bot takes on this role so
    the executor persona rotates across the team (each bot carries weight).

    size: 'small' | 'medium' | 'large' — steuert Modell, Max-Turns und Timeout.
    Wenn None, wird per Heuristik aus dem Action-Text geraten.
    """
    tier = size if size in EXECUTOR_BUDGETS else _classify_action_size(action)
    budget = EXECUTOR_BUDGETS[tier]
    if executor_bot:
        role_intro = (
            f"Du bist {executor_bot.get('name','Executor')} und uebernimmst diesmal die Umsetzer-Rolle "
            f"aus der Bot-Diskussion. Deine Persona: {executor_bot.get('persona','')}\n"
            f"Robin hat eine einzelne Aktion genehmigt — setz sie in deinem Stil um, "
            f"aber bleib pragmatisch und lieferbereit.\n\n"
        )
    else:
        role_intro = "Du bist der Executor-Bot. Robin hat eine einzelne Aktion aus einer Bot-Diskussion genehmigt.\n\n"
    if predecessor_failure:
        role_intro += (
            f"HINWEIS: Ein vorheriger Executor-Bot hat diese Aktion bereits versucht und ist gescheitert.\n"
            f"Grund des Scheiterns: {predecessor_failure[:400]}\n"
            f"Vermeide denselben Fehler. Geh die Sache anders an.\n\n"
        )
    prompt = (
        role_intro + (
        f"Diskussions-Thema: {topic}\n\n"
        f"=== PROJEKT-KONTEXT ===\n{project_context}\n=== ENDE KONTEXT ===\n\n"
        f"Diese konkrete Aktion sollst du jetzt umsetzen:\n\n>>> {action} <<<\n\n"
        f"Du hast Zugriff auf alle Tools (Read, Write, Edit, Bash, Glob, Grep).\n"
        f"Arbeitsverzeichnis: C:/Users/Robin/Jarvis\n\n"
        f"GUARDRAIL — Klarer Auftrag zwingend:\n"
        f"- Die oben in >>> <<< stehende Aktion ist dein EINZIGER Auftrag. Nichts anderes.\n"
        f"- Ist der Auftrag vage, mehrdeutig oder bloss ein Diskussionsfragment ohne konkretes Ziel: "
        f"KEINE Dateien anfassen (kein Write, kein Edit, kein Bash-Schreibkommando). "
        f"Stattdessen in 1-3 Saetzen erklaeren was unklar ist und welche Praezisierung Robin liefern soll.\n"
        f"- Bei unklarem Auftrag: nur Read/Glob/Grep zum Nachsehen, nicht zum Umbauen.\n"
        f"- Scope-Creep verboten: keine 'waehrend ich dabei bin'-Refactors, keine Zusatz-Features, "
        f"keine Aufraeumarbeiten ausserhalb der genehmigten Aktion.\n\n"
        f"WICHTIG — Pragmatischer Modus (Budget-Stufe: {tier.upper()}):\n"
        f"- Du hast nur ~{budget['tool_calls_hint']} Tool-Calls Budget. Plane sparsam.\n"
        f"- Wenn die Aktion zu gross fuer einen Schritt ist: mach den ERSTEN sinnvollen Teil "
        f"(z.B. ersten Prototyp, erstes Geruest, ersten Endpoint) und beschreibe was noch fehlt.\n"
        f"- Lieber 1 fertiges Teilstueck als 0 fertige Sachen.\n"
        f"- Bei Code-Aenderungen: KEINE riesigen Refactors. Minimaler Diff der die Aktion umsetzt.\n\n"
        f"Am Ende antworte mit einer 1-3 Satz Zusammenfassung: was du getan hast UND was noch offen ist.\n"
        f"Wenn die Aktion unmoeglich oder unklar ist: kurz erklaeren warum und Vorschlag was Robin tun soll."
        )
    )
    cmd = [
        CLAUDE_EXE, "-p", prompt,
        "--model", budget["model"],
        "--output-format", "text",
        "--max-turns", str(budget["max_turns"]),
        "--permission-mode", "bypassPermissions",
    ]
    proc = None
    # Snapshot before run - allow a tiny clock-skew tolerance so edits that land
    # in the same second as start_ts still register.
    start_ts = time.time() - 1.0
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        stdout_data, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=budget["timeout"])
        stdout = stdout_data.decode("utf-8", errors="replace").strip()
        stderr = stderr_data.decode("utf-8", errors="replace").strip()
        rc = proc.returncode

        # Detect Claude usage/rate-limit responses - these must NEVER count as success.
        # Patterns seen in practice: "You've hit your limit · resets 2am (Europe/Berlin)",
        # "Claude AI usage limit reached", "rate limit", "5-hour limit".
        combined = f"{stdout}\n{stderr}"
        lowered = combined.lower()
        limit_markers = (
            "you've hit your limit",
            "you have hit your limit",
            "usage limit reached",
            "usage limit exceeded",
            "rate limit",
            "5-hour limit",
            "quota exceeded",
            "resets " ,  # "resets 2am ..." - only appears in limit responses
        )
        # Require that the output is ALSO short (real work produces paragraphs).
        # A limit message is typically one short line; guard against false positives.
        if any(m in lowered for m in limit_markers) and len(stdout) < 400:
            first_line = stdout.splitlines()[0].strip() if stdout else stderr[:200]
            return False, f"(Claude-Limit erreicht, keine Umsetzung: {first_line})"

        # Verify the run actually touched the repo. Run this once and reuse
        # the result for both max-turns and normal-exit paths.
        loop = asyncio.get_event_loop()
        changed_files = await loop.run_in_executor(None, _detect_file_changes_since, start_ts)
        if changed_out is not None:
            changed_out.extend(changed_files or [])
        if changed_files:
            files_note = "\n\nGeaenderte Dateien (" + str(len(changed_files)) + "): " + ", ".join(changed_files[:10])
            if len(changed_files) > 10:
                files_note += ", ..."
        else:
            files_note = ""

        hit_max = "Reached max turns" in stdout
        if hit_max:
            cleaned = "\n".join(
                l for l in stdout.splitlines()
                if "Reached max turns" not in l and not l.strip().startswith("Error:")
            ).strip()
            if cleaned:
                if not changed_files:
                    return False, cleaned + f"\n\n(Max-Turns [{tier}] erreicht UND keine Datei geaendert - Pruefung fehlgeschlagen.)"
                return True, f"[Stufe: {tier} · {budget['model']}]\n" + cleaned + files_note + f"\n\n(Hinweis: Max-Turns [{tier}] erreicht - moeglicherweise nicht komplett)"
            return False, f"(Aktion zu gross fuer Executor-Stufe [{tier}] - {budget['max_turns']} Tool-Calls aufgebraucht ohne Ergebnis. Bitte in kleinere Schritte aufteilen oder als 'large' markieren.)"

        if not stdout:
            err_preview = stderr[:300] if stderr else "(kein stderr)"
            return False, f"(Leere Antwort, rc={rc}, stderr: {err_preview})"

        # Primary verification: if the action claims 'Fertig' but nothing on disk
        # actually changed, it was just talk. Mark as 'haengend' (proposed but not implemented).
        if not changed_files:
            return None, (
                stdout
                + "\n\n(Haengend: keine Datei geaendert. "
                + "Executor hat nur geantwortet, aber nichts geschrieben.)"
            )
        return True, f"[Stufe: {tier} · {budget['model']}]\n" + stdout + files_note
    except asyncio.TimeoutError:
        if proc and proc.returncode is None:
            proc.kill()
            await proc.wait()
        mins = budget["timeout"] // 60
        return False, f"(Timeout nach {mins}min - Stufe [{tier}])"
    except Exception as e:
        return False, f"(Fehler: {e})"


def _persist_executor_results(room_id: str, topic: str, approval_id: str,
                               results: list, active_bot: dict | None) -> None:
    """Spiegelt die Executor-Ergebnisse aus der Arena in persistente Stores:

    1) Smart-Tasks (data/smart-tasks.json): jede Aktion wird als abgeschlossener
       Task angelegt (status=done bei OK, failed sonst). So erscheinen fertige
       Bot-Umsetzungen in der Smart-Tasks-Ansicht und sind durchsuchbar.
    2) Obsidian-Tageslog (Jarvis-Memory/YYYY-MM-DD.md): kurzer Eintrag mit
       Aktion + OK/FAIL + Kurzergebnis. Taucht im Brain-Index auf.

    Best-effort — Fehler werden geloggt, aber nicht geworfen.
    """
    if not results:
        return
    exec_name = active_bot.get("name") if active_bot else "Executor"
    now_iso = datetime.now().isoformat()

    # --- 1. Smart-Tasks spiegeln -----------------------------------------
    try:
        tasks = _load_smart_tasks()
        for idx, item in enumerate(results):
            if item is None:
                continue
            action, ok, result_text = item
            title = (action or "").strip().splitlines()[0][:80] or "Arena-Aktion"
            tasks.append({
                "id": str(uuid.uuid4()),
                "title": title,
                "description": action or "",
                "original_request": f"Arena-Room {room_id} — {topic}",
                "chat_context": f"approval_id={approval_id}, executor={exec_name}",
                "priority": "medium",
                "status": "done" if ok is True else ("haengend" if ok is None else "failed"),
                "created": now_iso,
                "started": now_iso,
                "completed": now_iso,
                "output": result_text or "",
                "error": "" if ok is True else (result_text or ""),
                "source": "arena",
                "room_id": room_id,
                "approval_id": approval_id,
                "executor": exec_name,
            })
        _save_smart_tasks(tasks)
    except Exception as e:
        print(f"[arena] smart-tasks persist failed: {e}")

    # --- 2. Obsidian Tageslog ergaenzen ----------------------------------
    try:
        memory_dir = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
        if memory_dir.exists():
            today = datetime.now().strftime("%Y-%m-%d")
            daily = memory_dir / f"{today}.md"
            lines = [
                f"\n## Arena-Executor ({exec_name}) — {datetime.now().strftime('%H:%M')}",
                f"*Thema:* {topic or '-'} · *Room:* `{room_id}` · *Approval:* `{approval_id}`",
                "",
            ]
            for item in results:
                if item is None:
                    continue
                action, ok, result_text = item
                mark = "OK" if ok else "FAIL"
                short = (result_text or "").strip().splitlines()
                snippet = short[0][:200] if short else ""
                lines.append(f"- **[{mark}]** {action}")
                if snippet:
                    lines.append(f"    -> {snippet}")
            lines.append("")
            block = "\n".join(lines)
            if daily.exists():
                with open(daily, "a", encoding="utf-8") as fh:
                    fh.write(block)
            else:
                daily.write_text(f"# {today}\n{block}", encoding="utf-8")
    except Exception as e:
        print(f"[arena] memory persist failed: {e}")


ARENA_EXECUTOR_MAX_PARALLEL = 5  # Hard cap: parallele Executor-Aktionen — schuetzt Context/Token-Budget

async def _run_executor(room_id: str, approval_id: str, actions: list):
    """Execute approved actions in parallel (max ARENA_EXECUTOR_MAX_PARALLEL at once) with per-action status broadcasts."""
    _activity_set("arena", active=True)
    await _broadcast_all_ws({"type": "arena.started", "room_id": room_id})
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        return

    topic = room.get("topic", "")
    project_context = _gather_arena_context()
    results = [None] * len(actions)
    sem = asyncio.Semaphore(ARENA_EXECUTOR_MAX_PARALLEL)

    # Rotierende Executor-Rolle: jeder Bot kommt reihum dran.
    bots_list = [b for b in room.get("bots", []) if b.get("name")]
    rot_idx = int(room.get("executor_rotation_idx", 0))
    active_bot = bots_list[rot_idx % len(bots_list)] if bots_list else None
    if bots_list:
        room["executor_rotation_idx"] = (rot_idx + 1) % len(bots_list)
        _save_arena_rooms(rooms)

    async def run_one(idx, action):
        async with sem:
            await _update_approval_action(room_id, approval_id, idx, "running")
            changed_seen: list = []
            ok, result_text = await _run_single_action(topic, project_context, action, active_bot, changed_out=changed_seen)
            status = "done" if ok is True else ("haengend" if ok is None else "failed")
            await _update_approval_action(room_id, approval_id, idx, status, result_text[:500])
            results[idx] = (action, ok, result_text)
            # Erfolgreiche Aktionen in Raumzustand persistieren (Dedup-Basis für künftige Approvals)
            if ok:
                _rooms_done = _load_arena_rooms()
                _room_done = _get_arena_room(_rooms_done, room_id)
                if _room_done is not None:
                    _room_done.setdefault("done_actions", [])
                    _key = action.strip().lower()
                    if _key not in _room_done["done_actions"]:
                        _room_done["done_actions"].append(_key)
                    _save_arena_rooms(_rooms_done)
            # Lern-Signal: vergleicht die schnelle Vorschau-Regex mit dem, was
            # der Executor tatsaechlich angefasst hat. Miss/empty/partial landen
            # in data/preview-outcomes.jsonl und koennen spaeter ausgewertet
            # werden, um die Vorschau-Heuristik oder Prompt-Hints zu schaerfen.
            try:
                _log_preview_outcome(
                    room_id=room_id,
                    approval_id=approval_id,
                    action_idx=idx,
                    action=action,
                    changed_files=changed_seen,
                    ok=ok,
                )
            except Exception as _pe:
                print(f"[arena] preview-outcome log failed: {_pe}")

    await asyncio.gather(*[run_one(i, a) for i, a in enumerate(actions)])

    # Auto-Persist: fertige Executor-Ergebnisse wandern automatisch in Smart-Tasks
    # (als abgeschlossene Tasks mit Output) + Obsidian-Memory (Tageslog-Eintrag).
    # So sind Bot-Aktionen ausserhalb der Arena durchsuchbar. Best-effort, darf
    # den Executor-Flow nie blockieren.
    try:
        _persist_executor_results(room_id, topic, approval_id, results, active_bot)
    except Exception as _persist_err:
        print(f"[arena] auto-persist failed: {_persist_err}")

    # Final summary message to main chat
    summary_lines = []
    for item in results:
        if item is None:
            continue
        action, ok, result_text = item
        mark = "OK" if ok else "FAIL"
        summary_lines.append(f"- [{mark}] {action}\n    -> {result_text[:300]}")
    exec_name = active_bot.get("name") if active_bot else "Executor"
    exec_color = active_bot.get("color", "#10b981") if active_bot else "#10b981"
    header = (
        f"**{exec_name} uebernimmt die Umsetzung — {len(results)} Aktion(en):**"
        if active_bot
        else f"**Umsetzung abgeschlossen ({len(results)} Aktion(en)):**"
    )
    exec_msg = {
        "role": "executor",
        "name": exec_name,
        "content": header + "\n\n" + "\n".join(summary_lines),
        "timestamp": datetime.now().isoformat(),
        "color": exec_color,
        "turn": -1,
    }
    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if room:
        room["messages"].append(exec_msg)
        _save_arena_rooms(rooms)
    await _broadcast_all_ws({
        "type": "arena.message",
        "room_id": room_id,
        "message": exec_msg,
    })
    await _broadcast_all_ws({
        "type": "arena.executor",
        "room_id": room_id,
        "status": "done",
        "actions_count": len(actions),
    })
    _activity_set("arena", active=False, pending_delta=1)
    await _broadcast_all_ws({"type": "arena.stopped", "room_id": room_id})

    # Auto-Continue: "Tueftel-Team"-Verhalten. Nach Umsetzung bewerten die Bots
    # das Executor-Ergebnis sofort selbst und schlagen Nachbesserungen vor,
    # ohne dass Robin manuell weiterklicken muss. Per room["auto_continue"]=False
    # abschaltbar. Default: an.
    if room and room.get("auto_continue", True):
        done_count = sum(1 for r in results if r and r[1])
        fail_count = sum(1 for r in results if r and not r[1])
        review_text = (
            f"Das Executor-Ergebnis liegt vor ({done_count} OK, {fail_count} FAIL). "
            f"Bewertet bitte kurz:\n"
            f"1) Ist das Umgesetzte wirklich so, wie wir es gemeint haben?\n"
            f"2) Was fehlt noch, damit die urspruengliche Aufgabe perfekt ist?\n"
            f"3) Falls noetig: schlagt konkrete naechste [ACTION]-Schritte vor.\n"
            f"Wenn alles passt: klar 'Fertig' sagen und begruenden."
        )
        review_msg = {
            "role": "robin",
            "name": "Auto-Review",
            "content": review_text,
            "timestamp": datetime.now().isoformat(),
            "color": "#f59e0b",
        }
        rooms2 = _load_arena_rooms()
        room2 = _get_arena_room(rooms2, room_id)
        if room2:
            room2["messages"].append(review_msg)
            _save_arena_rooms(rooms2)
            await _broadcast_all_ws({"type": "arena.message", "room_id": room_id, "message": review_msg})
            if room_id not in _arena_rooms or not _arena_rooms[room_id].get("running"):
                if _room_is_stale(room2):
                    stale_msg = {
                        "role": "system",
                        "name": "System",
                        "content": "Session war >5 min still — kein automatischer Neustart. [Start] klicken um fortzufahren.",
                        "timestamp": datetime.now().isoformat(),
                        "color": "#6b7280",
                    }
                    room2["messages"].append(stale_msg)
                    _save_arena_rooms(rooms2)
                    await _broadcast_all_ws({"type": "arena.message", "room_id": room_id, "message": stale_msg})
                else:
                    _arena_rooms[room_id] = {"running": True, "process": None}
                    asyncio.create_task(_run_arena(room_id))


def _extract_verdict(summary_raw: str) -> tuple[str, str]:
    """Extract [VERDICT:xxx] marker from orchestrator output.

    Returns (verdict, summary_without_marker).
    verdict is one of: ongoing, consensus, stalemate.
    Falls back to 'ongoing' if no marker found.
    """
    if not summary_raw:
        return "ongoing", summary_raw or ""
    import re as _re
    m = _re.search(r"\[VERDICT:\s*(ongoing|consensus|stalemate)\s*\]", summary_raw, _re.IGNORECASE)
    if not m:
        return "ongoing", summary_raw.strip()
    verdict = m.group(1).lower()
    cleaned = _re.sub(r"\s*\[VERDICT:[^\]]+\]\s*", "", summary_raw).strip()
    return verdict, cleaned


async def _generate_orchestrator_summary(room):
    """Generate a summary of the discussion using Claude."""
    messages = room.get("messages", [])
    if not messages:
        return "Keine Nachrichten zum Zusammenfassen."

    history_lines = [f"{m['name']}: {m['content']}" for m in messages[-40:]]
    history_block = "\n\n".join(history_lines)

    prompt = (
        f"Du bist der Orchestrator einer Bot-Diskussion. Robin ist kein Entwickler — schreib verstaendlich.\n\n"
        f"Thema: {room.get('topic', 'Freie Diskussion')}\n"
        f"Teilnehmer: {', '.join(b['name'] for b in room.get('bots', []))}\n\n"
        f"Diskussion:\n{history_block}\n\n"
        f"Schreibe ein Fazit. Halte dich genau an diese Struktur:\n\n"
        f"**Worum es geht** (1-2 Saetze, einfache Sprache, kein Technikjargon)\n\n"
        f"**Was koennen wir umsetzen**\n"
        f"Fuer JEDE moegliche Aktion eine Zeile:\n"
        f"[ACTION:BotName] <Was passiert, und was bringt das — max 12 Woerter, Alltagssprache>\n"
        f"BotName = Name des Bots der die Idee hauptsaechlich einbrachte (z.B. Alpha, Beta, Gamma, Delta).\n\n"
        f"Regeln:\n"
        f"- Keine Fachbegriffe ohne Erklaerung\n"
        f"- Sag was Robin davon hat, nicht wie es technisch laeuft\n"
        f"- Nur umsetzbare Aktionen (keine vagen Ideen)\n"
        f"- Kein 'warte auf gruenes Licht', keine Rueckfragen\n"
        f"- Deutsch, kurz, klar.\n\n"
        f"Am Ende, auf einer eigenen letzten Zeile, EXAKT einen dieser Marker:\n"
        f"[VERDICT:ongoing] - Bots bringen noch neue Punkte, weiterdiskutieren lohnt\n"
        f"[VERDICT:consensus] - Bots sind sich einig, Plan steht, Robin sollte entscheiden/freigeben\n"
        f"[VERDICT:stalemate] - Bots drehen sich im Kreis, kein Fortschritt, Robin muss eingreifen\n\n"
        f"HARTE REGEL — keine Fantasiezahlen bei Runden/Aufwand:\n"
        f"- Falls du einen Aufwand in Runden oder Iterationen nennst: HARTE OBERGRENZE 10 Runden.\n"
        f"- Niemals '20 Runden', '50 Iterationen', 'Monate' o.ae. — Arena ist auf <=10 Runden gedeckelt.\n"
        f"- Passt eine Aktion nicht in <=10 Runden: in kleinere [ACTION]-Schritte aufteilen, statt hohe Zahlen zu erfinden."
    )

    # Prompt via stdin statt argv - umgeht Windows 32K command-line limit
    cmd = [
        CLAUDE_EXE, "-p",
        "--model", "opus",
        "--output-format", "text",
        "--tools", "",
        "--max-turns", "1",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        stdout_data, stderr_data = await asyncio.wait_for(
            proc.communicate(input=prompt.encode("utf-8")), timeout=180
        )
        response = stdout_data.decode("utf-8", errors="replace").strip()
        if "Reached max turns" in response:
            lines = [l for l in response.splitlines() if "Reached max turns" not in l and "Error:" not in l]
            response = "\n".join(lines).strip()
        if not response:
            err = stderr_data.decode("utf-8", errors="replace").strip()[:400]
            return f"Zusammenfassung konnte nicht generiert werden. (stderr: {err or 'leer'})"
        return response
    except Exception as e:
        return f"Fehler bei Zusammenfassung: {e}"


def _gather_arena_context() -> str:
    """Gather current project context so arena bots know what exists."""
    ctx_parts = []
    # 1. CLAUDE.md — project identity
    claude_md = Path("C:/Users/Robin/Jarvis/CLAUDE.md")
    if claude_md.exists():
        txt = claude_md.read_text(encoding="utf-8", errors="replace")[:2000]
        ctx_parts.append(f"=== CLAUDE.md (Projekt-Identitaet) ===\n{txt}")
    # 2. MC config
    mc_cfg = Path("C:/Users/Robin/Jarvis/Mission-Control/config.json")
    if mc_cfg.exists():
        txt = mc_cfg.read_text(encoding="utf-8", errors="replace")[:1500]
        ctx_parts.append(f"=== Mission Control config.json ===\n{txt}")
    # 3. MC file structure (top-level + static/js files)
    mc_dir = Path("C:/Users/Robin/Jarvis/Mission-Control/static/js")
    if mc_dir.exists():
        js_files = sorted(f.name for f in mc_dir.iterdir() if f.is_file())
        ctx_parts.append(f"=== MC Frontend JS-Module ===\n{', '.join(js_files)}")
    # 4. Server routes (grep for app.router.add)
    server_py = Path("C:/Users/Robin/Jarvis/Mission-Control/server.py")
    if server_py.exists():
        lines = server_py.read_text(encoding="utf-8", errors="replace").splitlines()
        routes = [l.strip() for l in lines if "app.router.add" in l][:40]
        if routes:
            ctx_parts.append(f"=== MC Backend Routes ===\n" + "\n".join(routes))
    # 5. Brain structure (Obsidian vault top-level)
    brain_dir = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
    if brain_dir.exists():
        brain_files = sorted(f.name for f in brain_dir.iterdir() if f.is_file())[:30]
        ctx_parts.append(f"=== Obsidian Brain (Jarvis-Memory) ===\n{', '.join(brain_files)}")
    # 6. Skills
    skills_dir = Path("C:/Users/Robin/Jarvis/skills")
    if skills_dir.exists():
        skill_names = sorted(d.name for d in skills_dir.iterdir() if d.is_dir())[:20]
        ctx_parts.append(f"=== Installierte Skills ({len(skill_names)}) ===\n{', '.join(skill_names)}")
    # 7. Available APIs/integrations (explicit so bots know what's real)
    scripts_dir = Path("C:/Users/Robin/Jarvis/scripts")
    if scripts_dir.exists():
        script_names = sorted(f.name for f in scripts_dir.iterdir() if f.is_file() and f.suffix == ".py")
        ctx_parts.append(
            f"=== Vorhandene Integrations-Scripts ===\n{', '.join(script_names)}\n"
            f"HINWEIS: outlook_graph.py = Outlook/Email API (konfiguriert, laeuft), "
            f"alpaca_*.py = Trading API (Alpaca, konfiguriert), "
            f"telegram_bridge.py = Telegram Bot (laeuft), "
            f"icloud_*.py = iCloud Kalender (konfiguriert). "
            f"Diese APIs sind BEREITS eingerichtet und funktional."
        )
    return "\n\n".join(ctx_parts)


async def _arena_healthcheck_bots(bots: list) -> dict:
    """Prueft vor jeder Runde ob alle Bots 'leben':
    - Claude-CLI erreichbar (--version Ping, <10s; bei Fehlschlag einmal nach 5s nachpingen)
    - Bot-Config valide (name, model, persona vorhanden)
    Returns: {"cli_ok": bool, "bots": {bot_name: {"alive": bool, "reason": str, "model": str}}}
    """
    async def _ping_cli() -> bool:
        try:
            proc = await asyncio.create_subprocess_exec(
                CLAUDE_EXE, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **_SUBPROCESS_FLAGS,
            )
            try:
                await asyncio.wait_for(proc.communicate(), timeout=10)
                return proc.returncode == 0
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
                return False
        except Exception:
            return False

    cli_ok = await _ping_cli()
    if not cli_ok:
        # Einmal nach 5s nachpingen bevor Bot als tot gilt
        print("[Arena] Health-Check fehlgeschlagen — retry in 5s", flush=True)
        await asyncio.sleep(5)
        cli_ok = await _ping_cli()
        if cli_ok:
            print("[Arena] Health-Check retry OK", flush=True)
        else:
            print("[Arena] Health-Check retry fehlgeschlagen — CLI tot", flush=True)

    bot_health = {}
    for bot in bots:
        name = bot.get("name") or "(unnamed)"
        model = bot.get("model") or ""
        persona = bot.get("persona") or ""
        reasons = []
        if not model:
            reasons.append("kein Model")
        if not persona.strip():
            reasons.append("keine Persona")
        if not cli_ok:
            reasons.append("Claude-CLI nicht erreichbar")
        bot_health[name] = {
            "alive": not reasons,
            "reason": "ok" if not reasons else ", ".join(reasons),
            "model": model,
        }
    return {"cli_ok": cli_ok, "bots": bot_health}


async def _run_arena(room_id: str):
    """Orchestration loop: bots take turns discussing the topic."""
    import time as _t

    rooms = _load_arena_rooms()
    room = _get_arena_room(rooms, room_id)
    if not room:
        _arena_rooms.pop(room_id, None)
        return

    bots = room.get("bots", [])
    if len(bots) < 2:
        _arena_rooms.pop(room_id, None)
        return

    topic = room.get("topic", "Freie Diskussion")

    # Rollen-Rotation: pro Runde bekommt jeder Bot eine andere Aufgabe,
    # damit nicht alle dasselbe pruefen. Rotiert zyklisch ueber Runden + Position.
    ROUND_ROLES = [
        ("Einschätzer",  "Bewerte die bisherige Diskussion: Was sind die stärksten Punkte? Was fehlt noch?"),
        ("Kritiker",     "Hinterfrage kritisch: Welche Annahmen sind schwach? Wo fehlt Evidenz oder Machbarkeit?"),
        ("Ergänzer",     "Bringe frische Aspekte rein, die noch nicht diskutiert wurden — kein Doppeln!"),
        ("Entscheider",  "Schlage eine konkrete nächste Aktion vor. Pragmatisch und direkt umsetzbar, nicht abstrakt."),
    ]

    # Harte Obergrenze: max_rounds ist die einzige Wahrheit, keine Fantasiezahlen.
    # Effektive Turns = max_rounds * len(bots). Fallback auf max_turns nur fuer Alt-Rooms.
    ROUNDS_HARD_LIMIT = 15
    hard_turn_cap = ROUNDS_HARD_LIMIT * max(1, len(bots))
    notbremse_triggered = False
    if "max_rounds" in room:
        try:
            max_rounds = max(1, min(ROUNDS_HARD_LIMIT, int(room.get("max_rounds", 3))))
        except (TypeError, ValueError):
            max_rounds = 3
        max_turns = max_rounds * max(1, len(bots))
        room["max_turns_effective"] = max_turns
    else:
        max_turns = room.get("max_turns", 20)
        if max_turns > hard_turn_cap:
            max_turns = hard_turn_cap
            notbremse_triggered = True
            room["max_turns_effective"] = max_turns
            _save_arena_rooms(rooms)

    # Gather project context once at start (so bots know what exists)
    project_context = _gather_arena_context()

    # Notify start
    room["status"] = "running"
    _save_arena_rooms(rooms)
    await _broadcast_all_ws({
        "type": "arena.started",
        "room_id": room_id,
    })

    if notbremse_triggered:
        notbremse_msg = {
            "role": "system",
            "name": "System",
            "content": f"⚠️ Notbremse aktiv: Diskussion wird nach spaetestens {ROUNDS_HARD_LIMIT} Runden ({max_turns} Turns) hart gestoppt, um Endlosschleifen zu verhindern.",
            "timestamp": datetime.now().isoformat(),
            "color": "#f59e0b",
            "turn": 0,
        }
        room["messages"].append(notbremse_msg)
        _save_arena_rooms(rooms)
        await _broadcast_all_ws({
            "type": "arena.message",
            "room_id": room_id,
            "message": notbremse_msg,
        })

    turn = 0
    bot_index = 0
    _dead_bots: set = set()  # tote Bots aus letztem Health-Check; werden pro Turn uebersprungen
    _fertig_this_round: set = set()  # Bots die in dieser Runde [FERTIG] signalisiert haben
    _bot_crash_counts: dict = {}  # bot_name -> aufeinanderfolgende Crash-Zaehler
    _CRASH_THRESHOLD = 2  # Ab wie vielen aufeinanderfolgenden Abstuerzen wird Ersatz-Bot gespawnt
    _REPLACEMENT_MODELS = ["sonnet", "haiku", "sonnet"]  # Modell-Kandidaten fuer Ersatz-Bots
    _replacement_counter = 0  # Zaehler fuer eindeutige Ersatz-Bot-Namen

    try:
        while turn < max_turns:
            # Check if stopped
            if not _arena_rooms.get(room_id, {}).get("running"):
                break

            # Pre-Round Health-Check: vor jeder neuen Runde pruefen ob alle Bots leben
            if bot_index % len(bots) == 0:
                round_num = (bot_index // len(bots)) + 1
                health = await _arena_healthcheck_bots(bots)
                dead = [n for n, h in health["bots"].items() if not h["alive"]]
                _dead_bots = set(dead)  # merken fuer Turn-Skip unten
                await _broadcast_all_ws({
                    "type": "arena.healthcheck",
                    "room_id": room_id,
                    "round": round_num,
                    "turn": turn,
                    "cli_ok": health["cli_ok"],
                    "bots": health["bots"],
                })
                if dead:
                    details = "; ".join(f"{n}: {health['bots'][n]['reason']}" for n in dead)
                    hc_msg = {
                        "role": "system",
                        "name": "System",
                        "content": f"🩺 Health-Check vor Runde {round_num}: {len(bots)-len(dead)}/{len(bots)} Bots alive. Tote: {details}",
                        "timestamp": datetime.now().isoformat(),
                        "color": "#f59e0b",
                        "turn": turn,
                    }
                    rooms = _load_arena_rooms()
                    room = _get_arena_room(rooms, room_id)
                    if room:
                        room.setdefault("messages", []).append(hc_msg)
                        _save_arena_rooms(rooms)
                    await _broadcast_all_ws({
                        "type": "arena.message",
                        "room_id": room_id,
                        "message": hc_msg,
                    })
                    # Abbruch wenn CLI tot oder alle Bots tot
                    if not health["cli_ok"] or len(dead) == len(bots):
                        print(f"[Arena] Aborting room {room_id[:8]}: healthcheck failed (cli_ok={health['cli_ok']}, dead={len(dead)}/{len(bots)})")
                        break

            bot = bots[bot_index % len(bots)]
            bot_name = bot.get("name", f"Bot-{bot_index}")
            bot_model = bot.get("model", "sonnet")
            bot_persona = bot.get("persona", "Du bist ein hilfreicher Diskussionspartner.")
            bot_color = bot.get("color", "#6366f1")

            # Toter Bot? Turn ueberspringen und kurz loggen.
            if bot_name in _dead_bots:
                print(f"[Arena] Skipping dead bot '{bot_name}' (turn {turn})")
                skip_msg = {
                    "role": "system",
                    "name": "System",
                    "content": f"⏭️ **{bot_name}** übersprungen (tot, Turn {turn})",
                    "timestamp": datetime.now().isoformat(),
                    "color": "#6b7280",
                    "turn": turn,
                }
                rooms = _load_arena_rooms()
                room = _get_arena_room(rooms, room_id)
                if room:
                    room.setdefault("messages", []).append(skip_msg)
                    _save_arena_rooms(rooms)
                await _broadcast_all_ws({"type": "arena.message", "room_id": room_id, "message": skip_msg})
                turn += 1
                bot_index += 1
                continue

            # Reload room to get latest messages (including Robin injections)
            rooms = _load_arena_rooms()
            room = _get_arena_room(rooms, room_id)
            if not room:
                break

            # Build conversation context for this bot
            recent_msgs = room.get("messages", [])[-8:]
            history_lines = []
            for m in recent_msgs:
                line = f"{m['name']}: {m['content']}"
                # Surface attached files so bots can open them via Read / Bash.
                atts = list(m.get("attachments") or [])
                if not atts and m.get("image"):
                    atts = [m["image"]]
                if atts:
                    att_hints = []
                    for fn in atts:
                        fp = UPLOADS_DIR / fn
                        ext = Path(fn).suffix.lower()
                        if ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
                            att_hints.append(f"Bild: {fp}")
                        elif ext == ".pdf":
                            att_hints.append(f"PDF: {fp} (lies mit Read oder `pdftotext`/Python)")
                        elif ext in (".txt", ".md", ".csv", ".json", ".py", ".js", ".html",
                                      ".css", ".yaml", ".yml", ".log", ".tsv", ".ini", ".toml"):
                            att_hints.append(f"Textdatei: {fp} (lies mit Read)")
                        else:
                            att_hints.append(f"Datei: {fp}")
                    line += "\n  [Anhang fuer alle Bots einsehbar — " + "; ".join(att_hints) + "]"
                history_lines.append(line)
            history_block = "\n\n".join(history_lines) if history_lines else "(Noch keine Nachrichten)"

            # Check execution mode for prompt adaptation
            is_executing = room.get("tools_enabled", False) and room.get("execution_turns_left", 0) > 0

            # Check if bots can read files
            can_read = room.get("allow_read", False) and not is_executing
            read_hint = (
                "\n\nDu kannst Dateien lesen (Read, Glob, Grep) um deine Argumente zu stuetzen. "
                "Nutze das wenn es zum Thema passt — z.B. um Code oder Konfiguration zu pruefen. "
                "Arbeitsverzeichnis: C:/Users/Robin/Jarvis"
            ) if can_read else ""

            # Context block for all prompts
            ctx_block = (
                f"\n\n=== AKTUELLER PROJEKT-KONTEXT (lies das bevor du diskutierst!) ===\n"
                f"{project_context}\n"
                f"=== ENDE KONTEXT ===\n"
            ) if project_context else ""

            # Vorgänger-Crash-Hinweis: Ersatz-Bot wird kurz informiert und dann geleert
            _lc = _arena_rooms.get(room_id, {}).pop("last_crash", None)
            predecessor_hint = (
                f"\nHINWEIS: Dein Vorgänger **{_lc['bot']}** ist in diesem Turn ausgefallen "
                f"({_lc['kind']}: {_lc['summary']}). Übernimm nahtlos — du musst das nicht kommentieren.\n"
            ) if _lc else ""

            if turn == 0 and not recent_msgs:
                # First message: introduce the topic
                prompt = (
                    f"Du bist {bot_name}. {bot_persona}\n"
                    f"{predecessor_hint}"
                    f"\nThema der Diskussion: {topic}\n"
                    f"{ctx_block}\n"
                    f"Du eroeffnest jetzt die Diskussion. Bringe deinen ersten Standpunkt ein. "
                    f"Beziehe dich auf den TATSAECHLICHEN Stand des Projekts (siehe Kontext oben). "
                    f"Halte dich kurz (max 150 Woerter). Antworte direkt ohne Metakommentare. "
                    f"Keine Fantasiezahlen bei Runden/Iterationen — die Arena ist auf max 10 Runden gedeckelt."
                    f"{read_hint}"
                )
            elif is_executing:
                # EXECUTION MODE: bot should actually implement what was discussed
                prompt = (
                    f"Du bist {bot_name}. {bot_persona}\n"
                    f"{predecessor_hint}"
                    f"\nThema: {topic}\n"
                    f"{ctx_block}\n"
                    f"Bisherige Diskussion:\n{history_block}\n\n"
                    f"WICHTIG: Robin hat die Ausfuehrung freigegeben! Du hast jetzt Zugriff auf alle Tools "
                    f"(Read, Write, Edit, Bash, Glob, Grep). Setze um was in der Diskussion besprochen wurde. "
                    f"Arbeitsverzeichnis ist C:/Users/Robin/Jarvis.\n\n"
                    f"Beschreibe kurz was du tust und fuehre die Aenderungen durch. "
                    f"Mach nur kleine, gezielte Fixes — keine grossen Overhauls. "
                    f"Antworte als {bot_name}, ohne Metakommentare."
                )
            else:
                # Only inject full context every 5 turns to save tokens
                ctx_insert = ""  # Context nur bei Turn 0 (bereits oben injiziert), nicht wiederholt
                # Feste Rolle pro Runde: rotiert zyklisch, damit Bots sich nicht doppeln
                _pos_in_round = bot_index % len(bots)
                _round_now = (bot_index // len(bots)) + 1
                _role_name, _role_task = ROUND_ROLES[(_round_now - 1 + _pos_in_round) % len(ROUND_ROLES)]
                role_hint = f"\n\nDeine ROLLE in Runde {_round_now}: **{_role_name}** — {_role_task} Halte dich strikt an diese Rolle."
                prompt = (
                    f"Du bist {bot_name}. {bot_persona}\n"
                    f"{predecessor_hint}"
                    f"\nThema: {topic}\n"
                    f"{ctx_insert}\n"
                    f"Bisherige Diskussion:\n{history_block}\n\n"
                    f"Du bist jetzt dran. Reagiere auf das Gesagte. "
                    f"WICHTIG: Nicht immer widersprechen! Wenn jemand einen guten Punkt macht, sag das und baue darauf auf. "
                    f"Bringe neue Perspektiven, aber sei auch bereit zuzustimmen und gemeinsam weiterzudenken. "
                    f"Wenn Robin etwas eingeworfen hat, geh darauf ein. "
                    f"Falls der Orchestrator gerade ein Zwischenfazit gemacht hat: Diskutiere einfach weiter! "
                    f"Das Fazit ist nur eine Zusammenfassung, kein Stopp-Signal. Du wartest NICHT auf Freigabe oder gruenes Licht. "
                    f"Beziehe dich auf das was TATSAECHLICH existiert, nicht auf Vermutungen. "
                    f"Halte dich kurz (max 150 Woerter). Antworte direkt als {bot_name}. "
                    f"Keine Fantasiezahlen bei Runden/Iterationen — Arena-Hardcap ist 10 Runden; teile groessere Vorhaben in kleinere Schritte. "
                    f"Wenn du glaubst dass die Diskussion einen echten Konsens erreicht hat und keine neuen Erkenntnisse mehr zu erwarten sind, "
                    f"schreibe am Ende deiner Nachricht exakt '[FERTIG]' (in eckigen Klammern). "
                    f"Sobald 2 Bots [FERTIG] schreiben, endet die Runde automatisch. Nur wenn du wirklich überzeugt bist — kein voreiliges Ende!\n"
                    f"EXECUTION-MARKIERUNG: Wenn du eine konkrete Aktion vorschlägst die SOFORT umgesetzt werden soll "
                    f"(z.B. eine Datei editieren, einen Endpoint hinzufügen), schreibe ans Ende deiner Nachricht exakt "
                    f"'[JETZT AUSFÜHREN: ja]'. Wenn die Diskussion noch nicht reif für Umsetzung ist: '[JETZT AUSFÜHREN: nein]'. "
                    f"Nur bei echtem Konsens 'ja' schreiben — der nächste Bot bekommt dann volle Tool-Rechte und muss die Aktion wirklich durchführen."
                    f"{role_hint}"
                    f"{read_hint}"
                )

            # Notify: bot is thinking
            await _broadcast_all_ws({
                "type": "arena.thinking",
                "room_id": room_id,
                "bot_name": bot_name,
                "bot_color": bot_color,
                "turn": turn,
            })

            # Check if this room has tools enabled (execution mode)
            room_tools_enabled = room.get("tools_enabled", False)
            execution_turns_left = room.get("execution_turns_left", 0)

            # Prompt via stdin statt argv - umgeht Windows 32K command-line limit
            if room_tools_enabled and execution_turns_left > 0:
                # EXECUTION MODE: full tools, higher max-turns for tool use
                cmd = [
                    CLAUDE_EXE, "-p",
                    "--model", bot_model,
                    "--output-format", "text",
                    "--max-turns", "10",
                ]
                # Decrement execution turns
                room["execution_turns_left"] = execution_turns_left - 1
                _save_arena_rooms(rooms)
                if room["execution_turns_left"] <= 0:
                    room["tools_enabled"] = False
                    room["execution_turns_left"] = 0
                    _save_arena_rooms(rooms)
                    await _broadcast_all_ws({
                        "type": "arena.mode_change",
                        "room_id": room_id,
                        "mode": "discuss",
                        "turns_left": 0,
                    })
            elif can_read:
                # DISCUSSION + READ MODE: bots can read files to inform their arguments
                cmd = [
                    CLAUDE_EXE, "-p",
                    "--model", bot_model,
                    "--output-format", "text",
                    "--tools", "Read,Glob,Grep",
                    "--max-turns", "8",
                ]
            else:
                # DISCUSSION MODE: no tools, pure text
                cmd = [
                    CLAUDE_EXE, "-p",
                    "--model", bot_model,
                    "--output-format", "text",
                    "--tools", "",
                    "--max-turns", "3",
                ]

            crash_info = None  # set if anything goes wrong, posted as system msg below
            proc = None
            stderr_full = ""
            stdout_full = ""
            # Timeouts: execution=300s, read-mode=120s, pure-text=120s
            if is_executing:
                _timeout = 300
            elif can_read:
                _timeout = 120
            else:
                _timeout = 120
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.PIPE,
                    cwd="C:/Users/Robin/Jarvis",
                    **_SUBPROCESS_FLAGS,
                )
                _arena_rooms[room_id]["process"] = proc

                stdout_data, stderr_data = await asyncio.wait_for(
                    proc.communicate(input=prompt.encode("utf-8")), timeout=_timeout
                )
                stdout_full = stdout_data.decode("utf-8", errors="replace")
                stderr_full = stderr_data.decode("utf-8", errors="replace")

                response = stdout_full.strip()
                # Strip "Reached max turns" errors — use stderr content if stdout empty
                _budget_exhausted = "Reached max turns" in response
                _stdout_raw = response  # keep pre-strip snapshot for crash log
                if _budget_exhausted:
                    lines = [l for l in response.splitlines() if "Reached max turns" not in l and "Error:" not in l]
                    response = "\n".join(lines).strip()
                if not response:
                    # Determine real crash cause from stderr signals
                    _stderr_lower = (stderr_full or "").lower()
                    _thinking_signals = [
                        "thinking budget", "budget_tokens", "thinking_budget",
                        "extended_thinking", "thinking token", "context_window_exceeded",
                        "context window", "context length", "maximum context",
                    ]
                    _thinking_exhausted = any(s in _stderr_lower for s in _thinking_signals)
                    if _budget_exhausted:
                        _crash_kind = "budget_exhausted"
                    elif _thinking_exhausted:
                        _crash_kind = "thinking_budget_exhausted"
                    else:
                        _crash_kind = "empty_response"
                    # --- Budget-Escalation: bei aufgebrauchtem Denk-/Schritte-Budget höher stufen ---
                    _ESCALATION_MAP_B = {"haiku": "sonnet", "sonnet": "opus"}
                    _esc_model_b = _ESCALATION_MAP_B.get(bot_model) if _crash_kind in ("budget_exhausted", "thinking_budget_exhausted") else None
                    _budget_retry_response = None
                    if _esc_model_b:
                        _esc_label = "Denk-Budget" if _crash_kind == "thinking_budget_exhausted" else "Schritte-Budget"
                        _esc_timeout_b = int(_timeout * 1.5)
                        await _broadcast_all_ws({
                            "type": "arena.message",
                            "room_id": room_id,
                            "message": {
                                "role": "system",
                                "name": "System",
                                "content": f"🧠 **{bot_name}** {_esc_label} erschöpft — Retry mit `{_esc_model_b}` ({_esc_timeout_b}s Budget)…",
                                "timestamp": datetime.now().isoformat(),
                                "color": "#f59e0b",
                                "turn": turn,
                            },
                        })
                        try:
                            _esc_proc_b = await asyncio.create_subprocess_exec(
                                CLAUDE_EXE, "-p",
                                "--model", _esc_model_b,
                                "--output-format", "text",
                                "--tools", "",
                                "--max-turns", "1",
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                                stdin=asyncio.subprocess.PIPE,
                                cwd="C:/Users/Robin/Jarvis",
                                **_SUBPROCESS_FLAGS,
                            )
                            _arena_rooms[room_id]["process"] = _esc_proc_b
                            _brd, _bre = await asyncio.wait_for(
                                _esc_proc_b.communicate(input=prompt.encode("utf-8")),
                                timeout=_esc_timeout_b,
                            )
                            _budget_retry_response = _brd.decode("utf-8", errors="replace").strip()
                            if "Reached max turns" in _budget_retry_response:
                                _budget_retry_response = "\n".join(
                                    l for l in _budget_retry_response.splitlines()
                                    if "Reached max turns" not in l and "Error:" not in l
                                ).strip()
                        except Exception:
                            _budget_retry_response = None
                    if _budget_retry_response:
                        response = _budget_retry_response
                        bot_model = _esc_model_b  # reflect escalated model in message metadata
                    elif _crash_kind == "empty_response":
                        # Retry once with shortened context before treating as crash
                        _short_history_lines = history_lines[-5:] if len(history_lines) > 5 else history_lines
                        _short_history = "\n\n".join(_short_history_lines) if _short_history_lines else "(Noch keine Nachrichten)"
                        _short_prompt = (
                            f"Du bist {bot_name}. {bot_persona}\n"
                            f"\nThema: {topic}\n"
                            f"Bisherige Diskussion (gekuerzt):\n{_short_history}\n\n"
                            f"Antworte kurz (max 80 Woerter) direkt als {bot_name}."
                        )
                        await _broadcast_all_ws({
                            "type": "arena.message",
                            "room_id": room_id,
                            "message": {
                                "role": "system",
                                "name": "System",
                                "content": f"↩️ **{bot_name}** leere Antwort — Retry mit gekürztem Kontext…",
                                "timestamp": datetime.now().isoformat(),
                                "color": "#6b7280",
                                "turn": turn,
                            },
                        })
                        _short_retry_response = None
                        try:
                            _sr_proc = await asyncio.create_subprocess_exec(
                                CLAUDE_EXE, "-p",
                                "--model", bot_model,
                                "--output-format", "text",
                                "--tools", "",
                                "--max-turns", "1",
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                                stdin=asyncio.subprocess.PIPE,
                                cwd="C:/Users/Robin/Jarvis",
                                **_SUBPROCESS_FLAGS,
                            )
                            _arena_rooms[room_id]["process"] = _sr_proc
                            _srd, _sre = await asyncio.wait_for(
                                _sr_proc.communicate(input=_short_prompt.encode("utf-8")),
                                timeout=60,
                            )
                            _short_retry_response = _srd.decode("utf-8", errors="replace").strip()
                            if "Reached max turns" in (_short_retry_response or ""):
                                _short_retry_response = "\n".join(
                                    l for l in _short_retry_response.splitlines()
                                    if "Reached max turns" not in l and "Error:" not in l
                                ).strip()
                        except Exception:
                            _short_retry_response = None
                        if _short_retry_response:
                            response = _short_retry_response
                        else:
                            crash_info = _log_arena_crash(
                                room_id=room_id, bot_name=bot_name, turn=turn,
                                kind=_crash_kind, cmd=cmd, returncode=proc.returncode,
                                stderr=stderr_full, stdout_tail=_stdout_raw[-1000:] or stdout_full[-1000:],
                                timeout_s=_timeout,
                            )
                            response = f"(Keine Antwort — {crash_info['summary']})"
                    else:
                        crash_info = _log_arena_crash(
                            room_id=room_id, bot_name=bot_name, turn=turn,
                            kind=_crash_kind, cmd=cmd, returncode=proc.returncode,
                            stderr=stderr_full, stdout_tail=_stdout_raw[-1000:] or stdout_full[-1000:],
                            timeout_s=_timeout,
                        )
                        response = f"(Keine Antwort — {crash_info['summary']})"

            except asyncio.TimeoutError:
                if proc and proc.returncode is None:
                    try:
                        proc.kill()
                        await proc.wait()
                    except Exception:
                        pass
                # --- Escalation-Retry: höheres Modell + längerer Timeout ---
                _ESCALATION_MAP = {"haiku": "sonnet", "sonnet": "opus"}
                _escalated_model = _ESCALATION_MAP.get(bot_model)
                _retry_response = None
                if _escalated_model:
                    _retry_timeout = int(_timeout * 1.5)
                    _retry_cmd = [
                        CLAUDE_EXE, "-p",
                        "--model", _escalated_model,
                        "--output-format", "text",
                        "--tools", "",
                        "--max-turns", "1",
                    ]
                    # Notify room about escalation attempt
                    await _broadcast_all_ws({
                        "type": "arena.message",
                        "room_id": room_id,
                        "message": {
                            "role": "system",
                            "name": "System",
                            "content": f"⚡ **{bot_name}** Timeout nach {_timeout}s — Retry mit `{_escalated_model}` ({_retry_timeout}s Budget)…",
                            "timestamp": datetime.now().isoformat(),
                            "color": "#f59e0b",
                            "turn": turn,
                        },
                    })
                    try:
                        _retry_proc = await asyncio.create_subprocess_exec(
                            *_retry_cmd,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                            stdin=asyncio.subprocess.PIPE,
                            cwd="C:/Users/Robin/Jarvis",
                            **_SUBPROCESS_FLAGS,
                        )
                        _arena_rooms[room_id]["process"] = _retry_proc
                        _rd, _re = await asyncio.wait_for(
                            _retry_proc.communicate(input=prompt.encode("utf-8")),
                            timeout=_retry_timeout,
                        )
                        _retry_response = _rd.decode("utf-8", errors="replace").strip()
                        if "Reached max turns" in _retry_response:
                            _retry_response = "\n".join(
                                l for l in _retry_response.splitlines()
                                if "Reached max turns" not in l and "Error:" not in l
                            ).strip()
                    except Exception:
                        _retry_response = None
                if _retry_response:
                    response = _retry_response
                    bot_model = _escalated_model  # reflect escalated model in message metadata
                else:
                    crash_info = _log_arena_crash(
                        room_id=room_id, bot_name=bot_name, turn=turn,
                        kind="timeout", cmd=cmd,
                        returncode=(proc.returncode if proc else None),
                        stderr=stderr_full, stdout_tail=stdout_full[-1000:],
                        timeout_s=_timeout,
                    )
                    response = f"(Timeout — {crash_info['summary']})"
            except Exception as e:
                import traceback as _tb
                crash_info = _log_arena_crash(
                    room_id=room_id, bot_name=bot_name, turn=turn,
                    kind="exception", cmd=cmd,
                    returncode=(proc.returncode if proc else None),
                    stderr=stderr_full, stdout_tail=stdout_full[-1000:],
                    timeout_s=_timeout,
                    exception=f"{type(e).__name__}: {e}\n{_tb.format_exc()[:1500]}",
                )
                response = f"(Fehler — {crash_info['summary']})"

            # Crash als System-Message in den Raum — kein blindes Raten mehr
            if crash_info:
                print(f"[Arena] CRASH room={room_id[:8]} bot={bot_name} turn={turn} -> {crash_info['file']}")
                crash_msg = {
                    "role": "system",
                    "name": "System",
                    "content": (
                        f"💀 Bot-Absturz: **{bot_name}** (Turn {turn})\n\n"
                        f"{crash_info['summary']}\n\n"
                        f"Log: `{crash_info['file']}`"
                    ),
                    "timestamp": datetime.now().isoformat(),
                    "color": "#ef4444",
                    "turn": turn,
                    "crash": {
                        "kind": crash_info["payload"].get("kind"),
                        "bot": bot_name,
                        "returncode": crash_info["payload"].get("returncode"),
                        "timeout_s": crash_info["payload"].get("timeout_s"),
                        "stderr_tail": (stderr_full or "").strip()[-400:],
                        "log_file": crash_info["file"],
                    },
                }
                rooms = _load_arena_rooms()
                room = _get_arena_room(rooms, room_id)
                if room:
                    room.setdefault("messages", []).append(crash_msg)
                    _save_arena_rooms(rooms)
                await _broadcast_all_ws({
                    "type": "arena.message",
                    "room_id": room_id,
                    "message": crash_msg,
                })
                await _broadcast_all_ws({
                    "type": "arena.crash",
                    "room_id": room_id,
                    "bot_name": bot_name,
                    "turn": turn,
                    "kind": crash_info["payload"].get("kind"),
                    "log_file": crash_info["file"],
                    "summary": crash_info["summary"],
                })
                # Merke für den nächsten Bot warum der Vorgänger gescheitert ist
                _arena_rooms[room_id]["last_crash"] = {
                    "bot": bot_name,
                    "kind": crash_info["payload"].get("kind", "unknown"),
                    "summary": crash_info["summary"],
                }

                # --- Ersatz-Bot-Logik: aufeinanderfolgende Abstuerze tracken ---
                _bot_crash_counts[bot_name] = _bot_crash_counts.get(bot_name, 0) + 1
                if _bot_crash_counts[bot_name] >= _CRASH_THRESHOLD:
                    # Ersatz-Bot spawnen: ersetzt diesen Slot in der lokalen bots-Liste
                    _replacement_counter += 1
                    _ersatz_model = _REPLACEMENT_MODELS[_replacement_counter % len(_REPLACEMENT_MODELS)]
                    _ersatz_name = f"Ersatz-{_replacement_counter}"
                    _ersatz_bot = {
                        "name": _ersatz_name,
                        "model": _ersatz_model,
                        "persona": (
                            f"Du bist {_ersatz_name}, ein neutraler Analyst. "
                            f"Du springst ein, weil {bot_name} wiederholt ausgefallen ist. "
                            f"Uebernimm nahtlos den Diskussionsfaden. Bringe sachliche Perspektiven ein."
                        ),
                        "color": "#8b5cf6",
                        "_replaced": bot_name,
                    }
                    _slot_idx = bot_index % len(bots)
                    bots[_slot_idx] = _ersatz_bot
                    _bot_crash_counts.pop(bot_name, None)
                    _dead_bots.discard(bot_name)
                    ersatz_msg = {
                        "role": "system",
                        "name": "System",
                        "content": (
                            f"🔄 **Ersatz-Bot aktiviert**: {_ersatz_name} ({_ersatz_model}) "
                            f"übernimmt den Slot von **{bot_name}** nach {_CRASH_THRESHOLD} aufeinanderfolgenden Abstürzen."
                        ),
                        "timestamp": datetime.now().isoformat(),
                        "color": "#8b5cf6",
                        "turn": turn,
                    }
                    rooms = _load_arena_rooms()
                    room = _get_arena_room(rooms, room_id)
                    if room:
                        room.setdefault("messages", []).append(ersatz_msg)
                        _save_arena_rooms(rooms)
                    await _broadcast_all_ws({
                        "type": "arena.message",
                        "room_id": room_id,
                        "message": ersatz_msg,
                    })
                    await _broadcast_all_ws({
                        "type": "arena.bot_replaced",
                        "room_id": room_id,
                        "old_bot": bot_name,
                        "new_bot": _ersatz_name,
                        "model": _ersatz_model,
                    })
                    print(f"[Arena] Ersatz-Bot '{_ersatz_name}' ersetzt '{bot_name}' nach {_CRASH_THRESHOLD} Abstuerzen (room={room_id[:8]})")
            else:
                # Kein Crash: Zaehler zuruecksetzen
                _bot_crash_counts.pop(bot_name, None)

            # Check again if stopped during execution
            if not _arena_rooms.get(room_id, {}).get("running"):
                break

            # Save message
            msg = {
                "role": "bot",
                "name": bot_name,
                "content": response,
                "timestamp": datetime.now().isoformat(),
                "color": bot_color,
                "model": bot_model,
                "turn": turn,
                "mode": "execute" if is_executing else "discuss",
            }

            rooms = _load_arena_rooms()
            room = _get_arena_room(rooms, room_id)
            if room:
                room["messages"].append(msg)
                room["last_active"] = datetime.now().isoformat()
                _save_arena_rooms(rooms)

            # Broadcast message
            await _broadcast_all_ws({
                "type": "arena.message",
                "room_id": room_id,
                "message": msg,
            })

            turn += 1
            bot_index += 1

            # JETZT AUSFÜHREN-Signal: Bot markiert Aktion als umsetzungsreif
            if "[JETZT AUSFÜHREN: ja]" in response and not is_executing:
                rooms = _load_arena_rooms()
                room = _get_arena_room(rooms, room_id)
                if room:
                    room["tools_enabled"] = True
                    room["execution_turns_left"] = 1
                    _save_arena_rooms(rooms)
                    await _broadcast_all_ws({
                        "type": "arena.mode_change",
                        "room_id": room_id,
                        "mode": "execute",
                        "turns_left": 1,
                        "triggered_by": bot_name,
                    })
                    print(f"[Arena] JETZT AUSFÜHREN: ja — Bot '{bot_name}' hat Execution für nächsten Turn getriggert (room={room_id[:8]})")

            # FERTIG-Signal: Bot signalisiert Konsens — track pro Runde
            if "[FERTIG]" in response:
                _fertig_this_round.add(bot_name)
            # Neue Runde beginnt: Counter zurücksetzen
            if bot_index % len(bots) == 0:
                active_bots = [b.get("name") for b in bots if b.get("name") not in _dead_bots]
                fertig_threshold = min(2, len(active_bots))
                if active_bots and len(_fertig_this_round) >= fertig_threshold:
                    # Mindestens 2 Bots (oder alle, wenn weniger vorhanden) haben FERTIG signalisiert → Diskussion beenden
                    fertig_names = ", ".join(sorted(_fertig_this_round))
                    fertig_msg = {
                        "role": "system",
                        "name": "System",
                        "content": f"✅ **Konsens erreicht** — {fertig_names} haben [FERTIG] signalisiert. Diskussion beendet.",
                        "timestamp": datetime.now().isoformat(),
                        "color": "#10b981",
                        "turn": turn,
                    }
                    rooms = _load_arena_rooms()
                    room = _get_arena_room(rooms, room_id)
                    if room:
                        room["messages"].append(fertig_msg)
                        room["status"] = "fertig"
                        _save_arena_rooms(rooms)
                    if room_id in _arena_rooms:
                        _arena_rooms[room_id]["running"] = False
                    await _broadcast_all_ws({
                        "type": "arena.message",
                        "room_id": room_id,
                        "message": fertig_msg,
                    })
                    await _broadcast_all_ws({
                        "type": "arena.fertig",
                        "room_id": room_id,
                        "turn": turn,
                    })
                    break
                _fertig_this_round = set()  # Runde vorbei, reset

            # Auto-summary every N turns (default 10)
            summarize_every = room.get("summarize_every", 10)
            if summarize_every > 0 and turn > 0 and turn % summarize_every == 0 and turn < max_turns:
                # Generate orchestrator summary
                await _broadcast_all_ws({
                    "type": "arena.thinking",
                    "room_id": room_id,
                    "bot_name": "Orchestrator",
                    "bot_color": "#a855f7",
                    "turn": turn,
                })
                rooms = _load_arena_rooms()
                room = _get_arena_room(rooms, room_id)
                if room:
                    summary_raw = await _generate_orchestrator_summary(room)
                    verdict, summary = _extract_verdict(summary_raw)
                    # Zwischenfazit nur ins Log, nicht ans Fenster
                    if "fazit_log" not in room:
                        room["fazit_log"] = []
                    room["fazit_log"].append({
                        "turn": turn,
                        "timestamp": datetime.now().isoformat(),
                        "verdict": verdict,
                        "content": summary,
                    })
                    room["orchestrator_summary"] = summary
                    room["orchestrator_summary_at"] = datetime.now().isoformat()
                    room["last_verdict"] = verdict
                    _save_arena_rooms(rooms)
                    print(f"[Arena] Zwischenfazit Runde {turn} (verdict={verdict}): {summary[:120]}...")
                    # Auto-pause on consensus or stalemate — Robin soll entscheiden
                    if verdict in ("consensus", "stalemate"):
                        room["awaiting_robin"] = True
                        room["awaiting_reason"] = verdict
                        _save_arena_rooms(rooms)
                        await _broadcast_all_ws({
                            "type": "arena.needs_decision",
                            "room_id": room_id,
                            "verdict": verdict,
                            "turn": turn,
                            "summary": summary,
                        })
                        if room_id in _arena_rooms:
                            _arena_rooms[room_id]["running"] = False
                        break

            # Small pause between turns (let Robin inject if needed)
            await asyncio.sleep(2)

    except Exception as e:
        print(f"[Arena] Error in room {room_id[:8]}: {e}")
    finally:
        # Generate final summary
        rooms = _load_arena_rooms()
        room = _get_arena_room(rooms, room_id)
        if room and turn > 2:
            try:
                await _broadcast_all_ws({
                    "type": "arena.thinking",
                    "room_id": room_id,
                    "bot_name": "Orchestrator",
                    "bot_color": "#a855f7",
                    "turn": turn,
                })
                summary = await _generate_orchestrator_summary(room)
                summary_msg = {
                    "role": "orchestrator",
                    "name": "Orchestrator",
                    "content": f"**Abschlussfazit ({turn} Runden):**\n\n{summary}",
                    "timestamp": datetime.now().isoformat(),
                    "color": "#a855f7",
                    "turn": turn,
                }
                room["messages"].append(summary_msg)
                room["orchestrator_summary"] = summary
                room["orchestrator_summary_at"] = datetime.now().isoformat()
                room["status"] = "idle"
                _save_arena_rooms(rooms)
                await _broadcast_all_ws({
                    "type": "arena.message",
                    "room_id": room_id,
                    "message": summary_msg,
                })
            except Exception as e2:
                print(f"[Arena] Summary error: {e2}")
                room["status"] = "idle"
                _save_arena_rooms(rooms)
        elif room:
            room["status"] = "idle"
            _save_arena_rooms(rooms)

        _arena_rooms.pop(room_id, None)
        await _broadcast_all_ws({
            "type": "arena.stopped",
            "room_id": room_id,
        })
        print(f"[Arena] Room {room_id[:8]} stopped after {turn} turns")


# ---------------------------------------------------------------------------
# WS Client Registry + Server Version
# ---------------------------------------------------------------------------
import hashlib as _hashlib

# Compute a version hash from all static files + server.py at startup
def _compute_version():
    h = _hashlib.md5()
    for f in sorted((BASE_DIR / "static").rglob("*")):
        if f.is_file():
            h.update(f.read_bytes())
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()[:12]

_server_version = _compute_version()
_server_start_time = time.time()
_ws_clients: set = set()  # all connected WS clients


async def _broadcast_all_ws(event: dict):
    """Send an event to ALL connected WS clients."""
    dead = set()
    for ws in list(_ws_clients):
        try:
            await ws.send_json(event)
        except Exception:
            dead.add(ws)
    for d in dead:
        _ws_clients.discard(d)


# ── Activity State (Sidebar indicators) ──────────────────────────────
_activity: dict = {}  # {view: {"active": bool, "pending": int}}


def _activity_set(view: str, *, active: bool | None = None, pending_delta: int = 0):
    """Update activity state and broadcast to all WS clients."""
    state = _activity.setdefault(view, {"active": False, "pending": 0})
    if active is not None:
        state["active"] = active
    if pending_delta != 0:
        state["pending"] = max(0, state["pending"] + pending_delta)
    asyncio.ensure_future(_broadcast_all_ws({
        "type": "activity.update",
        "view": view,
        "state": {"active": state["active"], "pending": state["pending"]},
    }))


async def api_activity_get(request):
    """GET /api/activity  -  Return current activity state for all views."""
    return web.json_response(_activity)


async def api_activity_clear(request):
    """POST /api/activity/clear/{view}  -  Clear pending count for a view."""
    view = request.match_info["view"]
    if view in _activity:
        _activity[view]["pending"] = 0
        await _broadcast_all_ws({
            "type": "activity.update",
            "view": view,
            "state": {"active": _activity[view]["active"], "pending": 0},
        })
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Stream-Buffer + Subscriber-Registry
# ---------------------------------------------------------------------------
# session_id -> {"buffer": [event_dicts], "done": bool}
_active_streams: dict = {}

# session_id -> set of websocket objects currently subscribed to this stream
_stream_subscribers: dict = {}


def _stream_start(session_id: str):
    """Mark a session as actively streaming; reset buffer."""
    _active_streams[session_id] = {"buffer": [], "done": False}
    _stream_subscribers.setdefault(session_id, set())


def _stream_end(session_id: str):
    """Mark stream as done; keep buffer for late subscribers."""
    if session_id in _active_streams:
        _active_streams[session_id]["done"] = True


def _stream_cleanup(session_id: str):
    """Remove stream state entirely (e.g. after client acknowledged done)."""
    _active_streams.pop(session_id, None)
    _stream_subscribers.pop(session_id, None)


def _ws_unsubscribe_all(ws):
    """Remove a dead WS connection from all subscriber sets."""
    for subs in _stream_subscribers.values():
        subs.discard(ws)


async def _broadcast_stream_event(session_id: str, event: dict):
    """Buffer event and broadcast to all subscribers for this session."""
    if session_id in _active_streams:
        _active_streams[session_id]["buffer"].append(event)
    dead = set()
    for sub_ws in list(_stream_subscribers.get(session_id, [])):
        try:
            await sub_ws.send_json(event)
        except Exception:
            dead.add(sub_ws)
    for d in dead:
        _stream_subscribers.get(session_id, set()).discard(d)


# WebSocket chat handler
# ---------------------------------------------------------------------------

async def _classify_session_headless(session):
    """Classify a session without a WS connection (e.g. on startup)."""
    print(f"[Classify] Starting headless for {session.session_id[:8]}, history={len(session.history)} msgs")
    user_msgs = [m["content"] for m in session.history if m.get("role") == "user"][:5]
    if not user_msgs:
        print(f"[Classify] No user msgs for {session.session_id[:8]}, skipping")
        return
    sample = "\n---\n".join(user_msgs)[:1500]
    print(f"[Classify] {session.session_id[:8]} sample={len(sample)} chars, {len(user_msgs)} user msgs")
    existing_topics = list(sessions.get_topics().keys())
    existing_hint = ""
    if existing_topics:
        existing_hint = f"\nExisting topics: {', '.join(existing_topics)}\nPrefer assigning to an existing topic if it fits well. Only create a new one if the session clearly doesn't match any existing topic."

    prompt = f"""Analyze this chat session and return a JSON object with:
- "topic": short category label (1-3 words, German)
- "title": concise session title (max 5 words, German, describes the specific content)
- "new": true if topic is new, false if it matches an existing one

Return ONLY valid JSON like: {{"topic": "Thema Name", "title": "Kurzer Titel", "new": true/false}}
{existing_hint}

User messages:
{sample}"""

    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", "--output-format", "text", "--max-turns", "0",
            "--model", "haiku",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        raw = stdout.decode("utf-8", errors="replace").strip()
        err = stderr.decode("utf-8", errors="replace").strip()
        print(f"[Classify] {session.session_id[:8]} raw={repr(raw[:200])} err={repr(err[:200])}")
        import re as _re
        json_match = _re.search(r'\{[^}]*\}', raw)
        if json_match:
            result = json.loads(json_match.group())
            topic = result.get("topic", "").strip()
            title = result.get("title", "").strip()
            if topic:
                color = sessions._topic_colors().get(topic) or SessionManager._default_color(topic)
                sessions._save_topic_color(topic, color)
                sessions.set_session_topic(session.session_id, topic, color)
                if title and not session.custom_title:
                    session.auto_title = title
                    sessions.persist()
                print(f"[Classify] {session.session_id[:8]} → '{topic}' | '{title}'")
                await _broadcast_all_ws({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                    "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
                })
                await _broadcast_all_ws({
                    "type": "chat.topic_classified",
                    "session_id": session.session_id,
                    "topic": topic,
                    "color": color,
                    "title": title,
                    "is_new": False,
                })
        else:
            print(f"[Classify] {session.session_id[:8]} NO JSON match in response")
    except Exception as e:
        print(f"[Classify] Headless error for {session.session_id[:8]}: {e}")


async def _classify_session(ws, session):
    """Use a lightweight Claude call to classify the session into a topic."""
    # Collect first few user messages for classification
    user_msgs = [m["content"] for m in session.history if m.get("role") == "user"][:5]
    if not user_msgs:
        return
    sample = "\n---\n".join(user_msgs)[:1500]

    # Get existing topics
    existing_topics = list(sessions.get_topics().keys())
    existing_hint = ""
    if existing_topics:
        existing_hint = f"\nExisting topics: {', '.join(existing_topics)}\nPrefer assigning to an existing topic if it fits well. Only create a new one if the session clearly doesn't match any existing topic."

    prompt = f"""Analyze this chat session and return a JSON object with:
- "topic": short category label (1-3 words, German)
- "title": concise session title (max 5 words, German, describes the specific content)
- "new": true if topic is new, false if it matches an existing one

Return ONLY valid JSON like: {{"topic": "Thema Name", "title": "Kurzer Titel", "new": true/false}}
{existing_hint}

User messages:
{sample}"""

    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", "--output-format", "text", "--max-turns", "0",
            "--model", "haiku",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            stdin=asyncio.subprocess.PIPE,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        raw = stdout.decode("utf-8", errors="replace").strip()

        # Parse JSON from response (might have markdown wrapping)
        import re
        json_match = re.search(r'\{[^}]*\}', raw)
        if json_match:
            result = json.loads(json_match.group())
            topic = result.get("topic", "").strip()
            title = result.get("title", "").strip()
            if topic:
                color = sessions._topic_colors().get(topic) or SessionManager._default_color(topic)
                sessions._save_topic_color(topic, color)
                sessions.set_session_topic(session.session_id, topic, color)
                if title and not session.custom_title:
                    session.auto_title = title
                    sessions.persist()
                print(f"[Classify] Session {session.session_id[:8]} → '{topic}' | '{title}' (new={result.get('new', True)})")
                await _broadcast_all_ws({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                    "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
                })
                await _broadcast_all_ws({
                    "type": "chat.topic_classified",
                    "session_id": session.session_id,
                    "topic": topic,
                    "color": color,
                    "title": title,
                    "is_new": result.get("new", True),
                })
    except Exception as e:
        print(f"[Classify] Error: {e}")


async def _run_claude(ws, session, message, attachments=None):
    """Run Claude CLI subprocess with stream-json and send granular WS events."""
    import time as _time

    _stream_start(session.session_id)
    if ws is not None:  # ws may be None for headless auto-resume after restart
        _stream_subscribers.setdefault(session.session_id, set()).add(ws)
    else:
        _stream_subscribers.setdefault(session.session_id, set())
    _activity_set("chat", active=True)
    # Persist "stream is active" immediately so a kill during the tool phase
    # (before any text tokens) is still detected at boot.
    session._stream_active = True
    session.last_heartbeat = datetime.now().isoformat()
    sessions.persist()

    async with session.lock:
        session._lock_acquired_at = _time.time()
        try:
            full_prompt = message

            # Build attachment context into the prompt
            if attachments:
                att_parts = []
                for filename in attachments:
                    filepath = UPLOADS_DIR / filename
                    if not filepath.exists():
                        continue
                    ext = filepath.suffix.lower()
                    if ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'):
                        att_parts.append(f"\n[Bild angehängt: {filepath}  -  bitte lies und analysiere dieses Bild]")
                    elif ext == '.pdf':
                        att_parts.append(f"\n[PDF angehängt: {filepath}  -  bitte lies und analysiere dieses PDF]")
                    elif ext in ('.txt', '.md', '.csv', '.json', '.py', '.js', '.html', '.css'):
                        try:
                            content = filepath.read_text(encoding="utf-8", errors="replace")[:5000]
                            att_parts.append(f"\n[Datei: {filename}]\n```\n{content}\n```")
                        except Exception:
                            att_parts.append(f"\n[Datei angehängt: {filepath}]")
                    elif ext in ('.webm', '.ogg', '.mp3', '.wav', '.m4a'):
                        att_parts.append(f"\n[Sprachnachricht angehängt: {filepath}  -  bitte lies und transkribiere diese Audiodatei]")
                    else:
                        att_parts.append(f"\n[Datei angehängt: {filepath}]")
                if att_parts:
                    full_prompt = full_prompt + "\n" + "\n".join(att_parts)

            system = _build_system_prompt()

            # Write system prompt to temp file (avoids Windows cmd length limit)
            import tempfile
            system_file = Path(tempfile.gettempdir()) / f"jarvis-sys-{session.session_id[:8]}.txt"
            system_file.write_text(system, encoding="utf-8")

            # Build command  -  mirrors CLI experience exactly.
            # --disallowedTools blocks commands that have historically crashed MC itself
            # (self-kill of python/server, edits to MC's own source or the watchdog).
            # These still work via --dangerously-skip-permissions elsewhere, just not
            # from inside MC's own Claude loop.
            _deny_patterns = ",".join([
                "Bash(taskkill*)",
                "Bash(Stop-Process*)",
                "Bash(Stop-Service*)",
                "Bash(net stop*)",
                "Bash(sc stop*)",
                "Bash(Restart-Service*)",
                "Bash(*python*server.py*)",
                "Bash(*start.bat*)",
                "Edit(C:/Users/Robin/Jarvis/Mission-Control/server.py)",
                "Edit(C:/Users/Robin/Jarvis/Mission-Control/start.bat)",
                "Write(C:/Users/Robin/Jarvis/Mission-Control/server.py)",
                "Write(C:/Users/Robin/Jarvis/Mission-Control/start.bat)",
            ])
            cmd = [
                "claude", "-p",
                "--output-format", "stream-json", "--verbose",
                "--max-turns", "40",
                "--dangerously-skip-permissions",
                "--disallowedTools", _deny_patterns,
                "--append-system-prompt-file", str(system_file),
                "--mcp-config", str(BASE_DIR.parent / ".mcp.json"),
            ]

            if session.cli_session_id:
                # Follow-up: resume existing CLI session (full context preserved)
                cmd.extend(["--resume", session.cli_session_id])

            model = _pick_model(full_prompt, session)
            if model:
                cmd.extend(["--model", model])

            # If no CLI session to resume, inject chat history for context
            if not session.cli_session_id and session.history:
                history_lines = []
                # Include last 20 messages (10 exchanges) for context
                recent = session.history[-20:]
                for msg in recent:
                    role = "Robin" if msg.get("role") == "user" else "Jarvis"
                    content = msg.get("content", "")
                    # Truncate very long messages to save tokens
                    if len(content) > 2000:
                        content = content[:2000] + "...[gekürzt]"
                    history_lines.append(f"{role}: {content}")
                history_block = "\n\n".join(history_lines)
                full_prompt = (
                    f"<conversation_history>\n{history_block}\n</conversation_history>\n\n"
                    f"Robin: {full_prompt}"
                )

            stdin_text = full_prompt
            used_resume = session.cli_session_id

            used_model = model or "default"
            print(f"[Claude] Streaming: session={session.session_id[:8]} model={used_model} resume={used_resume or 'new'}")
            t_start = _time.time()

            # Pipe the prompt via stdin to avoid cmd length limit
            session.process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                stdin=asyncio.subprocess.PIPE,
                cwd="C:/Users/Robin/Jarvis",
                limit=1024 * 1024,  # 1MB readline buffer for large tool outputs
                **_SUBPROCESS_FLAGS,
            )

            session.process.stdin.write(stdin_text.encode("utf-8"))
            await session.process.stdin.drain()
            session.process.stdin.close()

            # Persist user message immediately so it survives page reload during streaming
            session.history.append({"role": "user", "content": message})
            sessions.persist()

            # Send chat.start — to session subscribers AND all clients (for sidebar streaming indicators)
            _start_event = {"type": "chat.start", "session_id": session.session_id}
            await _broadcast_stream_event(session.session_id, _start_event)
            await _broadcast_all_ws(_start_event)

            full_text = ""
            result_event = None
            last_tool = ""
            _last_partial_persist = _time.time()  # track periodic partial saves
            _stream_started_at = _time.time()
            _last_ping = _time.time()

            try:
                while True:
                    # Check if all WS subscribers disconnected — no point continuing
                    subs = _stream_subscribers.get(session.session_id, set())
                    alive_subs = {s for s in subs if not s.closed}
                    if not alive_subs and not _ws_clients:
                        print(f"[Claude] All subscribers gone for {session.session_id[:8]} — killing subprocess")
                        if session.process and session.process.returncode is None:
                            session.process.kill()
                            await session.process.wait()
                        break

                    try:
                        line = await asyncio.wait_for(
                            session.process.stdout.readline(),
                            timeout=30,  # short inner timeout — send ping if silent, retry up to 300s total
                        )
                    except asyncio.TimeoutError:
                        elapsed = _time.time() - _stream_started_at
                        if elapsed >= 300:
                            print("[Claude] Subprocess readline timeout (300s) — killing")
                            if session.process and session.process.returncode is None:
                                session.process.kill()
                                await session.process.wait()
                            break
                        # Send ping every 30s so frontend stuck-timer resets
                        if _time.time() - _last_ping >= 28:
                            _last_ping = _time.time()
                            session.last_heartbeat = datetime.now().isoformat()
                            await _broadcast_stream_event(session.session_id, {
                                "type": "chat.ping",
                                "session_id": session.session_id,
                                "elapsed": int(elapsed),
                            })
                        continue
                    except Exception:
                        break

                    if not line:
                        break  # EOF

                    line_str = line.decode("utf-8", errors="replace").strip()
                    if not line_str:
                        continue

                    try:
                        event = json.loads(line_str)
                    except json.JSONDecodeError:
                        continue

                    evt_type = event.get("type", "")

                    # System events: capture CLI session ID, skip the rest
                    if evt_type == "system":
                        subtype = event.get("subtype", "")
                        if subtype == "init":
                            cli_sid = event.get("session_id")
                            if cli_sid:
                                session.cli_session_id = cli_sid
                                sessions.persist()
                                print(f"[Claude] CLI session: {cli_sid[:12]}")
                        continue

                    if evt_type == "assistant":
                        for block in event.get("message", {}).get("content", []):
                            block_type = block.get("type", "")
                            if block_type == "text":
                                text_chunk = block.get("text", "")
                                if text_chunk:
                                    full_text += text_chunk
                                    await _broadcast_stream_event(session.session_id, {
                                        "type": "chat.delta",
                                        "session_id": session.session_id,
                                        "text": text_chunk,
                                    })
                            elif block_type == "tool_use":
                                last_tool = block.get("name", "")
                                # Truncate large inputs (e.g. Write content) for WS
                                raw_input = block.get("input", {})
                                safe_input = {}
                                for k, v in raw_input.items():
                                    if isinstance(v, str) and len(v) > 200:
                                        safe_input[k] = v[:200] + "..."
                                    else:
                                        safe_input[k] = v
                                await _broadcast_stream_event(session.session_id, {
                                    "type": "chat.tool_use",
                                    "session_id": session.session_id,
                                    "tool": last_tool,
                                    "input": safe_input,
                                })

                    elif evt_type == "user":
                        # tool_result comes as a "user" event
                        for block in event.get("message", {}).get("content", []):
                            block_type = block.get("type", "")
                            if block_type == "tool_result":
                                await _broadcast_stream_event(session.session_id, {
                                    "type": "chat.tool_result",
                                    "session_id": session.session_id,
                                    "tool": last_tool,
                                })

                    elif evt_type in ("rate_limit_event",):
                        continue  # skip

                    # Partial persist: save immediately on first text, then every 5s
                    if full_text and (session._streaming_partial is None or (_time.time() - _last_partial_persist) > 5):
                        _last_partial_persist = _time.time()
                        session._streaming_partial = full_text
                        sessions.persist()

                    if evt_type == "result":
                        result_event = event
                        # Capture final text from result if we missed it
                        if not full_text:
                            full_text = event.get("result", "")

            except asyncio.CancelledError:
                if session.process and session.process.returncode is None:
                    session.process.kill()
                    await session.process.wait()
                # Save partial response if any text was streamed before cancel
                if full_text:
                    session.history.append({"role": "assistant", "content": full_text + "\n\n_(abgebrochen)_"})
                    sessions.persist()
                raise

            # Wait for process to finish
            if session.process and session.process.returncode is None:
                await session.process.wait()

            duration_ms = int((_time.time() - t_start) * 1000)

            # Detect stale --resume: CLI returns "Error: Session <uuid> not found" as result text
            # (can arrive in full_text or only in result_event.result). Treat as empty for retry.
            if used_resume and full_text:
                _low = full_text.lower()
                if "session" in _low and "not found" in _low and len(full_text) < 500:
                    print(f"[Claude] Stale --resume detected in output, forcing retry")
                    full_text = ""

            if not full_text:
                if used_resume:
                    # --resume failed — drop the stale CLI session and retry fresh
                    print(f"[Claude] --resume failed (empty response), retrying without resume")
                    session.cli_session_id = None
                    sessions.persist()
                    # Remove the user message we already appended (will be re-added on retry)
                    if session.history and session.history[-1].get("role") == "user":
                        session.history.pop()
                        sessions.persist()
                    _stream_end(session.session_id)
                    asyncio.get_event_loop().call_later(30, _stream_cleanup, session.session_id)
                    # Retry without --resume (recursive call, but used_resume is now None)
                    await _run_claude(ws, session, message, attachments)
                    return
                print("[Claude] Leere Antwort - sende Fehler")
                await _broadcast_stream_event(session.session_id, {
                    "type": "chat.error",
                    "session_id": session.session_id,
                    "error": "Claude hat keine Antwort geliefert.",
                })
                session._stream_active = False
                sessions.persist()
                _stream_end(session.session_id)
                asyncio.get_event_loop().call_later(30, _stream_cleanup, session.session_id)
                return

            # Update local tracking  -  user msg already appended before streaming
            session.history.append({"role": "assistant", "content": full_text})
            session.message_count += 1
            session.last_message = datetime.now().isoformat()
            session.last_heartbeat = session.last_message
            session.process = None
            session._streaming_partial = None  # clear partial AFTER history is in place
            session._stream_active = False
            sessions.persist()  # atomic: full response in history, partial gone, stream inactive

            # Build done event with metadata from result
            done_payload = {
                "type": "chat.done",
                "session_id": session.session_id,
                "full_text": full_text,
                "duration_ms": duration_ms,
                "model": used_model,
            }
            if result_event:
                done_payload["cost_usd"] = result_event.get("total_cost_usd", result_event.get("cost_usd", 0))
                usage = result_event.get("usage", {})
                input_base = usage.get("input_tokens", 0)
                cache_read = usage.get("cache_read_input_tokens", 0)
                cache_create = usage.get("cache_creation_input_tokens", 0)
                done_payload["input_tokens"] = input_base + cache_read + cache_create
                done_payload["output_tokens"] = usage.get("output_tokens", 0)
                # Context fill info  -  use only base input + output (cache-read tokens don't count against context)
                model_usage = result_event.get("modelUsage", {})
                for _, mu in model_usage.items():
                    ctx_window = mu.get("contextWindow", 0)
                    if ctx_window:
                        total_used = input_base + cache_create + done_payload["output_tokens"]
                        done_payload["context_window"] = ctx_window
                        done_payload["context_used"] = total_used
                        done_payload["context_pct"] = round(total_used / ctx_window * 100, 1)
                        print(f"[Context] {total_used}/{ctx_window} = {done_payload['context_pct']}%")
                        break

            await _broadcast_stream_event(session.session_id, done_payload)
            await _broadcast_all_ws(done_payload)  # also notify all clients for sidebar toast + indicator
            _activity_set("chat", active=False, pending_delta=1)
            _stream_end(session.session_id)
            asyncio.get_event_loop().call_later(30, _stream_cleanup, session.session_id)
            print(f"[WS] chat.done: session={session.session_id[:8]} ({len(full_text)} chars, {duration_ms}ms)")

            # Auto-classify: after 2nd message (no topic yet), or every 4th message to refresh title
            _should_classify = (
                (not session.topic and session.message_count >= 2) or
                (session.message_count == 4 and not session.custom_title) or
                (not session.topic and session.message_count % 3 == 0)  # retry if still unclassified
            )
            if _should_classify:
                asyncio.create_task(_classify_session_headless(session))

        except asyncio.CancelledError:
            print(f"[WS] Cancelled: session={session.session_id[:8]}")
            _ft = locals().get("full_text", "")
            if _ft and (not session.history or session.history[-1].get("content") != _ft + "\n\n_(abgebrochen)_"):
                session.history.append({"role": "assistant", "content": _ft + "\n\n_(abgebrochen)_"})
                session.process = None
                sessions.persist()
            session._streaming_partial = None
            session._stream_active = False
            sessions.persist()
            _stream_end(session.session_id)
            asyncio.get_event_loop().call_later(30, _stream_cleanup, session.session_id)
        except Exception as e:
            print(f"[WS] Error: {e}")
            _ft = locals().get("full_text", "")
            if _ft and (not session.history or session.history[-1].get("role") != "assistant" or session.history[-1].get("content") != _ft):
                session.history.append({"role": "assistant", "content": _ft})
                session.message_count += 1
                session.last_message = datetime.now().isoformat()
                session.last_heartbeat = session.last_message
                session.process = None
                sessions.persist()
                print(f"[WS] Saved partial response ({len(_ft)} chars) despite error")
            session._streaming_partial = None
            session._stream_active = False
            sessions.persist()
            try:
                err_ev = {
                    "type": "chat.error",
                    "session_id": session.session_id,
                    "error": str(e),
                }
                await _broadcast_stream_event(session.session_id, err_ev)
            except Exception:
                pass
            _stream_end(session.session_id)
            asyncio.get_event_loop().call_later(30, _stream_cleanup, session.session_id)


async def api_transcribe(request):
    """POST /api/transcribe  -  YouTube-URL -> Transcript -> Claude-Analyse (SSE)."""
    import re as _re
    body = await request.json()
    url = body.get("url", "").strip()
    mode = body.get("mode", "analyze")
    custom_prompt = body.get("custom_prompt", "").strip()

    # Extract YouTube video ID
    match = _re.search(r'(?:v=|youtu\.be/|embed/)([A-Za-z0-9_-]{11})', url)
    if not match:
        raise web.HTTPBadRequest(reason="Keine gültige YouTube-URL erkannt")
    video_id = match.group(1)

    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    })
    await resp.prepare(request)
    _activity_set("transcriber", active=True)

    async def sse(event: str, data: dict):
        line = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        try:
            await resp.write(line.encode("utf-8"))
        except Exception:
            pass

    try:
        await sse("status", {"msg": "Transcript wird geladen…"})

        # Fetch transcript (blocking I/O in thread pool)
        from youtube_transcript_api import YouTubeTranscriptApi
        def _fetch():
            api_yt = YouTubeTranscriptApi()
            t = api_yt.fetch(video_id)
            return " ".join([s.text for s in t])

        try:
            full_text = await asyncio.get_event_loop().run_in_executor(None, _fetch)
        except Exception as e:
            await sse("error", {"msg": f"Transcript-Fehler: {e}"})
            try:
                await resp.write_eof()
            except Exception:
                pass
            return resp

        word_count = len(full_text.split())
        preview = full_text[:800] + ("…" if len(full_text) > 800 else "")
        await sse("transcript", {"preview": preview, "words": word_count, "chars": len(full_text)})
        await sse("status", {"msg": f"Claude analysiert ({word_count} Wörter)…"})

        # Build prompt
        text_limit = 12000
        trimmed = full_text[:text_limit]
        if mode == "summarize":
            prompt = f"Fasse dieses Video-Transcript kompakt auf Deutsch zusammen. Nutze Bullet Points und Abschnitte:\n\n{trimmed}"
        elif mode == "compare":
            jarvis_ctx = (
                "Jarvis hat aktuell:\n"
                "- Level 1 ✅ Auto-Memory (Claude Code ~/.claude/projects/.../memory/)\n"
                "- Level 2 ✅ CLAUDE.md (expliziter Kontext)\n"
                "- Level 3 ✅ State Files (Daily Notes, MEMORY.md-Index, Markdown-Netzwerk)\n"
                "- Level 4 ✅ Obsidian Vault (Second Brain, E:/OneDrive/AI/Obsidian-Vault/)\n"
                "- Level 5 ❌ Naive RAG (Embeddings / Vektordatenbank fehlt)\n"
                "- Level 6 ❌ Graph RAG (LightRAG fehlt)\n"
                "- Level 7 ❌ Agentic RAG (multimodal, autonome Pipelines fehlen)\n"
            )
            prompt = (
                f"{jarvis_ctx}\n\nDas Video-Transcript:\n{trimmed}\n\n"
                "Vergleiche den Video-Inhalt mit Jarvis' aktuellem Stand. "
                "Was haben wir bereits? Was fehlt? Was sind die nächsten konkreten Schritte?"
            )
        elif mode == "custom" and custom_prompt:
            prompt = f"{custom_prompt}\n\nVideo-Transcript:\n{trimmed}"
        else:  # analyze
            prompt = f"Analysiere dieses Video-Transcript auf Deutsch. Kernkonzepte, Empfehlungen, Tools — strukturiert:\n\n{trimmed}"

        sys_p = "Du bist Jarvis. Antworte auf Deutsch. Kein Smalltalk. Keine Füllwörter."

        proc = await asyncio.create_subprocess_exec(
            CLAUDE_EXE, "-p", prompt,
            "--output-format", "text",
            "--max-turns", "1",
            "--system-prompt", sys_p,
            "--disallowed-tools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )

        buf = []
        async for line in proc.stdout:
            chunk = line.decode("utf-8", errors="replace")
            buf.append(chunk)
            await sse("chunk", {"text": chunk})
        await proc.wait()
        output_text = "".join(buf)
        await sse("done", {"chars": len(output_text)})

        # Save transcript to disk
        transcript_id = uuid.uuid4().hex[:8]
        # Try to extract video title from first line of output
        first_line = output_text.strip().split("\n")[0][:80] if output_text.strip() else ""
        ts_data = {
            "id": transcript_id,
            "url": url,
            "video_id": video_id,
            "mode": mode,
            "title": first_line or f"Video {video_id}",
            "date": datetime.now().isoformat(),
            "word_count": word_count,
            "chars": len(output_text),
            "transcript_preview": preview[:500],
            "output": output_text,
        }
        ts_file = TRANSCRIPTS_DIR / f"{datetime.now().strftime('%Y-%m-%d_%H%M')}_{transcript_id}.json"
        ts_file.write_text(json.dumps(ts_data, ensure_ascii=False, indent=2), encoding="utf-8")
        _activity_set("transcriber", active=False, pending_delta=1)

    except Exception as e:
        try:
            await sse("error", {"msg": str(e)})
        except Exception:
            pass
    finally:
        _activity_set("transcriber", active=False)

    try:
        await resp.write_eof()
    except Exception:
        pass
    return resp


async def api_transcribe_chat(request):
    """POST /api/transcribe/chat  -  Follow-up chat about an analyzed video (SSE)."""
    body = await request.json()
    message = body.get("message", "").strip()
    transcript = body.get("transcript", "").strip()
    analysis = body.get("analysis", "").strip()
    history = body.get("history", [])

    if not message:
        raise web.HTTPBadRequest(reason="Keine Nachricht")

    context_parts = []
    if transcript:
        context_parts.append(f"Video-Transcript (Auszug):\n{transcript[:3000]}")
    if analysis:
        context_parts.append(f"Meine vorherige Analyse:\n{analysis[:3000]}")
    context = "\n\n---\n\n".join(context_parts)

    history_str = ""
    for h in history[-6:]:
        role = "Robin" if h.get("role") == "user" else "Jarvis"
        history_str += f"{role}: {h.get('content','')}\n\n"

    prompt = f"{context}\n\n---\n\nGesprächsverlauf:\n{history_str}Robin: {message}\n\nJarvis:"
    sys_p = "Du bist Jarvis, ein persönlicher AI-Assistent. Du diskutierst ein analysiertes Video mit Robin. Antworte direkt und präzise auf Deutsch. Beziehe dich auf Transcript und Analyse."

    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    })
    await resp.prepare(request)

    async def sse(event: str, data: dict):
        line = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        try:
            await resp.write(line.encode("utf-8"))
        except Exception:
            pass

    try:
        proc = await asyncio.create_subprocess_exec(
            CLAUDE_EXE, "-p", prompt,
            "--output-format", "text",
            "--max-turns", "1",
            "--system-prompt", sys_p,
            "--disallowed-tools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            **_SUBPROCESS_FLAGS,
        )
        buf = []
        async for line in proc.stdout:
            chunk = line.decode("utf-8", errors="replace")
            buf.append(chunk)
            await sse("chunk", {"text": chunk})
        await proc.wait()
        full = "".join(buf)
        await sse("done", {"text": full})
    except Exception as e:
        try:
            await sse("error", {"msg": str(e)})
        except Exception:
            pass

    try:
        await resp.write_eof()
    except Exception:
        pass
    return resp


async def api_transcripts(request):
    """GET /api/transcripts  -  Return list of saved transcriptions."""
    items = []
    for f in sorted(TRANSCRIPTS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            items.append({
                "id": data.get("id"),
                "url": data.get("url"),
                "video_id": data.get("video_id"),
                "mode": data.get("mode"),
                "title": data.get("title", ""),
                "date": data.get("date"),
                "word_count": data.get("word_count", 0),
                "chars": data.get("chars", 0),
                "transcript_preview": data.get("transcript_preview", "")[:200],
            })
        except Exception:
            pass
    return web.json_response({"items": items})


async def api_transcript_get(request):
    """GET /api/transcripts/{id}  -  Get full transcript output."""
    tid = request.match_info["id"]
    for f in TRANSCRIPTS_DIR.glob(f"*_{tid}.json"):
        try:
            return web.Response(text=f.read_text(encoding="utf-8"), content_type="application/json")
        except Exception:
            pass
    return web.json_response({"error": "Not found"}, status=404)


async def ws_chat(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    _ws_clients.add(ws)
    # Tell client our version so it can detect when a reload is needed
    # Include restarted=True for the first 90s after server start (so frontend can nudge user)
    _fresh_restart = (time.time() - _server_start_time) < 90
    await ws.send_json({"type": "system.version", "version": _server_version, "restarted": _fresh_restart, "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]]})
    # Send current sessions immediately so client has fresh data on connect
    await ws.send_json({
        "type": "chat.sessions",
        "sessions": sessions.list_sessions(),
        "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
    })

    try:
      async for msg in ws:
        if msg.type == web.WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                await ws.send_json({"type": "chat.error", "error": "Invalid JSON"})
                continue

            msg_type = data.get("type")

            if msg_type == "chat.new_session":
                s = sessions.create_session()
                await ws.send_json({
                    "type": "chat.session_created",
                    "session_id": s.session_id,
                })

            elif msg_type == "chat.delete_session":
                sid = data.get("session_id")
                sessions.delete_session(sid)
                await ws.send_json({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                    "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
                })

            elif msg_type == "chat.list_sessions":
                await ws.send_json({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                    "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
                })

            elif msg_type == "chat.subscribe_stream":
                sid = data.get("session_id")
                if sid and sid in _active_streams and not _active_streams[sid]["done"]:
                    stream = _active_streams[sid]
                    # Send history first so client has context before stream deltas
                    hist_session = sessions.sessions.get(sid)
                    if hist_session and hist_session.history:
                        await ws.send_json({
                            "type": "chat.history",
                            "session_id": sid,
                            "history": hist_session.history,
                        })
                    _stream_subscribers.setdefault(sid, set()).add(ws)
                    # Replay all buffered events to this late-joining client
                    for event in list(stream["buffer"]):
                        await ws.send_json(event)
                else:
                    await ws.send_json({"type": "chat.stream_not_found", "session_id": sid})

            elif msg_type == "chat.rename_session":
                sid = data.get("session_id")
                title = data.get("title", "").strip()
                if sid and title:
                    sessions.rename_session(sid, title)
                await ws.send_json({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                })

            elif msg_type == "chat.set_topic":
                sid = data.get("session_id")
                topic = data.get("topic", "").strip()
                color = data.get("color")
                if sid and topic == "__remove__":
                    # Remove topic from session
                    sessions.set_session_topic(sid, None, None)
                elif sid and topic:
                    # Save color mapping for future use
                    if color:
                        sessions._save_topic_color(topic, color)
                    else:
                        color = sessions._topic_colors().get(topic) or SessionManager._default_color(topic)
                        sessions._save_topic_color(topic, color)
                    sessions.set_session_topic(sid, topic, color)
                await ws.send_json({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                })
                await ws.send_json({
                    "type": "chat.topics",
                    "topics": sessions.get_topics(),
                    "colors": sessions._topic_colors(),
                })

            elif msg_type == "chat.get_topics":
                await ws.send_json({
                    "type": "chat.topics",
                    "topics": sessions.get_topics(),
                    "colors": sessions._topic_colors(),
                })

            elif msg_type == "chat.classify_session":
                sid = data.get("session_id")
                session = sessions.sessions.get(sid)
                if session and session.history:
                    asyncio.create_task(_classify_session(ws, session))

            elif msg_type == "chat.classify_all":
                # Classify all unclassified sessions (or force=True for all)
                force = data.get("force", False)
                targets = [
                    s for s in sessions.sessions.values()
                    if (not s.topic or force) and s.history
                    and any(m.get("role") == "user" for m in s.history)
                ]
                await ws.send_json({"type": "chat.classify_all_started", "count": len(targets)})
                done_count = [0]
                total = len(targets)
                async def _classify_one(s):
                    try:
                        await _classify_session_headless(s)
                    except Exception as e:
                        print(f"[Classify] Error {s.session_id[:8]}: {e}")
                    done_count[0] += 1
                    await _broadcast_all_ws({"type": "chat.classify_all_progress", "done": done_count[0], "total": total})
                async def _classify_all_bg():
                    # Process in parallel batches of 4
                    batch_size = 4
                    for i in range(0, total, batch_size):
                        batch = targets[i:i+batch_size]
                        await asyncio.gather(*[_classify_one(s) for s in batch])
                    await _broadcast_all_ws({"type": "chat.sessions", "sessions": sessions.list_sessions(), "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]]})
                    await _broadcast_all_ws({"type": "chat.classify_all_done", "total": done_count[0]})
                    print(f"[Classify] All done: {done_count[0]}/{total}")
                asyncio.create_task(_classify_all_bg())

            elif msg_type == "chat.load_history":
                session_id = data.get("session_id")
                session = sessions.sessions.get(session_id)
                # Unknown session_id (e.g. frontend cached a UUID that was never
                # persisted before a restart) → return empty history instead of
                # error. Frontend will hydrate + create on next chat.send.
                await ws.send_json({
                    "type": "chat.history",
                    "session_id": session_id,
                    "history": session.history if session else [],
                })

            elif msg_type == "chat.send":
                session_id = data.get("session_id")
                message = data.get("message", "").strip()
                attachments = data.get("attachments", [])  # list of filenames in uploads/
                if not message and not attachments:
                    await ws.send_json({"type": "chat.error", "error": "Empty message"})
                    continue

                session = sessions.get_or_create(session_id)

                if session.lock.locked():
                    # Auto-unlock only truly stuck sessions:
                    # process dead/gone AND lock held >30s (not just transiently locked)
                    import time as _t
                    process_dead = (
                        session.process is None
                        or session.process.returncode is not None
                    )
                    lock_age = (_t.time() - session._lock_acquired_at) if session._lock_acquired_at else 0
                    stuck = (process_dead and lock_age > 30) or (lock_age > 300)
                    if stuck:
                        print(f"[Session] Auto-unlocking stuck session {session.session_id[:8]} (process_dead={process_dead}, lock_age={lock_age:.0f}s)")
                        await session.cancel()
                        session.force_unlock()
                        session._lock_acquired_at = None
                        session._streaming_partial = None
                        await ws.send_json({
                            "type": "chat.done",
                            "session_id": session.session_id,
                            "full_text": "",
                            "error": "Session war blockiert und wurde automatisch freigegeben.",
                        })
                        continue
                    # Session is actively working — reject, don't kill
                    await ws.send_json({
                        "type": "chat.error",
                        "session_id": session.session_id,
                        "error": "Session is busy  -  wait for current response or cancel.",
                    })
                    continue

                # Run Claude in background task so WS can still receive cancel etc.
                asyncio.create_task(_run_claude(ws, session, message or "(siehe Anhang)", attachments))

            elif msg_type == "chat.cancel":
                session_id = data.get("session_id")
                session = sessions.sessions.get(session_id)
                if session:
                    await session.cancel()
                    session.force_unlock()
                    session._lock_acquired_at = None
                    session._streaming_partial = None
                    session._stream_active = False
                    session.needs_resume = False
                    sessions.persist()  # make sure flags are cleared on disk so next boot doesn't auto-resume
                    await ws.send_json({
                        "type": "chat.cancelled",
                        "session_id": session_id,
                    })


        elif msg.type == web.WSMsgType.ERROR:
            break

    finally:
        _ws_clients.discard(ws)
        _ws_unsubscribe_all(ws)

    return ws


# ---------------------------------------------------------------------------
# TTS (Edge TTS  -  free, no API key + ElevenLabs fallback)
# ---------------------------------------------------------------------------

# Available Edge TTS voices for the dropdown
EDGE_VOICES = {
    "seraphina": {"id": "de-DE-SeraphinaMultilingualNeural", "label": "Seraphina (Sweet)", "gender": "Female"},
    "amala":     {"id": "de-DE-AmalaNeural",                 "label": "Amala (Warm)",  "gender": "Female"},
    "florian":   {"id": "de-DE-FlorianMultilingualNeural",   "label": "Florian (Jarvis Classic)", "gender": "Male"},
    "conrad":    {"id": "de-DE-ConradNeural",                "label": "Conrad (Deep)", "gender": "Male"},
    "ava":       {"id": "en-US-AvaMultilingualNeural",       "label": "Ava (English Sweet)", "gender": "Female"},
    "andrew":    {"id": "en-US-AndrewMultilingualNeural",    "label": "Andrew (English Jarvis)", "gender": "Male"},
}
_active_voice = "seraphina"


async def _edge_tts(text, voice_key):
    """Generate TTS audio using Edge TTS (free, no API key)."""
    import edge_tts, tempfile
    voice_info = EDGE_VOICES.get(voice_key, EDGE_VOICES["seraphina"])
    voice_name = voice_info["id"]

    tmp = Path(tempfile.gettempdir()) / f"jarvis-tts-{uuid.uuid4().hex[:8]}.mp3"
    communicate = edge_tts.Communicate(text, voice_name, rate="+5%")
    await communicate.save(str(tmp))
    audio = tmp.read_bytes()
    tmp.unlink(missing_ok=True)
    return audio


async def api_tts(request):
    """Generate TTS audio  -  uses Edge TTS (free) by default."""
    global _active_voice
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    text = body.get("text", "").strip()
    if not text:
        return web.json_response({"error": "No text provided"}, status=400)

    if len(text) > 5000:
        text = text[:5000]

    try:
        audio = await _edge_tts(text, _active_voice)
        return web.Response(body=audio, content_type="audio/mpeg")
    except Exception as e:
        print(f"[TTS] Edge TTS error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def api_tts_config(request):
    """Return TTS config."""
    return web.json_response({
        "enabled": CONFIG.get("tts_enabled", False),
        "voice": _active_voice,
        "voices": {k: {"label": v["label"], "gender": v["gender"]} for k, v in EDGE_VOICES.items()},
    })


async def api_tts_voice(request):
    """POST /api/tts/voice  -  Switch active voice."""
    global _active_voice
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    voice_key = body.get("voice_id", "").strip()
    if voice_key not in EDGE_VOICES:
        return web.json_response({"error": f"Unknown voice. Available: {list(EDGE_VOICES.keys())}"}, status=400)
    _active_voice = voice_key
    print(f"[TTS] Voice switched to: {voice_key} ({EDGE_VOICES[voice_key]['label']})")
    return web.json_response({"ok": True, "voice": voice_key})


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

async def index_handler(request):
    return web.FileResponse(STATIC_DIR / "index.html", headers={
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
    })


def create_app():
    app = web.Application()

    # Pages
    app.router.add_get("/", index_handler)

    # API
    app.router.add_get("/api/tasks", api_tasks)
    app.router.add_put("/api/tasks", api_tasks)
    app.router.add_post("/api/tasks", api_tasks)
    app.router.add_get("/api/timeline", api_timeline)
    app.router.add_get("/api/memory", api_memory_list)
    app.router.add_get("/api/memory/{filename}", api_memory_file)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_get("/api/email", api_email)
    app.router.add_get("/api/calendar", api_calendar)
    app.router.add_get("/api/system", api_system)
    app.router.add_post("/api/system/restart", api_system_restart)
    app.router.add_post("/api/rag/search", api_rag_search)
    app.router.add_get("/api/rag/status", api_rag_status)
    app.router.add_post("/api/rag/reindex", api_rag_reindex)
    app.router.add_post("/api/rag/reload", api_rag_reload)
    app.router.add_post("/api/quick-action", api_quick_action)
    app.router.add_get("/api/bots", api_bots)
    app.router.add_get("/api/bots/diss-research", api_bots_diss_research)
    app.router.add_get("/api/knowledge-graph", api_knowledge_graph)
    app.router.add_get("/api/diss/research", api_diss_research)
    app.router.add_get("/api/diss/session-topic", api_diss_session_topic)
    app.router.add_post("/api/diss/session-topic", api_diss_session_topic)
    app.router.add_get("/api/diss/wiki-log", api_diss_wiki_log)
    app.router.add_get("/api/diss/wiki-index", api_diss_wiki_index)
    app.router.add_get("/api/medizin/log", api_medizin_log)
    app.router.add_post("/api/medizin/log", api_medizin_log)
    app.router.add_post("/api/medizin/lernplan", api_medizin_lernplan)
    app.router.add_post("/api/anki/generate", api_anki_generate)
    app.router.add_get("/api/trading/account", api_trading_account)
    app.router.add_get("/api/trading/positions", api_trading_positions)
    app.router.add_get("/api/trading/summary", api_trading_summary)
    app.router.add_get("/api/trading/orders", api_trading_orders)
    app.router.add_get("/api/trading/history", api_trading_history)
    app.router.add_post("/api/trading/order", api_trading_order)
    # Trading Bots (Start/Stop/Restart)
    app.router.add_get("/api/trading/bots", api_trading_bots_list)
    app.router.add_post("/api/trading/bots", api_trading_bots_create)
    app.router.add_get("/api/trading/bots/{id}", api_trading_bots_get)
    app.router.add_put("/api/trading/bots/{id}", api_trading_bots_update)
    app.router.add_delete("/api/trading/bots/{id}", api_trading_bots_delete)
    app.router.add_post("/api/trading/bots/{id}/start", api_trading_bots_start)
    app.router.add_post("/api/trading/bots/{id}/stop", api_trading_bots_stop)
    app.router.add_post("/api/trading/bots/{id}/restart", api_trading_bots_restart)
    app.router.add_get("/api/world-monitor", api_world_monitor)

    # Smart Tasks
    app.router.add_post("/api/smart-tasks/size", api_smart_tasks_size)
    app.router.add_get("/api/smart-tasks", api_smart_tasks_list)
    app.router.add_post("/api/smart-tasks", api_smart_tasks_create)
    app.router.add_post("/api/smart-tasks/{id}/start", api_smart_tasks_start)
    app.router.add_get("/api/smart-tasks/{id}", api_smart_tasks_get)
    app.router.add_delete("/api/smart-tasks/{id}", api_smart_tasks_delete)

    # Roadmap (projects.md)
    app.router.add_get("/api/roadmap", api_roadmap_get)
    app.router.add_post("/api/roadmap/suggest", api_roadmap_suggest)
    app.router.add_post("/api/roadmap/{id}/toggle", api_roadmap_toggle)
    app.router.add_post("/api/roadmap/{id}/build", api_roadmap_build)

    # Skills
    app.router.add_get("/api/skills", api_skills)
    app.router.add_get("/api/skills/usage", api_skills_usage)
    app.router.add_get("/api/skills/{slug}", api_skill_detail)
    app.router.add_post("/api/skills", api_skills_install)
    app.router.add_post("/api/skills/preview", api_skills_preview)

    # Arena
    app.router.add_get("/api/arena/rooms", api_arena_rooms)
    app.router.add_post("/api/arena/rooms", api_arena_create)
    app.router.add_get("/api/arena/rooms/{id}", api_arena_room)
    app.router.add_put("/api/arena/rooms/{id}", api_arena_update)
    app.router.add_delete("/api/arena/rooms/{id}", api_arena_delete)
    app.router.add_post("/api/arena/rooms/{id}/start", api_arena_start)
    app.router.add_post("/api/arena/rooms/{id}/stop", api_arena_stop)
    app.router.add_post("/api/arena/rooms/{id}/inject", api_arena_inject)
    app.router.add_post("/api/arena/rooms/{id}/execute", api_arena_execute)
    app.router.add_post("/api/arena/rooms/{id}/orchestrator", api_arena_orchestrator_chat)
    app.router.add_post("/api/arena/rooms/{id}/summarize", api_arena_summarize)
    app.router.add_post("/api/arena/rooms/{id}/approve", api_arena_approve)
    app.router.add_post("/api/arena/rooms/{id}/continue", api_arena_continue)
    app.router.add_get("/api/arena/file-peek", api_arena_file_peek)
    app.router.add_get("/api/arena/files-status", api_arena_files_status)
    app.router.add_post("/api/arena/deep-preview", api_arena_deep_preview)
    app.router.add_post("/api/arena/preview-misclick", api_arena_preview_misclick)
    app.router.add_get("/api/arena/preview-stats", api_arena_preview_stats)

    # Upload
    app.router.add_post("/api/upload", api_upload)
    app.router.add_get("/api/funnel/log", api_funnel_log)
    app.router.add_post("/api/funnel/ingest", api_funnel_ingest)

    # TTS
    app.router.add_post("/api/tts", api_tts)
    app.router.add_get("/api/tts/config", api_tts_config)
    app.router.add_post("/api/tts/voice", api_tts_voice)

    # Transcriber
    app.router.add_post("/api/transcribe", api_transcribe)
    app.router.add_post("/api/transcribe/chat", api_transcribe_chat)
    app.router.add_get("/api/transcripts", api_transcripts)
    app.router.add_get("/api/transcripts/{id}", api_transcript_get)

    # Activity indicators
    app.router.add_get("/api/activity", api_activity_get)
    app.router.add_post("/api/activity/clear/{view}", api_activity_clear)

    # WebSocket
    app.router.add_get("/ws/chat", ws_chat)

    # Health check for reconnect polling
    async def api_health(request):
        import time as _t
        active = [
            {
                "session_id": sid,
                "done": s["done"],
                "lock_held": sessions.sessions.get(sid) and sessions.sessions[sid].lock.locked(),
                "lock_age_s": round(_t.time() - sessions.sessions[sid]._lock_acquired_at, 1)
                    if sessions.sessions.get(sid) and sessions.sessions[sid]._lock_acquired_at else None,
                "has_process": sessions.sessions.get(sid) and sessions.sessions[sid].process is not None,
            }
            for sid, s in _active_streams.items()
        ]
        return web.json_response({
            "ok": True,
            "version": _server_version,
            "ws_clients": len(_ws_clients),
            "active_streams": active,
            "sessions_total": len(sessions.sessions),
        })
    app.router.add_get("/api/health", api_health)

    # Push notifications via ntfy.sh
    async def api_notify_test(request):
        loop = asyncio.get_event_loop()
        ok = await loop.run_in_executor(
            None,
            lambda: send_push("Jarvis Mission Control", "Push funktioniert ✅", priority=4, tags=["white_check_mark"]),
        )
        return web.json_response({"sent": ok})

    async def api_notify_send(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        title = data.get("title", "Jarvis")
        message = data.get("message", "")
        priority = int(data.get("priority", 3))
        tags = data.get("tags")
        click = data.get("click")
        loop = asyncio.get_event_loop()
        ok = await loop.run_in_executor(
            None,
            lambda: send_push(title, message, priority=priority, tags=tags, click=click),
        )
        return web.json_response({"sent": ok})

    app.router.add_post("/api/notify/test", api_notify_test)
    app.router.add_post("/api/notify/send", api_notify_send)

    # Trigger coordinated reload of all connected clients
    async def api_trigger_reload(request):
        await _broadcast_all_ws({
            "type": "system.reload_required",
            "version": _server_version,
            "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
        })
        return web.json_response({"ok": True, "clients": len(_ws_clients), "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]]})
    app.router.add_post("/api/trigger-reload", api_trigger_reload)

    # No-cache middleware for JS and HTML files (prevents stale code after restart)
    @web.middleware
    async def no_cache_static(request, handler):
        resp = await handler(request)
        if request.path.endswith(('.js', '.html')) or request.path in ('/', '/index.html', '/chat'):
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            resp.headers['Pragma'] = 'no-cache'
        return resp
    app.middlewares.append(no_cache_static)

    # Service worker must be served from root so it can control the whole origin.
    async def serve_sw(request):
        return web.FileResponse(
            STATIC_DIR / "sw.js",
            headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
        )
    app.router.add_get("/sw.js", serve_sw)

    # Static files
    app.router.add_static("/static/", path=str(STATIC_DIR), name="static")
    app.router.add_static("/avatars/", path=str(AVATARS_DIR), name="avatars")
    app.router.add_static("/api/uploads/", path=str(UPLOADS_DIR), name="uploads")

    # Startup: classify all sessions that have history but no topic yet
    async def _startup_classify(app):
        unclassified = [
            s for s in sessions.sessions.values()
            if not s.topic and s.history and any(m.get("role") == "user" for m in s.history)
        ]
        if not unclassified:
            return
        print(f"[Classify] Startup: {len(unclassified)} sessions to classify...")
        async def _run_all():
            done = 0
            for s in unclassified:
                await asyncio.sleep(1)  # stagger to avoid hammering Claude
                try:
                    await _classify_session_headless(s)
                except Exception as e:
                    print(f"[Classify] Startup error {s.session_id[:8]}: {e}")
                done += 1
            print(f"[Classify] Startup done: {done}/{len(unclassified)}")
            await _broadcast_all_ws({"type": "chat.sessions", "sessions": sessions.list_sessions(), "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]]})
        asyncio.create_task(_run_all())

    app.on_startup.append(_startup_classify)

    # Periodic classify: every 5 minutes, classify sessions that still have no topic
    _CLASSIFY_INTERVAL = 300  # seconds
    _classify_timer_task = None

    async def _periodic_classify_loop():
        """Background loop: every 5 min, classify unclassified sessions."""
        await asyncio.sleep(60)  # initial delay — let startup classify finish first
        while True:
            try:
                await asyncio.sleep(_CLASSIFY_INTERVAL)
                unclassified = [
                    s for s in sessions.sessions.values()
                    if not s.topic and s.history
                    and any(m.get("role") == "user" for m in s.history)
                ]
                if not unclassified:
                    continue
                print(f"[Classify] Periodic: {len(unclassified)} unclassified sessions found")
                done = 0
                batch_size = 3
                for i in range(0, len(unclassified), batch_size):
                    batch = unclassified[i:i + batch_size]
                    tasks = []
                    for s in batch:
                        tasks.append(_classify_session_headless(s))
                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    for j, res in enumerate(results):
                        if isinstance(res, Exception):
                            print(f"[Classify] Periodic error {batch[j].session_id[:8]}: {res}")
                        done += 1
                    await asyncio.sleep(2)  # small pause between batches
                print(f"[Classify] Periodic done: {done}/{len(unclassified)}")
                await _broadcast_all_ws({
                    "type": "chat.sessions",
                    "sessions": sessions.list_sessions(),
                    "active_streams": [sid for sid, s in _active_streams.items() if not s["done"]],
                })
            except asyncio.CancelledError:
                print("[Classify] Periodic timer cancelled")
                break
            except Exception as e:
                print(f"[Classify] Periodic loop error: {e}")
                await asyncio.sleep(60)  # backoff on unexpected errors

    async def _start_periodic_classify(app):
        nonlocal _classify_timer_task
        _classify_timer_task = asyncio.create_task(_periodic_classify_loop())
        print(f"[Classify] Periodic timer started (every {_CLASSIFY_INTERVAL}s)")

    async def _stop_periodic_classify(app):
        nonlocal _classify_timer_task
        if _classify_timer_task:
            _classify_timer_task.cancel()
            try:
                await _classify_timer_task
            except asyncio.CancelledError:
                pass
            print("[Classify] Periodic timer stopped")

    app.on_startup.append(_start_periodic_classify)
    app.on_cleanup.append(_stop_periodic_classify)

    # -----------------------------------------------------------------------
    # Dead-stream watchdog: detects sessions stuck in _active_streams where
    # the subprocess already died (process dead + lock stale ≥ 90s).
    # Handles the edge case where _run_claude is cancelled before lock
    # acquisition so cleanup code never runs.
    # -----------------------------------------------------------------------
    _dead_stream_watchdog_task = None

    async def _dead_stream_watchdog_loop():
        import time as _wt
        while True:
            await asyncio.sleep(30)
            try:
                for sid in list(_active_streams.keys()):
                    stream = _active_streams.get(sid)
                    if stream is None or stream.get("done"):
                        continue
                    session = sessions.sessions.get(sid)
                    if session is None:
                        # Orphaned stream with no session object — clean up immediately
                        _stream_end(sid)
                        asyncio.get_event_loop().call_later(5, _stream_cleanup, sid)
                        print(f"[Watchdog] Removed orphaned stream {sid[:8]} (no session)")
                        continue
                    process_dead = (
                        session.process is None
                        or session.process.returncode is not None
                    )
                    lock_age = (
                        _wt.time() - session._lock_acquired_at
                        if session._lock_acquired_at else 9999
                    )
                    # Heartbeat: was the stream recently active?
                    hb_age = 9999
                    if session.last_heartbeat:
                        try:
                            from datetime import datetime as _dt
                            hb_age = (_dt.now() - _dt.fromisoformat(session.last_heartbeat)).total_seconds()
                        except Exception:
                            pass
                    stuck = process_dead and (lock_age > 90 or hb_age > 120)
                    if stuck:
                        print(f"[Watchdog] Dead stream detected {sid[:8]} "
                              f"(process_dead={process_dead}, lock_age={lock_age:.0f}s, hb_age={hb_age:.0f}s) — clearing")
                        session._stream_active = False
                        session._streaming_partial = None
                        sessions.persist()
                        if session.lock.locked():
                            session.force_unlock()
                            session._lock_acquired_at = None
                        _stream_end(sid)
                        asyncio.get_event_loop().call_later(5, _stream_cleanup, sid)
                        err_ev = {
                            "type": "chat.done",
                            "session_id": sid,
                            "full_text": "",
                            "error": "Stream wurde automatisch beendet (Prozess nicht mehr aktiv).",
                        }
                        try:
                            await _broadcast_stream_event(sid, err_ev)
                            await _broadcast_all_ws({"type": "chat.sessions",
                                                     "sessions": sessions.list_sessions(),
                                                     "active_streams": [s for s, v in _active_streams.items() if not v.get("done")]})
                        except Exception:
                            pass
            except Exception as e:
                print(f"[Watchdog] Loop error: {e}")

    async def _start_dead_stream_watchdog(app):
        nonlocal _dead_stream_watchdog_task
        _dead_stream_watchdog_task = asyncio.create_task(_dead_stream_watchdog_loop())
        print("[Watchdog] Dead-stream watchdog started (interval: 30s)")

    async def _stop_dead_stream_watchdog(app):
        nonlocal _dead_stream_watchdog_task
        if _dead_stream_watchdog_task:
            _dead_stream_watchdog_task.cancel()
            try:
                await _dead_stream_watchdog_task
            except asyncio.CancelledError:
                pass

    app.on_startup.append(_start_dead_stream_watchdog)
    app.on_cleanup.append(_stop_dead_stream_watchdog)

    async def _startup_arena_recovery(app):
        """On server start: mark any rooms that were 'running' as 'paused' (process died)."""
        try:
            rooms = _load_arena_rooms()
            changed = False
            for r in rooms:
                if r.get("status") == "running":
                    r["status"] = "paused"
                    changed = True
                    print(f"[Arena] Recovered room {r.get('title','?')} → paused")
            if changed:
                _save_arena_rooms(rooms)
                # Broadcast after WS clients connect (slight delay)
                async def _notify():
                    await asyncio.sleep(2)
                    await _broadcast_all_ws({"type": "arena.server_restart"})
                asyncio.create_task(_notify())
        except Exception as e:
            print(f"[Arena] Startup recovery error: {e}")
    app.on_startup.append(_startup_arena_recovery)

    async def _startup_smart_tasks_recovery(app):
        """On server start: reset any 'running' smart tasks to 'interrupted' (subprocesses died with parent)."""
        try:
            tasks = _load_smart_tasks()
            now = datetime.now()
            now_iso = now.isoformat()
            changed = False
            reset_count = 0
            for t in tasks:
                if t.get("status") == "running":
                    started_str = t.get("started")
                    age_minutes = None
                    if started_str:
                        try:
                            started_dt = datetime.fromisoformat(started_str)
                            age_minutes = (now - started_dt).total_seconds() / 60.0
                        except Exception:
                            age_minutes = None
                    t["status"] = "interrupted"
                    t["interrupted_by"] = "server_restart"
                    t["interrupted_at"] = now_iso
                    t["pid"] = None
                    if age_minutes is not None:
                        t["interrupted_after_minutes"] = round(age_minutes, 1)
                        t["stale"] = age_minutes >= 15.0
                    changed = True
                    reset_count += 1
                    print(f"[SmartTasks] Recovered task {t.get('title','?')} → interrupted (age: {age_minutes})")
            if changed:
                _save_smart_tasks(tasks)
                async def _notify():
                    await asyncio.sleep(2)
                    try:
                        await _broadcast_all_ws({"type": "smart_tasks.server_restart", "reset": reset_count})
                    except Exception:
                        pass
                asyncio.create_task(_notify())
        except Exception as e:
            print(f"[SmartTasks] Startup recovery error: {e}")
    app.on_startup.append(_startup_smart_tasks_recovery)

    async def _start_window_hider(app):
        asyncio.create_task(_window_hider_loop())
    app.on_startup.append(_start_window_hider)

    async def _auto_resume_interrupted(app):
        """Re-trigger any session whose last turn was cut off by a restart.

        Detection is done in SessionManager.load() via `needs_resume`. We wait a
        few seconds so WS clients can (re)connect and watch the stream live.
        """
        async def _safe_resume(s):
            """Wrap _run_claude so a crash during resume does not leave the session
            silently hung — broadcast an error event instead."""
            try:
                await _run_claude(
                    None, s,
                    "Bitte mach weiter wo du aufgehört hast — der Server ist neugestartet.",
                    None,
                )
            except Exception as e:
                import traceback as _tb
                err_txt = f"{type(e).__name__}: {e}"
                print(f"[AutoResume] Resume crashed for {s.session_id[:8]}: {err_txt}")
                print(_tb.format_exc())
                try:
                    s._stream_active = False
                    sessions.persist()
                except Exception:
                    pass
                try:
                    await _broadcast_stream_event(s.session_id, {
                        "type": "chat.error",
                        "session_id": s.session_id,
                        "error": f"Auto-Resume fehlgeschlagen: {err_txt}",
                    })
                except Exception:
                    pass

        async def _go():
            await asyncio.sleep(3)
            pending = [s for s in list(sessions.sessions.values()) if getattr(s, "needs_resume", False)]
            if not pending:
                return
            print(f"[AutoResume] Resuming {len(pending)} interrupted session(s)")
            for s in pending:
                s.needs_resume = False
                asyncio.create_task(_safe_resume(s))
                await asyncio.sleep(0.5)  # stagger to avoid MCP startup pile-up
        asyncio.create_task(_go())
    app.on_startup.append(_auto_resume_interrupted)

    return app


if __name__ == "__main__":
    port = CONFIG.get("port", 8080)
    host = CONFIG.get("host", "0.0.0.0")

    # HTTPS disabled  -  use Chrome flag for mic access over LAN instead
    ssl_ctx = None
    protocol = "http"

    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan_ip = s.getsockname()[0]
        s.close()
    except Exception:
        lan_ip = "unknown"

    print(f"\n  Mission Control V3")
    print(f"  Local:   {protocol}://localhost:{port}")
    print(f"  LAN:     {protocol}://{lan_ip}:{port}")
    print()
    web.run_app(create_app(), host=host, port=port, ssl_context=ssl_ctx, print=None)


