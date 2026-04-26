"""HTTP handlers for the new Email panel (v2).

Uses the local SQLite cache (email_db.py). All heavy sync work lives in
email_sync.py and is invoked from api_email_sync(). The read endpoints
never talk to Graph/IMAP directly — they serve from cache, so the panel
stays fast even when the network is slow or offline.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from aiohttp import web

import email_db

BASE_DIR = Path(__file__).resolve().parent
SYNC_SCRIPT = BASE_DIR / "email_sync.py"

# Protect sync runs from overlapping: one full sync at a time.
_sync_lock = asyncio.Lock()
_sync_running: dict[str, bool] = {}


def _build_folder_tree(folders: list[dict]) -> list[dict]:
    """Turn flat folder list (with parent_remote) into a nested tree."""
    by_remote: dict[str, dict] = {}
    for f in folders:
        f = dict(f)
        f["children"] = []
        by_remote[f["remote_id"]] = f
    roots: list[dict] = []
    for f in by_remote.values():
        pr = f.get("parent_remote")
        if pr and pr in by_remote:
            by_remote[pr]["children"].append(f)
        else:
            roots.append(f)
    # Sort children by kind priority then path
    kind_order = {"inbox": 0, "sent": 1, "drafts": 2, "archive": 3, "custom": 4, "spam": 5, "trash": 6}
    def sort_key(x):
        return (kind_order.get(x.get("kind"), 9), (x.get("display_name") or "").lower())
    def recurse(nodes):
        nodes.sort(key=sort_key)
        for n in nodes:
            recurse(n["children"])
    recurse(roots)
    return roots


async def api_email_accounts(request: web.Request) -> web.Response:
    """GET /api/email/v2/accounts — accounts + their folder tree."""
    email_db.init_db()
    email_db.ensure_default_accounts()
    accounts = email_db.list_accounts()
    out = []
    for a in accounts:
        folders = email_db.list_folders(a["id"])
        tree = _build_folder_tree(folders)
        out.append({
            "id": a["id"],
            "slug": a["slug"],
            "kind": a["kind"],
            "email": a["email"],
            "display_name": a["display_name"],
            "color": a["color"],
            "last_sync_at": a.get("last_sync_at"),
            "last_error": a.get("last_error"),
            "sync_running": _sync_running.get(a["slug"], False),
            "folder_count": len(folders),
            "folders": tree,
        })
    return web.json_response({"accounts": out})


async def api_email_messages(request: web.Request) -> web.Response:
    """GET /api/email/v2/folders/{folder_id}/messages?offset=0&limit=50"""
    try:
        folder_id = int(request.match_info["folder_id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="folder_id required")
    offset = int(request.query.get("offset", "0"))
    limit = max(1, min(200, int(request.query.get("limit", "50"))))
    folder = email_db.get_folder(folder_id)
    if not folder:
        raise web.HTTPNotFound(reason="folder not found")
    messages = email_db.list_messages(folder_id, offset=offset, limit=limit)
    return web.json_response({"folder": folder, "messages": messages})


async def api_email_message(request: web.Request) -> web.Response:
    """GET /api/email/v2/messages/{id} — full body + metadata."""
    try:
        message_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="id required")
    msg = email_db.get_message(message_id, with_body=True)
    if not msg:
        raise web.HTTPNotFound()
    return web.json_response({"message": msg})


async def api_email_thread(request: web.Request) -> web.Response:
    """GET /api/email/v2/messages/{id}/thread — all messages in the thread, with bodies.

    Conversation view reads this once and renders all messages as collapsible
    cards, so we return bodies upfront. For extremely long threads this could
    get big; pagination can be added later if it becomes an issue.
    """
    try:
        message_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="id required")
    messages = email_db.get_thread(message_id)
    return web.json_response({"thread": messages, "target_id": message_id})


async def api_email_sync(request: web.Request) -> web.Response:
    """POST /api/email/v2/sync  → optional ?account=outlook|uni|gmail  → trigger sync.

    Returns immediately. Sync runs as a subprocess in the background. Clients
    should poll /api/email/v2/accounts to see last_sync_at update.
    """
    slug = request.query.get("account")
    all_slugs = [a["slug"] for a in email_db.list_accounts()]
    if slug and slug not in all_slugs:
        raise web.HTTPBadRequest(reason=f"unknown account '{slug}'")
    slugs = [slug] if slug else all_slugs

    for s in slugs:
        _sync_running[s] = True

    async def runner():
        try:
            env = dict(os.environ)
            env.setdefault("MS_CLIENT_ID", "59386692-536e-4afe-9ae2-0f728d617727")
            env.setdefault("MS_TENANT_ID", "common")
            env["PYTHONIOENCODING"] = "utf-8"
            cmd = [sys.executable, str(SYNC_SCRIPT), *slugs]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(BASE_DIR),
                env=env,
            )
            stdout, stderr = await proc.communicate()
            print(f"[email_sync] rc={proc.returncode}")
            if stdout:
                print(stdout.decode("utf-8", errors="replace")[-2000:])
            if stderr:
                print("STDERR:", stderr.decode("utf-8", errors="replace")[-2000:])
        except Exception as e:
            print(f"[email_sync] runner error: {e}")
        finally:
            for s in slugs:
                _sync_running[s] = False

    asyncio.ensure_future(runner())
    return web.json_response({"ok": True, "accounts": slugs, "started_at": datetime.utcnow().isoformat() + "Z"})


async def api_email_suggest_reply(request: web.Request) -> web.Response:
    """POST /api/email/v2/messages/{id}/suggest-reply
    body: {"user_prompt": "freundlich, knapp bestaetigen", "history": [...]}
    """
    try:
        message_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="id required")
    try:
        body = await request.json()
    except Exception:
        body = {}
    user_prompt = (body.get("user_prompt") or "").strip()
    if not user_prompt:
        user_prompt = "Hilf mir mit einer passenden Antwort auf diese Mail."
    history = body.get("history") or []
    import email_reply
    result = await email_reply.suggest_replies(message_id, user_prompt, history)
    return web.json_response(result)


async def api_email_create_web_draft(request: web.Request) -> web.Response:
    """POST /api/email/v2/messages/{id}/create-web-draft
    body: {to, cc, subject, body}
    Creates a draft via Graph API (server-side). Returns web_link for the user
    to open in any Outlook client. Works even with 'new Outlook'.
    """
    try:
        message_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="id required")
    try:
        body = await request.json()
    except Exception:
        body = {}

    import email_reply
    defaults = email_reply.build_reply_defaults(message_id)
    to = body.get("to") or defaults.get("to") or []
    cc = body.get("cc") or defaults.get("cc") or []
    subject = body.get("subject") or defaults.get("subject") or ""
    text_body = body.get("body") or ""

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: email_reply.create_graph_draft(
            to=to, cc=cc, subject=subject, body=text_body,
        ),
    )
    return web.json_response(result)


async def api_email_open_draft(request: web.Request) -> web.Response:
    """POST /api/email/v2/messages/{id}/open-draft
    body: {"to": [...], "cc": [...], "subject": "...", "body": "..."}
    Opens the draft in Outlook Desktop (COM). Account is auto-picked from the
    source message's account (slug) if possible.
    """
    try:
        message_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="id required")
    try:
        body = await request.json()
    except Exception:
        body = {}

    src = email_db.get_message(message_id, with_body=True)
    account = None
    if src:
        account = email_db.get_account_by_id(src["account_id"]) if hasattr(email_db, "get_account_by_id") else None
        if account is None:
            for a in email_db.list_accounts():
                if a["id"] == src["account_id"]:
                    account = a
                    break

    import email_reply
    defaults = email_reply.build_reply_defaults(message_id)
    to = body.get("to") or defaults.get("to") or []
    cc = body.get("cc") or defaults.get("cc") or []
    subject = body.get("subject") or defaults.get("subject") or ""
    text_body = body.get("body") or ""
    attachments = body.get("attachments") or []  # list of absolute paths
    account_email = (account or {}).get("email")

    # COM call is synchronous + uses desktop session. Run in default executor to
    # avoid blocking the event loop for the few hundred ms it takes.
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: email_reply.open_draft_in_outlook(
            to=to, cc=cc, subject=subject, body=text_body,
            reply_to_internet_id=(src or {}).get("internet_id"),
            account_email=account_email,
            attachments=attachments,
            original_msg=src,
        ),
    )
    return web.json_response(result)


async def api_email_upload_attachment(request: web.Request) -> web.Response:
    """POST /api/email/v2/attachments  (multipart) — stores one or more files to
    a temp dir and returns their paths so the open-draft endpoint can attach them
    via COM. Files live under data/email_attachments/ and are cleaned up when
    the server restarts or after 24h (future)."""
    reader = await request.multipart()
    attach_dir = BASE_DIR / "data" / "email_attachments"
    attach_dir.mkdir(parents=True, exist_ok=True)
    # Use a per-request subfolder so files with the same name don't collide
    import uuid, shutil
    sub = attach_dir / uuid.uuid4().hex[:12]
    sub.mkdir(parents=True, exist_ok=True)
    saved: list[dict] = []
    try:
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name != "file":
                continue
            filename = field.filename or f"attachment-{len(saved)+1}"
            # Sanitize filename: keep base name only, strip paths
            safe_name = Path(filename).name
            out_path = sub / safe_name
            total = 0
            with open(out_path, "wb") as f:
                while True:
                    chunk = await field.read_chunk(size=65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
                    if total > 50 * 1024 * 1024:  # hard cap 50MB per file
                        raise web.HTTPRequestEntityTooLarge(
                            max_size=50 * 1024 * 1024, actual_size=total,
                            reason="Datei größer als 50 MB")
            saved.append({
                "path": str(out_path.resolve()),
                "filename": safe_name,
                "size": total,
            })
    except web.HTTPException:
        shutil.rmtree(sub, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(sub, ignore_errors=True)
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    return web.json_response({"ok": True, "attachments": saved})


async def api_email_mark_read(request: web.Request) -> web.Response:
    """POST /api/email/v2/messages/{id}/read  body: {"is_read": true|false}"""
    try:
        message_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(reason="id required")
    try:
        body = await request.json()
    except Exception:
        body = {}
    is_read = bool(body.get("is_read", True))
    email_db.mark_read(message_id, is_read=is_read)
    # TODO phase 2: also push the read state back to Graph/IMAP. For now local only.
    return web.json_response({"ok": True, "id": message_id, "is_read": is_read})


def register_routes(app: web.Application) -> None:
    """Call from server.py's create_app(): register the v2 email routes."""
    email_db.init_db()
    email_db.ensure_default_accounts()
    app.router.add_get("/api/email/v2/accounts", api_email_accounts)
    app.router.add_get("/api/email/v2/folders/{folder_id}/messages", api_email_messages)
    app.router.add_get("/api/email/v2/messages/{id}", api_email_message)
    app.router.add_get("/api/email/v2/messages/{id}/thread", api_email_thread)
    app.router.add_post("/api/email/v2/messages/{id}/read", api_email_mark_read)
    app.router.add_post("/api/email/v2/messages/{id}/suggest-reply", api_email_suggest_reply)
    app.router.add_post("/api/email/v2/messages/{id}/open-draft", api_email_open_draft)
    app.router.add_post("/api/email/v2/messages/{id}/create-web-draft", api_email_create_web_draft)
    app.router.add_post("/api/email/v2/sync", api_email_sync)
    app.router.add_post("/api/email/v2/attachments", api_email_upload_attachment)
