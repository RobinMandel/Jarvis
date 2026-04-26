import argparse
import json
import os
import pathlib
import sys
from datetime import datetime, timedelta, timezone

import msal
import requests

SCOPES = [
    "User.Read",
    "Mail.ReadWrite",   # includes Read; required for creating drafts (POST /me/messages)
    "Mail.Send",
    "Calendars.Read",
]

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def cache_path() -> pathlib.Path:
    name = os.getenv("MS_CACHE_FILE", ".outlook-token-cache.json")
    p = pathlib.Path(__file__).resolve().parent / name
    return p


def load_cache() -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    p = cache_path()
    if p.exists():
        cache.deserialize(p.read_text(encoding="utf-8"))
    return cache


def save_cache(cache: msal.SerializableTokenCache):
    if cache.has_state_changed:
        cache_path().write_text(cache.serialize(), encoding="utf-8")


def get_app(cache: msal.SerializableTokenCache):
    # Default client_id = Jarvis Outlook Graph App. Override via env if needed.
    client_id = os.getenv("MS_CLIENT_ID") or "59386692-536e-4afe-9ae2-0f728d617727"

    tenant = os.getenv("MS_TENANT_ID", "common")
    authority = f"https://login.microsoftonline.com/{tenant}"
    return msal.PublicClientApplication(client_id=client_id, authority=authority, token_cache=cache)


def get_token(interactive=False, force_interactive=False):
    cache = load_cache()
    app = get_app(cache)

    accounts = app.get_accounts()
    if accounts and not force_interactive:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            save_cache(cache)
            return result["access_token"]

    if not interactive:
        print("ERROR: Kein gültiges Token. Bitte zuerst mit: python scripts/outlook_graph.py login")
        sys.exit(2)

    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        print("ERROR: Device-Code Flow konnte nicht gestartet werden.")
        print(flow)
        sys.exit(2)

    print("\n=== Microsoft Login nötig ===")
    print(flow["message"])
    print("=============================\n")

    result = app.acquire_token_by_device_flow(flow)
    save_cache(cache)

    if "access_token" not in result:
        print("ERROR: Login fehlgeschlagen:")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        sys.exit(2)

    return result["access_token"]


def graph_get(path, token, params=None):
    r = requests.get(
        f"{GRAPH_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params,
        timeout=30,
    )
    if r.status_code >= 400:
        print(f"HTTP {r.status_code}: {r.text}")
        sys.exit(1)
    return r.json()


def graph_post(path, token, payload):
    r = requests.post(
        f"{GRAPH_BASE}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if r.status_code >= 400:
        print(f"HTTP {r.status_code}: {r.text}")
        sys.exit(1)
    return r.status_code


def cmd_login(args):
    _ = get_token(interactive=True, force_interactive=args.force)
    print("OK: Login + Token Cache gespeichert.")


def cmd_inbox(args):
    token = get_token(interactive=False)
    params = {
        "$top": str(args.top),
        "$select": "id,subject,from,receivedDateTime,isRead,webLink",
        "$orderby": "receivedDateTime desc",
    }
    data = graph_get("/me/messages", token, params=params)
    items = data.get("value", [])
    if not items:
        print("Keine Mails gefunden.")
        return
    for m in items:
        sender = (((m.get("from") or {}).get("emailAddress") or {}).get("address") or "?")
        dt = m.get("receivedDateTime", "")
        read = "Gelesen" if m.get("isRead") else "UNGelesen"
        subj = m.get("subject") or "(kein Betreff)"
        print(f"- [{read}] {dt} | {sender} | {subj}")
        if args.links and m.get("webLink"):
            print(f"  {m['webLink']}")


def cmd_unread(args):
    token = get_token(interactive=False)
    params = {
        "$top": str(args.top),
        "$select": "id,subject,from,receivedDateTime,webLink",
        "$filter": "isRead eq false",
        "$orderby": "receivedDateTime desc",
    }
    data = graph_get("/me/messages", token, params=params)
    items = data.get("value", [])
    if not items:
        print("Keine ungelesenen Mails.")
        return
    for m in items:
        sender = (((m.get("from") or {}).get("emailAddress") or {}).get("address") or "?")
        dt = m.get("receivedDateTime", "")
        subj = m.get("subject") or "(kein Betreff)"
        print(f"- {dt} | {sender} | {subj}")
        if args.links and m.get("webLink"):
            print(f"  {m['webLink']}")


def cmd_send(args):
    token = get_token(interactive=False)
    if not args.to:
        print("ERROR: --to ist Pflicht")
        sys.exit(2)

    content = args.body
    if args.body_file:
        content = pathlib.Path(args.body_file).read_text(encoding="utf-8")

    payload = {
        "message": {
            "subject": args.subject or "(kein Betreff)",
            "body": {"contentType": "Text", "content": content or ""},
            "toRecipients": [
                {"emailAddress": {"address": a.strip()}}
                for a in args.to.split(",")
                if a.strip()
            ],
        },
        "saveToSentItems": True,
    }
    code = graph_post("/me/sendMail", token, payload)
    print(f"OK: Mail gesendet (HTTP {code}).")


def _folder_kind(name: str, well_known: str | None) -> str:
    """Classify a folder by well-known id or localized display name."""
    if well_known:
        return well_known  # 'inbox', 'sentitems', ...
    n = (name or "").strip().lower()
    if n in ("inbox", "posteingang"): return "inbox"
    if n in ("sent items", "sent", "gesendete elemente", "gesendet"): return "sent"
    if n in ("drafts", "entw\u00fcrfe", "entwuerfe"): return "drafts"
    if n in ("deleted items", "deleted", "gel\u00f6schte elemente", "papierkorb"): return "trash"
    if n in ("archive", "archiv"): return "archive"
    if n in ("junk email", "junk", "spam"): return "spam"
    return "custom"


def cmd_folders(args):
    """List all mail folders (flat, with parentFolderId). JSON output."""
    token = get_token(interactive=False)
    # Fetch top-level folders first, then recurse into childFolders.
    well_known_map = {
        "inbox": "inbox", "sentitems": "sent", "drafts": "drafts",
        "deleteditems": "trash", "archive": "archive", "junkemail": "spam",
    }
    all_folders: list[dict] = []
    # Map remote_id -> display path so children can build their full path.
    path_by_id: dict[str, str] = {}

    def fetch(path_prefix: str, url: str, parent_id: str | None):
        # Note: 'wellKnownName' would be ideal to detect Inbox/Sent/... reliably
        # across locales, but not all tenants expose it. Fall back to name-based
        # classification via _folder_kind().
        params = {"$top": "100", "$select": "id,displayName,parentFolderId,totalItemCount,unreadItemCount"}
        data = graph_get(url, token, params=params)
        for f in data.get("value", []):
            disp = f.get("displayName") or "(ohne Name)"
            full_path = f"{path_prefix}/{disp}" if path_prefix else disp
            rid = f.get("id")
            path_by_id[rid] = full_path
            all_folders.append({
                "remote_id": rid,
                "parent_remote": parent_id,
                "path": full_path,
                "display_name": disp,
                "kind": _folder_kind(disp, None),
                "total_count": f.get("totalItemCount") or 0,
                "unread_count": f.get("unreadItemCount") or 0,
            })
            # Recurse into childFolders
            fetch(full_path, f"/me/mailFolders/{rid}/childFolders", rid)

    fetch("", "/me/mailFolders", None)
    print(json.dumps(all_folders, ensure_ascii=False))


def cmd_messages(args):
    """List messages in a folder. JSON output with optional body."""
    token = get_token(interactive=False)
    folder = args.folder  # remote_id of folder
    top = args.top
    select = ("id,conversationId,internetMessageId,subject,from,toRecipients,"
              "ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,"
              "hasAttachments,bodyPreview,webLink")
    if args.with_body:
        select += ",body"
    params = {
        "$top": str(top),
        "$select": select,
        "$orderby": "receivedDateTime desc",
    }
    if args.since:
        params["$filter"] = f"receivedDateTime ge {args.since}"

    if folder:
        url = f"/me/mailFolders/{folder}/messages"
    else:
        url = "/me/messages"

    out: list[dict] = []
    next_url = None
    first = True
    skip = 0
    while True:
        if first:
            data = graph_get(url, token, params=params)
            first = False
        else:
            # For simplicity just use $skip until $top is exhausted
            if len(out) >= top:
                break
            params_page = dict(params)
            params_page["$skip"] = str(skip)
            data = graph_get(url, token, params=params_page)
        for m in data.get("value", []):
            from_ea = ((m.get("from") or {}).get("emailAddress") or {})
            body = m.get("body") or {}
            out.append({
                "remote_id": m.get("id"),
                "internet_id": m.get("internetMessageId"),
                "thread_id": m.get("conversationId"),
                "subject": m.get("subject"),
                "from_name": from_ea.get("name"),
                "from_addr": from_ea.get("address"),
                "to_list": [
                    {"name": ((r.get("emailAddress") or {}).get("name")),
                     "addr": ((r.get("emailAddress") or {}).get("address"))}
                    for r in (m.get("toRecipients") or [])
                ],
                "cc_list": [
                    {"name": ((r.get("emailAddress") or {}).get("name")),
                     "addr": ((r.get("emailAddress") or {}).get("address"))}
                    for r in (m.get("ccRecipients") or [])
                ],
                "date": m.get("receivedDateTime") or m.get("sentDateTime"),
                "preview": m.get("bodyPreview"),
                "body_text": body.get("content") if (body.get("contentType") or "").lower() == "text" else None,
                "body_html": body.get("content") if (body.get("contentType") or "").lower() == "html" else None,
                "is_read": bool(m.get("isRead")),
                "has_attachments": bool(m.get("hasAttachments")),
                "web_link": m.get("webLink"),
            })
            if len(out) >= top:
                break
        if len(out) >= top:
            break
        if not data.get("@odata.nextLink"):
            break
        skip += len(data.get("value", []))
        if skip == 0:
            break
    print(json.dumps(out, ensure_ascii=False))


def cmd_create_draft(args):
    """Create a draft in the signed-in user's Outlook.com mailbox.

    Prints JSON: {"id": "...", "webLink": "..."} — the webLink opens the draft
    in Outlook Web (or New Outlook / classic Outlook — same mailbox, same draft).
    """
    token = get_token(interactive=False)

    body_content = args.body or ""
    if args.body_file:
        body_content = pathlib.Path(args.body_file).read_text(encoding="utf-8")

    # Wrap plain text as HTML so Outlook renders newlines and supports a readable font
    html_body = (
        body_content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\n", "<br>")
    )
    html_body = f'<div style="font-family:Calibri,Segoe UI,sans-serif;font-size:11pt">{html_body}</div>'

    payload = {
        "subject": args.subject or "",
        "body": {"contentType": "HTML", "content": html_body},
        "toRecipients": [
            {"emailAddress": {"address": a.strip()}}
            for a in (args.to or "").split(",")
            if a.strip()
        ],
    }
    if args.cc:
        payload["ccRecipients"] = [
            {"emailAddress": {"address": a.strip()}}
            for a in args.cc.split(",")
            if a.strip()
        ]

    r = requests.post(
        f"{GRAPH_BASE}/me/messages",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if r.status_code >= 400:
        print(f"HTTP {r.status_code}: {r.text}", file=sys.stderr)
        sys.exit(1)
    data = r.json()
    print(json.dumps({"id": data.get("id"), "webLink": data.get("webLink")}, ensure_ascii=False))


def cmd_calendar(args):
    token = get_token(interactive=False)
    now = datetime.now(timezone.utc)
    end = now + timedelta(hours=args.hours)
    params = {
        "startDateTime": now.isoformat(),
        "endDateTime": end.isoformat(),
        "$top": str(args.top),
        "$select": "subject,start,end,location,webLink",
        "$orderby": "start/dateTime",
    }
    data = graph_get("/me/calendarView", token, params=params)
    items = data.get("value", [])
    if not items:
        print("Keine Termine im Zeitraum.")
        return
    for e in items:
        s = (e.get("start") or {}).get("dateTime", "")
        en = (e.get("end") or {}).get("dateTime", "")
        sub = e.get("subject") or "(ohne Titel)"
        loc = ((e.get("location") or {}).get("displayName") or "-")
        print(f"- {s} -> {en} | {sub} | {loc}")


def main():
    p = argparse.ArgumentParser(description="Outlook/Graph helper")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("login", help="Microsoft Device-Code Login")
    s.add_argument("--force", action="store_true", help="Erzwingt neuen interaktiven Login")
    s.set_defaults(func=cmd_login)

    s = sub.add_parser("inbox", help="Letzte Mails")
    s.add_argument("--top", type=int, default=10)
    s.add_argument("--links", action="store_true")
    s.set_defaults(func=cmd_inbox)

    s = sub.add_parser("unread", help="Ungelesene Mails")
    s.add_argument("--top", type=int, default=20)
    s.add_argument("--links", action="store_true")
    s.set_defaults(func=cmd_unread)

    s = sub.add_parser("send", help="Mail senden")
    s.add_argument("--to", required=True, help="Komma-separierte Empfänger")
    s.add_argument("--subject", default="")
    s.add_argument("--body", default="")
    s.add_argument("--body-file", default="")
    s.set_defaults(func=cmd_send)

    s = sub.add_parser("folders", help="Alle Mail-Ordner (JSON)")
    s.set_defaults(func=cmd_folders)

    s = sub.add_parser("create-draft", help="Draft in Outlook.com anlegen (gibt webLink zurück)")
    s.add_argument("--to", required=True)
    s.add_argument("--cc", default="")
    s.add_argument("--subject", default="")
    s.add_argument("--body", default="")
    s.add_argument("--body-file", default="")
    s.set_defaults(func=cmd_create_draft)

    s = sub.add_parser("messages", help="Mails aus einem Ordner (JSON)")
    s.add_argument("--folder", default=None, help="remote_id des Ordners (leer = /me/messages)")
    s.add_argument("--top", type=int, default=100)
    s.add_argument("--since", default=None, help="ISO8601 Datum, nur Mails danach")
    s.add_argument("--with-body", action="store_true", help="Body mit einschließen")
    s.set_defaults(func=cmd_messages)

    s = sub.add_parser("calendar", help="Kalenderauszug")
    s.add_argument("--hours", type=int, default=48)
    s.add_argument("--top", type=int, default=20)
    s.set_defaults(func=cmd_calendar)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
