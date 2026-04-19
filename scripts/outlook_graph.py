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
    "Mail.Read",
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
    client_id = os.getenv("MS_CLIENT_ID")
    if not client_id:
        print("ERROR: MS_CLIENT_ID fehlt. Bitte in der Shell setzen.")
        sys.exit(2)

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

    s = sub.add_parser("calendar", help="Kalenderauszug")
    s.add_argument("--hours", type=int, default=48)
    s.add_argument("--top", type=int, default=20)
    s.set_defaults(func=cmd_calendar)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
