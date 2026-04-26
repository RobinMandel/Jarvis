"""Local SQLite cache for the Email panel.

One database, three accounts (Outlook/Graph, Uni Ulm/IMAP, Gmail/IMAP).
Folders + messages are synced via scripts in ../scripts. The MC server only
reads from this DB in the API hot-path; sync runs either on demand
(POST /api/email/sync) or via a scheduled background task.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "emails.db"

_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT UNIQUE NOT NULL,     -- 'outlook' | 'uni' | 'gmail'
    kind          TEXT NOT NULL,            -- 'graph' | 'imap'
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    color         TEXT DEFAULT '#6366f1',
    config        TEXT,                     -- JSON: IMAP host/port, graph scopes, ...
    last_sync_at  TEXT,
    last_error    TEXT
);

CREATE TABLE IF NOT EXISTS folders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id     TEXT NOT NULL,            -- Graph folder id / IMAP folder name
    parent_remote TEXT,                     -- parent folder remote_id (NULL for roots)
    path          TEXT NOT NULL,            -- full path e.g. 'Inbox/Projekte/Jarvis'
    display_name  TEXT NOT NULL,
    kind          TEXT,                     -- 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'custom'
    total_count   INTEGER DEFAULT 0,
    unread_count  INTEGER DEFAULT 0,
    UNIQUE (account_id, remote_id)
);

CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent  ON folders(parent_remote);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id       INTEGER NOT NULL REFERENCES folders(id)  ON DELETE CASCADE,
    remote_id       TEXT NOT NULL,
    internet_id     TEXT,                   -- Message-ID header, stable across accounts
    thread_id       TEXT,                   -- Graph: conversationId / IMAP: thrid if available
    subject         TEXT,
    from_name       TEXT,
    from_addr       TEXT,
    to_json         TEXT,                   -- JSON array of {name, addr}
    cc_json         TEXT,
    bcc_json        TEXT,
    date            TEXT,                   -- ISO8601 UTC
    preview         TEXT,                   -- first ~250 chars of plaintext
    body_text       TEXT,                   -- full plaintext (lazy-fetched for Graph on first read)
    body_html       TEXT,
    is_read         INTEGER DEFAULT 0,      -- 0|1
    has_attachments INTEGER DEFAULT 0,
    size_bytes      INTEGER,
    web_link        TEXT,                   -- Graph webLink (open in owa)
    UNIQUE (account_id, remote_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_internet_id ON messages(internet_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread      ON messages(thread_id);

CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    remote_id     TEXT,
    filename      TEXT NOT NULL,
    content_type  TEXT,
    size_bytes    INTEGER,
    inline        INTEGER DEFAULT 0
);
"""


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def db():
    """Serialized connection — fine for our low-traffic panel use."""
    with _LOCK:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)


# ---------- Accounts ----------

DEFAULT_ACCOUNTS = [
    {
        "slug": "outlook",
        "kind": "graph",
        "email": "robinmandel@outlook.de",
        "display_name": "Outlook",
        "color": "#0078d4",
        "config": {"scopes": ["Mail.Read", "Mail.Send"]},
    },
    {
        "slug": "uni",
        "kind": "imap",
        "email": "robin.mandel@uni-ulm.de",
        "display_name": "Uni Ulm",
        "color": "#16a34a",
        "config": {
            "host": "imap.uni-ulm.de",
            "port": 993,
            "cred_file": "C:/Users/Robin/Jarvis/secrets/uni-mail-cred.json",
        },
    },
    {
        "slug": "gmail",
        "kind": "imap",
        "email": "robinmaxmandel@gmail.com",
        "display_name": "Gmail",
        "color": "#ea4335",
        "config": {
            "host": "imap.gmail.com",
            "port": 993,
            "cred_env": "GMAIL_APP_PASSWORD",
        },
    },
]


def ensure_default_accounts() -> None:
    with db() as conn:
        for a in DEFAULT_ACCOUNTS:
            conn.execute(
                """INSERT OR IGNORE INTO accounts
                   (slug, kind, email, display_name, color, config)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (a["slug"], a["kind"], a["email"], a["display_name"], a["color"],
                 json.dumps(a["config"])),
            )


def get_account(slug: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE slug = ?", (slug,)).fetchone()
        return _row_to_dict(row) if row else None


def list_accounts() -> list[dict]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM accounts ORDER BY id").fetchall()
        return [_row_to_dict(r) for r in rows]


def set_account_sync_result(account_id: int, *, error: str | None = None) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE accounts SET last_sync_at = ?, last_error = ? WHERE id = ?",
            (datetime.utcnow().isoformat(timespec="seconds") + "Z", error, account_id),
        )


# ---------- Folders ----------

def upsert_folder(*, account_id: int, remote_id: str, parent_remote: str | None,
                  path: str, display_name: str, kind: str | None,
                  total_count: int = 0, unread_count: int = 0) -> int:
    with db() as conn:
        conn.execute(
            """INSERT INTO folders
                 (account_id, remote_id, parent_remote, path, display_name,
                  kind, total_count, unread_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_id, remote_id) DO UPDATE SET
                 parent_remote=excluded.parent_remote,
                 path=excluded.path,
                 display_name=excluded.display_name,
                 kind=excluded.kind,
                 total_count=excluded.total_count,
                 unread_count=excluded.unread_count""",
            (account_id, remote_id, parent_remote, path, display_name,
             kind, total_count, unread_count),
        )
        row = conn.execute(
            "SELECT id FROM folders WHERE account_id = ? AND remote_id = ?",
            (account_id, remote_id),
        ).fetchone()
        return row["id"]


def list_folders(account_id: int) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            """SELECT * FROM folders WHERE account_id = ?
               ORDER BY (kind = 'inbox') DESC, (kind = 'sent') DESC, path""",
            (account_id,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def get_folder(folder_id: int) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
        return _row_to_dict(row) if row else None


# ---------- Messages ----------

def upsert_message(*, account_id: int, folder_id: int, remote_id: str,
                   internet_id: str | None, thread_id: str | None,
                   subject: str | None, from_name: str | None, from_addr: str | None,
                   to_list: list | None, cc_list: list | None, bcc_list: list | None,
                   date: str | None, preview: str | None,
                   body_text: str | None, body_html: str | None,
                   is_read: bool, has_attachments: bool,
                   size_bytes: int | None = None, web_link: str | None = None) -> int:
    with db() as conn:
        conn.execute(
            """INSERT INTO messages
                 (account_id, folder_id, remote_id, internet_id, thread_id,
                  subject, from_name, from_addr, to_json, cc_json, bcc_json,
                  date, preview, body_text, body_html,
                  is_read, has_attachments, size_bytes, web_link)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_id, remote_id) DO UPDATE SET
                 folder_id=excluded.folder_id,
                 internet_id=COALESCE(excluded.internet_id, messages.internet_id),
                 thread_id=COALESCE(excluded.thread_id, messages.thread_id),
                 subject=excluded.subject,
                 from_name=excluded.from_name, from_addr=excluded.from_addr,
                 to_json=excluded.to_json, cc_json=excluded.cc_json, bcc_json=excluded.bcc_json,
                 date=excluded.date, preview=excluded.preview,
                 body_text=COALESCE(excluded.body_text, messages.body_text),
                 body_html=COALESCE(excluded.body_html, messages.body_html),
                 is_read=excluded.is_read,
                 has_attachments=excluded.has_attachments,
                 size_bytes=COALESCE(excluded.size_bytes, messages.size_bytes),
                 web_link=COALESCE(excluded.web_link, messages.web_link)""",
            (account_id, folder_id, remote_id, internet_id, thread_id,
             subject, from_name, from_addr,
             json.dumps(to_list or []), json.dumps(cc_list or []), json.dumps(bcc_list or []),
             date, preview, body_text, body_html,
             1 if is_read else 0, 1 if has_attachments else 0,
             size_bytes, web_link),
        )
        row = conn.execute(
            "SELECT id FROM messages WHERE account_id = ? AND remote_id = ?",
            (account_id, remote_id),
        ).fetchone()
        return row["id"]


def list_messages(folder_id: int, *, offset: int = 0, limit: int = 50) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            """SELECT id, account_id, folder_id, subject, from_name, from_addr,
                      date, preview, is_read, has_attachments, thread_id
               FROM messages
               WHERE folder_id = ?
               ORDER BY date DESC
               LIMIT ? OFFSET ?""",
            (folder_id, limit, offset),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def get_message(message_id: int, *, with_body: bool = True) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return None
        d = _row_to_dict(row)
        if not with_body:
            d.pop("body_text", None)
            d.pop("body_html", None)
        return d


def get_thread(message_id: int) -> list[dict]:
    """All messages sharing the thread_id of the given message, oldest first.
    Falls back to just the one message if no thread_id."""
    with db() as conn:
        row = conn.execute(
            "SELECT thread_id, account_id FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
        if not row or not row["thread_id"]:
            one = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
            return [_row_to_dict(one)] if one else []
        rows = conn.execute(
            """SELECT * FROM messages
               WHERE account_id = ? AND thread_id = ?
               ORDER BY date ASC""",
            (row["account_id"], row["thread_id"]),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def mark_read(message_id: int, is_read: bool = True) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE messages SET is_read = ? WHERE id = ?",
            (1 if is_read else 0, message_id),
        )


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    # Parse JSON columns
    for k in ("config", "to_json", "cc_json", "bcc_json"):
        if k in d and d[k]:
            try:
                d[k.removesuffix("_json") if k.endswith("_json") else k] = json.loads(d[k])
            except Exception:
                pass
    return d


if __name__ == "__main__":
    init_db()
    ensure_default_accounts()
    print(f"DB ready at {DB_PATH}")
    print(f"Accounts: {[a['slug'] for a in list_accounts()]}")
