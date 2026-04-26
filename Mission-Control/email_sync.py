"""Sync accounts → SQLite cache.

- Outlook (Graph): delegates to scripts/outlook_graph.py (folders + messages JSON)
- IMAP (Uni, Gmail): uses stdlib imaplib with app password / file credentials

Usage:
    python email_sync.py                 # sync all accounts
    python email_sync.py outlook         # sync only Outlook
    python email_sync.py uni gmail       # sync Uni + Gmail
"""

from __future__ import annotations

import email
import email.policy
import imaplib
import json
import os
import re
import ssl
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime, getaddresses
from pathlib import Path

import email_db

BASE_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = Path("C:/Users/Robin/Jarvis/scripts")

OUTLOOK_MAX_MSGS_PER_FOLDER = 100
IMAP_MAX_MSGS_PER_FOLDER = 100


# ---------- Shared helpers ----------

def _preview_from_text(txt: str | None, n: int = 250) -> str | None:
    if not txt:
        return None
    t = re.sub(r"\s+", " ", txt).strip()
    return t[:n]


def _decode(s) -> str:
    if s is None:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return str(s)


# ---------- Outlook (Graph) ----------

def _run_graph(args: list[str]) -> str:
    env = {**os.environ,
           "PYTHONIOENCODING": "utf-8",
           "MS_CLIENT_ID": os.environ.get("MS_CLIENT_ID", "59386692-536e-4afe-9ae2-0f728d617727"),
           "MS_TENANT_ID": os.environ.get("MS_TENANT_ID", "common")}
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "outlook_graph.py"), *args],
        capture_output=True, text=True, env=env, timeout=120, encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"outlook_graph.py {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout


def sync_outlook(account: dict) -> None:
    print(f"[sync] outlook: folders ...")
    folders_json = _run_graph(["folders"])
    folders = json.loads(folders_json)
    folder_id_by_remote: dict[str, int] = {}
    for f in folders:
        fid = email_db.upsert_folder(
            account_id=account["id"],
            remote_id=f["remote_id"],
            parent_remote=f.get("parent_remote"),
            path=f["path"],
            display_name=f["display_name"],
            kind=f.get("kind"),
            total_count=f.get("total_count", 0),
            unread_count=f.get("unread_count", 0),
        )
        folder_id_by_remote[f["remote_id"]] = fid
    print(f"[sync] outlook: {len(folders)} folders upserted")

    # Sync messages per interesting folder. Skip trash & spam to save tokens.
    SKIP = {"trash", "spam"}
    total_msgs = 0
    for f in folders:
        if f.get("kind") in SKIP:
            continue
        remote_fid = f["remote_id"]
        local_fid = folder_id_by_remote[remote_fid]
        try:
            msgs_json = _run_graph([
                "messages", "--folder", remote_fid,
                "--top", str(OUTLOOK_MAX_MSGS_PER_FOLDER),
                "--with-body",
            ])
            msgs = json.loads(msgs_json) if msgs_json.strip() else []
        except Exception as e:
            print(f"[sync] outlook '{f['path']}' skipped: {e}")
            continue
        for m in msgs:
            body_text = m.get("body_text")
            body_html = m.get("body_html")
            preview = m.get("preview") or _preview_from_text(body_text)
            email_db.upsert_message(
                account_id=account["id"],
                folder_id=local_fid,
                remote_id=m["remote_id"],
                internet_id=m.get("internet_id"),
                thread_id=m.get("thread_id"),
                subject=m.get("subject"),
                from_name=m.get("from_name"),
                from_addr=m.get("from_addr"),
                to_list=m.get("to_list") or [],
                cc_list=m.get("cc_list") or [],
                bcc_list=[],
                date=m.get("date"),
                preview=preview,
                body_text=body_text,
                body_html=body_html,
                is_read=bool(m.get("is_read")),
                has_attachments=bool(m.get("has_attachments")),
                web_link=m.get("web_link"),
            )
        total_msgs += len(msgs)
        print(f"[sync] outlook '{f['path']}': {len(msgs)} msgs")
    print(f"[sync] outlook done: {total_msgs} messages cached")


# ---------- IMAP (Uni, Gmail) ----------

IMAP_FOLDER_KIND = {
    "inbox": "inbox",
    "posteingang": "inbox",
    "sent": "sent", "sent items": "sent", "sent mail": "sent",
    "gesendet": "sent", "[gmail]/sent mail": "sent",
    "drafts": "drafts", "entwurf": "drafts", "entwürfe": "drafts", "[gmail]/drafts": "drafts",
    "trash": "trash", "papierkorb": "trash", "[gmail]/trash": "trash",
    "spam": "spam", "junk": "spam", "[gmail]/spam": "spam",
    "archive": "archive", "archiv": "archive", "all mail": "archive",
    "[gmail]/all mail": "archive",
    "important": "custom", "[gmail]/important": "custom", "wichtig": "custom",
    "starred": "custom", "[gmail]/starred": "custom", "markiert": "custom",
}


def _imap_kind(folder_name: str) -> str:
    return IMAP_FOLDER_KIND.get(folder_name.lower(), "custom")


def _imap_decode_folder_name(raw: bytes) -> str:
    """IMAP folder names come UTF-7 (modified). Python's imaplib exposes them raw.
    We use the 'imap4-utf-7' codec registered below, or fall back to raw."""
    try:
        return raw.decode("imap4-utf-7")
    except Exception:
        try:
            return raw.decode("utf-8", errors="replace")
        except Exception:
            return str(raw)


def _imap_get_credentials(account: dict) -> tuple[str, str]:
    """Returns (user, password)."""
    cfg = account.get("config") or {}
    user = account["email"]
    if "cred_env" in cfg:
        pw = os.environ.get(cfg["cred_env"])
        if not pw:
            raise RuntimeError(f"Env var {cfg['cred_env']} not set (Gmail app password)")
        return user, pw
    if "cred_file" in cfg:
        p = Path(cfg["cred_file"])
        if not p.exists():
            raise RuntimeError(f"Cred file missing: {p}")
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("user", user), data["password"]
    raise RuntimeError("No credentials configured for IMAP account")


def _imap_list_folders(m: imaplib.IMAP4_SSL) -> list[tuple[str, list[str]]]:
    """Returns [(name, flags)]. Filters out non-select flags like \\Noselect."""
    typ, data = m.list()
    if typ != "OK":
        return []
    out: list[tuple[str, list[str]]] = []
    for row in data:
        if row is None:
            continue
        if isinstance(row, bytes):
            line = row.decode("utf-8", errors="replace")
        else:
            line = str(row)
        # Format: (\HasNoChildren) "/" "INBOX"
        match = re.match(r'\((?P<flags>[^)]*)\)\s+"(?P<sep>[^"]*)"\s+(?P<name>.+)$', line)
        if not match:
            continue
        flags = match.group("flags").split()
        name = match.group("name").strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1]
        # skip \Noselect folders
        if any(f.lower() == "\\noselect" for f in flags):
            continue
        out.append((name, flags))
    return out


def _imap_addr_list(raw: str | None) -> list[dict]:
    if not raw:
        return []
    out = []
    for name, addr in getaddresses([raw]):
        out.append({"name": _decode(name), "addr": addr})
    return out


def _imap_pick_body(msg: email.message.Message) -> tuple[str | None, str | None]:
    """Return (plain_text, html)."""
    plain, html = None, None
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = (part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            try:
                payload = part.get_content()
            except Exception:
                payload = None
            if payload is None:
                continue
            if ctype == "text/plain" and plain is None:
                plain = payload if isinstance(payload, str) else payload.decode("utf-8", errors="replace")
            elif ctype == "text/html" and html is None:
                html = payload if isinstance(payload, str) else payload.decode("utf-8", errors="replace")
    else:
        ctype = msg.get_content_type()
        try:
            payload = msg.get_content()
        except Exception:
            payload = None
        if payload is not None:
            if ctype == "text/plain":
                plain = payload if isinstance(payload, str) else payload.decode("utf-8", errors="replace")
            elif ctype == "text/html":
                html = payload if isinstance(payload, str) else payload.decode("utf-8", errors="replace")
    return plain, html


def sync_imap(account: dict) -> None:
    slug = account["slug"]
    cfg = account.get("config") or {}
    host = cfg["host"]
    port = int(cfg.get("port", 993))
    print(f"[sync] {slug}: connect {host}:{port} ...")

    user, password = _imap_get_credentials(account)
    ctx = ssl.create_default_context()
    m = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    try:
        m.login(user, password)
    except imaplib.IMAP4.error as e:
        raise RuntimeError(f"IMAP login failed for {user}: {e}")

    try:
        folders = _imap_list_folders(m)
        print(f"[sync] {slug}: {len(folders)} folders")
        total_msgs = 0
        for fname, flags in folders:
            kind = _imap_kind(fname)
            # Skip trash & spam to save time
            if kind in ("trash", "spam"):
                continue
            try:
                typ, _ = m.select(f'"{fname}"', readonly=True)
                if typ != "OK":
                    continue
            except imaplib.IMAP4.error:
                continue

            # get STATUS for counts
            try:
                typ, data = m.status(f'"{fname}"', "(MESSAGES UNSEEN)")
                total_count, unread_count = 0, 0
                if typ == "OK" and data and data[0]:
                    s = data[0].decode("utf-8", errors="replace")
                    mt = re.search(r"MESSAGES\s+(\d+)", s)
                    mu = re.search(r"UNSEEN\s+(\d+)", s)
                    if mt: total_count = int(mt.group(1))
                    if mu: unread_count = int(mu.group(1))
            except Exception:
                total_count, unread_count = 0, 0

            parent_remote = fname.rsplit("/", 1)[0] if "/" in fname else None
            local_fid = email_db.upsert_folder(
                account_id=account["id"],
                remote_id=fname,
                parent_remote=parent_remote,
                path=fname,
                display_name=fname.split("/")[-1],
                kind=kind,
                total_count=total_count,
                unread_count=unread_count,
            )

            # Fetch last N message UIDs
            typ, data = m.uid("SEARCH", None, "ALL")
            if typ != "OK" or not data or not data[0]:
                continue
            uids = data[0].split()
            uids = uids[-IMAP_MAX_MSGS_PER_FOLDER:]  # newest N
            if not uids:
                continue

            # Fetch in one batch: flags + full message
            uid_set = b",".join(uids).decode()
            typ, data = m.uid("FETCH", uid_set, "(FLAGS RFC822 RFC822.SIZE)")
            if typ != "OK" or not data:
                continue

            # parse response: list of tuples (metadata_bytes, full_msg_bytes), interspersed with b')' tokens
            i = 0
            folder_msgs = 0
            while i < len(data):
                item = data[i]
                if not isinstance(item, tuple) or len(item) < 2:
                    i += 1
                    continue
                meta_bytes, raw_bytes = item[0], item[1]
                i += 1
                meta = meta_bytes.decode("utf-8", errors="replace") if isinstance(meta_bytes, bytes) else str(meta_bytes)
                uid_m = re.search(r"UID\s+(\d+)", meta)
                flags_m = re.search(r"FLAGS\s+\(([^)]*)\)", meta)
                size_m = re.search(r"RFC822\.SIZE\s+(\d+)", meta)
                if not uid_m:
                    continue
                uid = uid_m.group(1)
                is_read = "\\Seen" in (flags_m.group(1) if flags_m else "")
                size_bytes = int(size_m.group(1)) if size_m else None
                try:
                    msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)
                except Exception:
                    continue

                subject = _decode(msg.get("Subject"))
                from_name, from_addr = parseaddr(msg.get("From") or "")
                to_list = _imap_addr_list(msg.get("To"))
                cc_list = _imap_addr_list(msg.get("Cc"))
                bcc_list = _imap_addr_list(msg.get("Bcc"))
                internet_id = (msg.get("Message-ID") or "").strip()
                # IMAP threading: prefer References / In-Reply-To root
                refs = (msg.get("References") or "").strip()
                thread_id = (refs.split()[0] if refs else internet_id) or None

                date_iso = None
                raw_date = msg.get("Date")
                if raw_date:
                    try:
                        dt = parsedate_to_datetime(raw_date)
                        if dt and dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        date_iso = dt.astimezone(timezone.utc).isoformat() if dt else None
                    except Exception:
                        pass

                body_text, body_html = _imap_pick_body(msg)
                preview = _preview_from_text(body_text) or _preview_from_text(
                    re.sub(r"<[^>]+>", " ", body_html or "")
                )

                has_attachments = any(
                    ("attachment" in (p.get("Content-Disposition") or "").lower())
                    for p in (msg.walk() if msg.is_multipart() else [])
                )

                email_db.upsert_message(
                    account_id=account["id"],
                    folder_id=local_fid,
                    # IMAP UIDs are unique per mailbox, not per account — prefix
                    # with folder name so the (account_id, remote_id) UNIQUE
                    # constraint distinguishes copies of the same UID in
                    # different folders (common in Gmail label model).
                    remote_id=f"{fname}:{uid}",
                    internet_id=_decode(internet_id) or None,
                    thread_id=_decode(thread_id) or None,
                    subject=subject,
                    from_name=_decode(from_name) or None,
                    from_addr=from_addr or None,
                    to_list=to_list,
                    cc_list=cc_list,
                    bcc_list=bcc_list,
                    date=date_iso,
                    preview=preview,
                    body_text=body_text,
                    body_html=body_html,
                    is_read=is_read,
                    has_attachments=has_attachments,
                    size_bytes=size_bytes,
                )
                folder_msgs += 1
            total_msgs += folder_msgs
            print(f"[sync] {slug} '{fname}': {folder_msgs} msgs (total {total_count}, unread {unread_count})")

        print(f"[sync] {slug} done: {total_msgs} messages cached")
    finally:
        try:
            m.logout()
        except Exception:
            pass


# ---------- Orchestrator ----------

def sync_account(slug: str) -> tuple[bool, str]:
    account = email_db.get_account(slug)
    if not account:
        return False, f"Unknown account '{slug}'"
    try:
        if account["kind"] == "graph":
            sync_outlook(account)
        elif account["kind"] == "imap":
            sync_imap(account)
        else:
            return False, f"Unknown account kind '{account['kind']}'"
        email_db.set_account_sync_result(account["id"], error=None)
        return True, "ok"
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[sync] {slug} FAILED: {e}\n{tb}", file=sys.stderr)
        email_db.set_account_sync_result(account["id"], error=str(e))
        return False, str(e)


def main():
    email_db.init_db()
    email_db.ensure_default_accounts()
    slugs = sys.argv[1:] or [a["slug"] for a in email_db.list_accounts()]
    results = {}
    for slug in slugs:
        print(f"\n=== {slug} ===")
        ok, msg = sync_account(slug)
        results[slug] = (ok, msg)
    print("\n=== Summary ===")
    for slug, (ok, msg) in results.items():
        print(f"  {slug:8s}: {'OK' if ok else 'FAIL'} — {msg}")


if __name__ == "__main__":
    main()
