#!/usr/bin/env python3
"""
Jarvis Telegram Bridge — Polls Telegram for messages, routes them to Claude CLI.
Usage:
  python telegram-bridge.py                # Normal mode
  python telegram-bridge.py --verbose      # Debug output
  python telegram-bridge.py --dry-run      # Don't send to Claude, just echo back
"""
import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# --- Config ---
SCRIPTS_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPTS_DIR.parent / "data"
SECRETS_DIR = SCRIPTS_DIR.parent / "secrets"
STATE_FILE = DATA_DIR / "telegram-state.json"
LOG_FILE = DATA_DIR / "telegram-bridge.log"

BOT_TOKEN = os.environ.get(
    "TELEGRAM_BOT_TOKEN",
    "8484154438:AAFXvvnhK-7V6raOOXOa2qlkD0y3smVhM5A"
)
ALLOWED_USERS = {8178215734}  # Robin's Telegram user ID
BOT_USERNAME = "RobinMandels_Jarvis_bot"
POLL_INTERVAL = 2  # seconds
CLAUDE_TIMEOUT = 300  # 5 minutes — gibt Claude Luft fuer Tool-Calls
CLAUDE_CLI = os.environ.get("CLAUDE_CLI", r"C:\Users\Robin\.local\bin\claude.exe")
MAX_MESSAGE_LENGTH = 4000  # Telegram limit ~4096, leave margin
LOCK_FILE = DATA_DIR / "telegram-bridge.lock"

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ]
)
log = logging.getLogger("telegram-bridge")


# --- Telegram API ---
import html as _html
import requests

# --- Markdown -> HTML converter (Telegram parse_mode=HTML) ---
# Telegram HTML unterstuetzt: <b> <i> <u> <s> <code> <pre> <a>
# Wir mappen: **x** -> <b>x</b>, *x* (italic) ueberspringen (kollidiert zu oft),
# `x` -> <code>x</code>, ```x``` -> <pre>x</pre>.
_CODE_BLOCK_RE = re.compile(r"```(?:[\w+-]*\n)?(.*?)```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`\n]+?)`")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)


def md_to_html(text: str) -> str:
    """Convert a minimal Markdown subset to Telegram-safe HTML."""
    if not text:
        return ""
    placeholders = {}

    def _stash(kind, inner):
        key = f"\x00{kind}{len(placeholders)}\x00"
        placeholders[key] = inner
        return key

    # 1) Extract fenced code blocks first
    def _cb(m):
        return _stash("PRE", m.group(1))
    text = _CODE_BLOCK_RE.sub(_cb, text)

    # 2) Extract inline code
    def _ic(m):
        return _stash("CODE", m.group(1))
    text = _INLINE_CODE_RE.sub(_ic, text)

    # 3) Escape remaining text
    text = _html.escape(text, quote=False)

    # 4) Bold — operates on already-escaped text; **foo** is literal
    text = _BOLD_RE.sub(r"<b>\1</b>", text)

    # 5) Re-inject code with escaped contents
    for key, inner in placeholders.items():
        inner_esc = _html.escape(inner, quote=False)
        if key.startswith("\x00PRE"):
            text = text.replace(key, f"<pre>{inner_esc}</pre>")
        else:
            text = text.replace(key, f"<code>{inner_esc}</code>")
    return text


def tg_get(method, params=None):
    r = requests.get(f"{API_BASE}/{method}", params=params, timeout=30)
    data = r.json()
    if not data.get("ok"):
        log.error(f"Telegram API error: {data}")
    return data


def tg_post(method, payload):
    r = requests.post(f"{API_BASE}/{method}", json=payload, timeout=30)
    data = r.json()
    if not data.get("ok"):
        log.error(f"Telegram API error: {data}")
    return data


def send_message(chat_id, text, raw_html=False):
    """Send a message, splitting if too long. Converts Markdown->HTML unless raw_html."""
    body = text if raw_html else md_to_html(text)
    chunks = []
    while len(body) > MAX_MESSAGE_LENGTH:
        split_at = body.rfind("\n", 0, MAX_MESSAGE_LENGTH)
        if split_at < MAX_MESSAGE_LENGTH // 2:
            split_at = MAX_MESSAGE_LENGTH
        chunks.append(body[:split_at])
        body = body[split_at:].lstrip("\n")
    chunks.append(body)

    for chunk in chunks:
        payload = {
            "chat_id": chat_id,
            "text": chunk,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        r = tg_post("sendMessage", payload)
        # Fallback: if HTML parse fails (bad tags from Claude), resend as plain text
        if not r.get("ok"):
            tg_post("sendMessage", {"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True})


def send_message_get_id(chat_id, text, raw_html=False):
    """Send a message and return its message_id (or None)."""
    body = text if raw_html else md_to_html(text)
    payload = {
        "chat_id": chat_id,
        "text": body,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    r = tg_post("sendMessage", payload)
    if r.get("ok"):
        return r["result"]["message_id"]
    # Fallback without parse_mode
    r = tg_post("sendMessage", {"chat_id": chat_id, "text": body, "disable_web_page_preview": True})
    if r.get("ok"):
        return r["result"]["message_id"]
    return None


def edit_message(chat_id, message_id, text, raw_html=False):
    """Edit a previously sent message. Returns True on success."""
    body = text if raw_html else md_to_html(text)
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": body,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    r = tg_post("editMessageText", payload)
    if r.get("ok"):
        return True
    # Fallback without parse_mode (in case of broken tags)
    r = tg_post("editMessageText", {
        "chat_id": chat_id, "message_id": message_id, "text": body,
        "disable_web_page_preview": True,
    })
    return r.get("ok", False)


def send_typing(chat_id):
    try:
        tg_post("sendChatAction", {"chat_id": chat_id, "action": "typing"})
    except Exception:
        pass


# --- State ---
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"last_update_id": 0}


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


# --- Conversation History ---
MAX_HISTORY = 5  # Keep last 5 exchanges (10 entries) — keeps prompt under 15K chars
HISTORY_FILE = DATA_DIR / "telegram-history.json"


def load_history():
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def save_history(history):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


conversation_history = load_history()


def add_to_history(role, text):
    conversation_history.append({
        "role": role,
        "text": text,
        "ts": datetime.now().strftime("%H:%M")
    })
    while len(conversation_history) > MAX_HISTORY * 2:
        conversation_history.pop(0)
    save_history(conversation_history)


VAULT_DIR = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
MEMORY_FILES = ["robin.md", "identity.md", "projects.md", "todos.md", "decisions.md"]
MAX_FILE_CHARS = 800
MAX_VAULT_CHARS = 3000


def load_vault_context():
    """Load key memory files, truncated to keep prompt under control."""
    parts = []
    total = 0
    for name in MEMORY_FILES:
        if total >= MAX_VAULT_CHARS:
            break
        p = VAULT_DIR / name
        if p.exists():
            try:
                content = p.read_text(encoding="utf-8").strip()
                if content:
                    chunk = content[:MAX_FILE_CHARS]
                    if len(content) > MAX_FILE_CHARS:
                        chunk += f"\n[...{name} gekürzt]"
                    parts.append(chunk)
                    total += len(chunk)
            except Exception:
                pass
    today = datetime.now().strftime("%Y-%m-%d")
    daily = VAULT_DIR / f"{today}.md"
    if daily.exists() and total < MAX_VAULT_CHARS:
        try:
            content = daily.read_text(encoding="utf-8").strip()
            if content:
                parts.append(f"# Tageslog {today}\n{content[:600]}")
        except Exception:
            pass
    return "\n\n---\n\n".join(parts) if parts else ""


def build_prompt_with_history(message):
    """Build a prompt that includes vault context and conversation history."""
    parts = []

    # Vault context (loaded fresh each time)
    vault = load_vault_context()
    if vault:
        parts.append(f"=== DEIN GEDAECHTNIS ===\n{vault}\n=== ENDE GEDAECHTNIS ===\n")

    if conversation_history:
        parts.append("Bisheriger Gespraechsverlauf:")
        for entry in conversation_history:
            role = "Robin" if entry["role"] == "user" else "Jarvis"
            ts = entry.get("ts", "")
            parts.append(f"[{ts}] {role}: {entry['text']}")
        parts.append("")
    parts.append(f"Robin: {message}")
    parts.append("\nAntworte als Jarvis auf Robins letzte Nachricht.")
    return "\n".join(parts)


# --- Voice transcription ---
def transcribe_voice(file_id):
    """Download a Telegram voice message and transcribe it with Whisper."""
    # Get file path from Telegram
    file_info = tg_get("getFile", {"file_id": file_id})
    file_path = file_info.get("result", {}).get("file_path")
    if not file_path:
        raise ValueError("Konnte Datei-Info nicht von Telegram holen")

    # Download the file
    dl_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"
    r = requests.get(dl_url, timeout=30)
    r.raise_for_status()

    # Save to temp file
    suffix = Path(file_path).suffix or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(DATA_DIR)) as tmp:
        tmp.write(r.content)
        tmp_path = tmp.name

    try:
        # Transcribe with Whisper
        result = subprocess.run(
            ["whisper", tmp_path, "--language", "de", "--model", "base", "--output_format", "txt", "--output_dir", str(DATA_DIR)],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace",
        )
        # Read the transcript
        txt_file = Path(tmp_path).with_suffix(".txt")
        if txt_file.exists():
            transcript = txt_file.read_text(encoding="utf-8").strip()
            txt_file.unlink(missing_ok=True)
            return transcript
        # Fallback: check stdout
        if result.stdout.strip():
            return result.stdout.strip()
        log.error(f"Whisper stderr: {result.stderr[:300]}")
        return None
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# --- Image download ---
def download_telegram_file(file_id, suffix=".jpg"):
    """Download a file from Telegram by file_id, return local path."""
    file_info = tg_get("getFile", {"file_id": file_id})
    file_path = file_info.get("result", {}).get("file_path")
    if not file_path:
        raise ValueError("Konnte Datei-Info nicht von Telegram holen")
    dl_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"
    r = requests.get(dl_url, timeout=30)
    r.raise_for_status()
    ext = Path(file_path).suffix or suffix
    local_path = DATA_DIR / f"tg_photo_{int(time.time())}{ext}"
    local_path.write_bytes(r.content)
    return str(local_path)


# --- Claude CLI ---
TYPING_REFRESH_INTERVAL = 4.0  # Telegram typing-action expires after 5s, refresh every 4s


def ask_claude(message, chat_id, image_paths=None):
    """Send a message to Claude CLI. Keeps typing-indicator alive while Claude thinks.
    Sends ONE final message at the end. Returns the final text."""
    prompt = build_prompt_with_history(message)
    system_prompt = (
        "Du bist Jarvis, Robins persoenlicher AI-Assistent. "
        "Robin schreibt dir ueber Telegram. "
        "Du hast vollen Zugriff auf alle Tools: Dateien lesen/schreiben/editieren, "
        "Bash-Befehle ausfuehren, Dateien suchen, grep, Agents spawnen — nutze sie aktiv! "
        "Arbeitsverzeichnis: C:/Users/Robin/Jarvis. "
        "Antworte kurz und praegnant, Telegram-Format. "
        "Deutsch by default. Sei direkt, hilfreich, mit Persoenlichkeit. "
        "Keine Fuellwoerter. Du bekommst den Gespraechsverlauf mitgeliefert."
    )

    max_turns = "0"
    extra_args = []
    if image_paths:
        img_info = "\n".join([
            f"WICHTIG: Robin hat ein Bild geschickt. Die Datei liegt unter: {p}\n"
            f"Du MUSST zuerst das Read-Tool auf diesen Pfad ausfuehren um das Bild zu sehen, "
            f"BEVOR du antwortest. Claude Code kann Bilder lesen — nutze Read auf den Pfad."
            for p in image_paths
        ])
        prompt = f"{prompt}\n\n{img_info}"
        max_turns = "5"
        extra_args = ["--allowedTools", "Read"]

    cmd = [
        CLAUDE_CLI,
        "-p", prompt,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--max-turns", max_turns,
        "--dangerously-skip-permissions",
        "--system-prompt", system_prompt,
        "--no-session-persistence",
    ] + extra_args

    accumulated = ""
    final_text = ""
    last_typing = 0.0
    start_time = time.time()

    # Kick off typing indicator immediately
    send_typing(chat_id)
    last_typing = time.time()

    try:
        log.info(f"Claude stream: max_turns={max_turns}, prompt={len(prompt)} chars")

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            cwd="C:/Users/Robin/Jarvis",
            creationflags=subprocess.CREATE_NO_WINDOW,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        try:
            for line in proc.stdout:
                # Timeout check
                if time.time() - start_time > CLAUDE_TIMEOUT:
                    log.error(f"Claude stream-timeout nach {CLAUDE_TIMEOUT}s")
                    proc.kill()
                    break

                # Refresh typing indicator every 4s so Telegram keeps showing "schreibt..."
                now = time.time()
                if now - last_typing >= TYPING_REFRESH_INTERVAL:
                    send_typing(chat_id)
                    last_typing = now

                line = line.strip()
                if not line:
                    continue

                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                etype = event.get("type")

                # Partial text deltas (true streaming) — we only track for fallback
                if etype == "stream_event":
                    se = event.get("event", {})
                    if se.get("type") == "content_block_delta":
                        delta = se.get("delta", {})
                        if delta.get("type") == "text_delta":
                            accumulated += delta.get("text", "")

                # Full assistant turn
                elif etype == "assistant":
                    msg_content = event.get("message", {}).get("content", [])
                    text_parts = [b.get("text", "") for b in msg_content if b.get("type") == "text"]
                    if text_parts:
                        final_text = "".join(text_parts)

                # Final wrap-up event
                elif etype == "result":
                    r_text = event.get("result") or event.get("message", "")
                    if isinstance(r_text, str) and r_text.strip():
                        final_text = r_text

            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

        stderr_out = proc.stderr.read() if proc.stderr else ""
        if stderr_out:
            log.warning(f"Claude stderr: {stderr_out[:300]}")

        log.info(f"Claude RC={proc.returncode}, final={len(final_text)} chars, accum={len(accumulated)} chars")

        final = (final_text or accumulated).strip()
        if not final:
            final = stderr_out.strip()[:500] or "Keine Antwort von Claude."

        # Clean one-shot delivery — send_message handles splitting if too long
        send_message(chat_id, final)
        return final

    except FileNotFoundError:
        log.error(f"Claude CLI nicht gefunden: {CLAUDE_CLI}")
        err = "Claude CLI nicht gefunden."
        send_message(chat_id, err)
        return err
    except Exception as e:
        log.error(f"Claude Fehler: {e}", exc_info=True)
        err = f"Fehler: {e}"
        try:
            send_message(chat_id, err)
        except Exception:
            pass
        return err


# --- Command handling ---
COMMANDS = {
    "/heartbeat": "Heartbeat jetzt ausfuehren",
    "/mails": "Ungelesene Mails zeigen",
    "/kalender": "Naechste Termine zeigen",
    "/status": "System-Status",
    "/help": "Diese Hilfe",
}


def handle_command(text, chat_id):
    """Handle special /commands locally without Claude."""
    cmd = text.strip().split()[0].lower()

    if cmd == "/help":
        lines = ["*Jarvis Telegram Commands:*"]
        for c, desc in COMMANDS.items():
            lines.append(f"`{c}` — {desc}")
        lines.append("\nAlles andere geht direkt an Claude.")
        return "\n".join(lines)

    if cmd == "/heartbeat":
        try:
            env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
            result = subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "heartbeat.py"), "--force"],
                capture_output=True, text=True, timeout=45,
                encoding="utf-8", errors="replace", env=env
            )
            return result.stdout.strip() or "Heartbeat lief, aber keine Ausgabe."
        except Exception as e:
            return f"Heartbeat-Fehler: {e}"

    if cmd == "/mails":
        try:
            env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
            result = subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "outlook_graph.py"), "unread", "--top", "10"],
                capture_output=True, text=True, timeout=15,
                encoding="utf-8", errors="replace", env=env
            )
            return result.stdout.strip() or "Keine ungelesenen Mails."
        except Exception as e:
            return f"Mail-Check Fehler: {e}"

    if cmd == "/kalender":
        try:
            env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
            result = subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "icloud-calendar.py"), "list-events", "--days", "3"],
                capture_output=True, text=True, timeout=30,
                encoding="utf-8", errors="replace", env=env
            )
            return result.stdout.strip() or "Keine Termine in den naechsten 3 Tagen."
        except Exception as e:
            return f"Kalender-Fehler: {e}"

    if cmd == "/status":
        now = datetime.now().strftime("%d.%m.%Y %H:%M")
        state = load_state()
        msgs = state.get("messages_handled", 0)
        return (
            f"*Jarvis Status*\n"
            f"Zeit: {now}\n"
            f"Nachrichten verarbeitet: {msgs}\n"
            f"Bot: @RobinMandels_Jarvis_bot\n"
            f"Claude CLI: aktiv"
        )

    return None  # Not a known command


# --- Main loop ---
def poll_loop(args):
    state = load_state()
    last = state.get("last_update_id", 0)
    offset = last + 1 if last > 0 else None  # None = get all pending on first run
    state.setdefault("messages_handled", 0)

    log.info(f"Jarvis Telegram Bridge gestartet. Polling alle {POLL_INTERVAL}s...")
    log.info(f"Bot: @RobinMandels_Jarvis_bot | Erlaubte User: {ALLOWED_USERS}")

    while True:
        try:
            params = {"timeout": 20, "allowed_updates": '["message"]'}
            if offset is not None:
                params["offset"] = offset
            data = tg_get("getUpdates", params)

            for update in data.get("result", []):
                update_id = update["update_id"]
                offset = update_id + 1
                state["last_update_id"] = update_id

                msg = update.get("message")
                if not msg:
                    continue

                user = msg.get("from", {})
                user_id = user.get("id")
                chat_id = msg["chat"]["id"]
                chat_type = msg["chat"].get("type", "private")
                text = msg.get("text", "") or msg.get("caption", "")
                user_name = user.get("first_name", "?")

                # Log all message types for debugging
                msg_types = [k for k in ("text", "photo", "voice", "audio", "document", "sticker", "video", "video_note") if k in msg]
                log.info(f"Update {update_id} von {user_name} (chat {chat_type}): types={msg_types}")

                # Gruppen-Pre-Filter: in Gruppen nur reagieren wenn Bot erwähnt oder gerepliet wurde.
                # Alles andere (inkl. unautorisierter User) wird still verworfen — kein Spam, kein Outing.
                if chat_type in ("group", "supergroup"):
                    mention = f"@{BOT_USERNAME}"
                    raw_text = msg.get("text", "") or msg.get("caption", "")
                    reply_to = msg.get("reply_to_message") or {}
                    reply_from = (reply_to.get("from") or {}).get("username", "") or ""
                    is_reply_to_bot = reply_from.lower() == BOT_USERNAME.lower()
                    if mention.lower() not in raw_text.lower() and not is_reply_to_bot:
                        log.debug(f"Gruppe ohne Mention/Reply — ignoriert (user={user_name})")
                        continue

                # Security: only allow Robin. In Gruppen still weitergehen (wurde oben schon gefiltert),
                # hier nur in DMs Klartext-Reply.
                if user_id not in ALLOWED_USERS:
                    log.warning(f"Unauthorized user: {user_id} ({user_name}) in {chat_type}")
                    if chat_type == "private":
                        send_message(chat_id, "Nicht autorisiert.")
                    continue

                # --- Voice memo support ---
                voice = msg.get("voice") or msg.get("audio")
                if voice:
                    log.info(f"Voice memo von {user_name} ({voice.get('duration', '?')}s)")
                    try:
                        send_typing(chat_id)
                        text = transcribe_voice(voice["file_id"])
                        if not text:
                            send_message(chat_id, "Konnte Sprachnachricht nicht transkribieren.")
                            continue
                        log.info(f"Transkription: {text[:100]}")
                        # Prefix so Jarvis knows it was a voice memo
                        text = f"[Sprachmemo] {text}"
                    except Exception as ve:
                        log.error(f"Voice-Fehler: {ve}", exc_info=True)
                        send_message(chat_id, f"Voice-Fehler: {ve}")
                        continue

                # --- Photo/Image support ---
                photo = msg.get("photo")
                image_paths = []
                if photo:
                    log.info(f"Foto von {user_name} — {len(photo)} Groessen verfuegbar")
                    try:
                        send_typing(chat_id)
                        # Telegram sends multiple sizes, pick largest
                        best = photo[-1]
                        log.info(f"Lade Foto: file_id={best.get('file_id', '?')[:20]}..., "
                                 f"size={best.get('width', '?')}x{best.get('height', '?')}")
                        img_path = download_telegram_file(best["file_id"], ".jpg")
                        file_size = Path(img_path).stat().st_size
                        image_paths.append(img_path)
                        caption = msg.get("caption", "")
                        text = f"[Bild] {caption}" if caption else "[Bild] Robin hat dir ein Bild geschickt. Beschreibe was du siehst."
                        log.info(f"Foto heruntergeladen: {img_path} ({file_size} bytes)")
                    except Exception as pe:
                        log.error(f"Foto-Fehler: {pe}", exc_info=True)
                        send_message(chat_id, f"Konnte Foto nicht verarbeiten: {pe}")
                        continue

                # --- Document/file support (images sent as files) ---
                doc = msg.get("document")
                if doc and not image_paths:
                    mime = doc.get("mime_type", "")
                    if mime.startswith("image/"):
                        log.info(f"Bild-Dokument von {user_name}: {doc.get('file_name', '?')}")
                        try:
                            send_typing(chat_id)
                            ext = Path(doc.get("file_name", "file.jpg")).suffix or ".jpg"
                            img_path = download_telegram_file(doc["file_id"], ext)
                            image_paths.append(img_path)
                            caption = msg.get("caption", "")
                            text = f"[Bild] {caption}" if caption else "[Bild] Robin hat dir ein Bild geschickt. Beschreibe was du siehst."
                        except Exception as de:
                            log.error(f"Dokument-Fehler: {de}", exc_info=True)
                            send_message(chat_id, f"Konnte Dokument nicht verarbeiten: {de}")
                            continue

                # --- In Gruppen: Bot-Mention aus text strippen (Pre-Filter oben hat Zugang schon validiert) ---
                if chat_type in ("group", "supergroup"):
                    text = re.sub(rf"@{BOT_USERNAME}", "", text, flags=re.IGNORECASE).strip()
                    # Wenn nur Mention in Caption war und text zu [Bild]... umgeschrieben wurde, fallback
                    if not text and image_paths:
                        text = "[Bild] Robin hat dir ein Bild geschickt. Beschreibe was du siehst."

                if not text and not image_paths:
                    continue

                log.info(f"Nachricht von {user_name}: {text[:100]}")

                try:
                    # Check for local commands first
                    if text.startswith("/"):
                        response = handle_command(text, chat_id)
                        if response:
                            send_message(chat_id, response)
                            state["messages_handled"] = state.get("messages_handled", 0) + 1
                            save_state(state)
                            continue

                    # Send to Claude (streaming: ask_claude sends/edits Telegram msg itself)
                    if args.dry_run:
                        response = f"[DRY RUN] Haette Claude gefragt: {text}"
                        send_message(chat_id, response)
                    else:
                        send_typing(chat_id)
                        response = ask_claude(text, chat_id, image_paths=image_paths if image_paths else None)

                    # Update conversation history (persisted to disk)
                    add_to_history("user", text)
                    add_to_history("assistant", response)

                    log.info(f"Antwort ({len(response)} chars): {response[:100]}")
                    state["messages_handled"] = state.get("messages_handled", 0) + 1
                    save_state(state)

                    # Cleanup downloaded images
                    for img_p in image_paths:
                        try:
                            Path(img_p).unlink(missing_ok=True)
                        except Exception:
                            pass
                except Exception as msg_err:
                    log.error(f"Fehler bei Nachricht '{text[:50]}': {msg_err}", exc_info=True)
                    try:
                        send_message(chat_id, f"Fehler: {msg_err}")
                    except Exception:
                        pass

        except KeyboardInterrupt:
            log.info("Bridge gestoppt.")
            save_state(state)
            break
        except Exception as e:
            log.error(f"Poll-Fehler: {e}", exc_info=True)
            time.sleep(5)

        time.sleep(POLL_INTERVAL)


def main():
    parser = argparse.ArgumentParser(description="Jarvis Telegram Bridge")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Don't call Claude, just echo")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Single-instance lock
    if LOCK_FILE.exists():
        try:
            old_pid = int(LOCK_FILE.read_text().strip())
            # Check if process is still running
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, old_pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if handle:
                kernel32.CloseHandle(handle)
                log.error(f"Bridge laeuft bereits (PID {old_pid}). Beende.")
                sys.exit(1)
        except (ValueError, OSError):
            pass

    LOCK_FILE.write_text(str(os.getpid()))

    try:
        poll_loop(args)
    finally:
        LOCK_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
