"""Reply-Chat helpers for the Email v2 panel (Phase 2).

Two jobs:
  1. suggest_replies()  - ask Claude for 1-3 draft answers given the thread + user prompt
  2. open_draft_in_outlook() - create a real MailItem via pywin32 COM and .Display() it
     so Robin can attach files and hit Send himself.

The COM call is invoked from the MC server process (which runs under Robin's
interactive desktop session), so it can reach the local Outlook.Application
COM server. If Outlook Desktop is not running, Dispatch() will start it.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

import email_db

CLAUDE_EXE = r"C:\Users\Robin\.local\bin\claude.exe"
DEFAULT_SUGGEST_TIMEOUT_S = 240   # allows tool use (Read/Grep/Bash/Web) to complete
# Session cwd matches the main Claude-Code session path so the CLI auto-loads
# Robin's persistent memory from ~/.claude/projects/C--WINDOWS-system32/memory/
JARVIS_CWD = r"C:\WINDOWS\system32"


# ---------- Prompt building ----------

SUGGEST_SYSTEM = (
    "Du bist Jarvis, Robins Assistent. Robin ist Medizinstudent in Ulm.\n\n"
    "Du stehst im Email-Chat von Mission Control. Robin öffnet eine Mail und schreibt dir "
    "daneben — manchmal will er einen Antwort-Entwurf, manchmal eine Rückfrage, manchmal "
    "einen Fakten-Check, manchmal eine Recherche zum Inhalt.\n\n"
    "## Zwei Antwort-Modi — entscheide selber:\n\n"
    "### MODUS A — Antwort-Entwurf erstellen\n"
    "Robin will eine konkrete Antwort auf die Mail formulieren (z.B. 'bestätige', 'sag ab', "
    "'antworte freundlich'). Dann antwortest du mit GENAU einem JSON-Block:\n"
    "```json\n"
    '{"suggestions": [{"label": "kurz_und_klar", "subject": "RE: ...", "body": "..."}]}\n'
    "```\n"
    "- 1-3 Varianten, Labels wie `kurz_und_klar`, `warm_und_freundlich`, `knapp_bestaetigend`\n"
    "- subject: 'RE: Original-Betreff'\n"
    "- body: auf Deutsch, passender Ton, keine Zitate des Originals (Outlook macht das)\n"
    "- Keine 'Sehr geehrte/r' außer die Original-Mail war formell\n\n"
    "### MODUS B — Frei chatten / helfen\n"
    "Robin stellt eine Frage, will Info, will dass du was nachschaust/recherchierst, will "
    "über was Anderes reden, will einen Fakt in der Mail verifizieren, etc. Dann antwortest "
    "du normal auf Deutsch — kurz, strukturiert, ohne JSON. Nutze dabei deine Tools frei:\n"
    "- **Read/Grep/Glob**: um Dateien auf Robins PC zu lesen (Jarvis-Repo, Notes, etc.)\n"
    "- **Bash**: für Systemfragen, Git-Status, Dateien finden\n"
    "- **WebFetch/WebSearch**: wenn aktuelle Web-Infos gebraucht werden\n"
    "- Robins **Memory** (MEMORY.md unter ~/.claude/projects/C--WINDOWS-system32/memory/) "
    "wird automatisch geladen — nutze das Wissen darüber, wer Robin ist und was er gerade macht.\n\n"
    "## Entscheidungs-Heuristik\n"
    "- 'antwort[e]', 'schreib', 'entwurf', 'reply', 'bestätig', 'sag [ab/zu]', 'formulier' → Modus A\n"
    "- 'was ist', 'wer ist', 'stimmt das', 'check[e]', 'such[e]', 'recherchiere', 'erklär[e]', "
    "allgemeine Fragen → Modus B\n"
    "- Bei Unsicherheit: Modus B (frei antworten) und am Ende anbieten, einen Entwurf zu machen.\n\n"
    "Wichtig: Nur im Modus-A-Fall den JSON-Block bringen. Im Modus B NIE ein JSON mit key "
    "'suggestions' erzeugen, sonst würde das Frontend das als Entwurf rendern."
)


def _build_thread_context(message_id: int, max_msgs: int = 10) -> tuple[str, dict]:
    """Return (context_text, target_message_dict)."""
    target = email_db.get_message(message_id, with_body=True)
    if not target:
        raise ValueError(f"Message {message_id} not found")

    thread = email_db.get_thread(message_id)
    # Limit to last N including target
    thread = thread[-max_msgs:]

    parts: list[str] = []
    for m in thread:
        who = m.get("from_name") or m.get("from_addr") or "?"
        when = (m.get("date") or "")[:19]
        subj = m.get("subject") or ""
        body = (m.get("body_text") or "").strip()
        if not body and m.get("body_html"):
            body = re.sub(r"<[^>]+>", " ", m["body_html"])
            body = re.sub(r"\s+", " ", body).strip()
        body = body[:1500]  # cap per message to keep prompt small
        parts.append(
            f"--- MAIL vom {when} ---\n"
            f"Von: {who}\nBetreff: {subj}\n\n{body}"
        )
    return "\n\n".join(parts), target


def _build_user_prompt(target: dict, thread_ctx: str, user_prompt: str,
                      chat_history: list[dict]) -> str:
    history_txt = ""
    if chat_history:
        lines = []
        for turn in chat_history[-6:]:
            role = turn.get("role", "user")
            content = turn.get("content", "")
            lines.append(f"[{role}]: {content}")
        history_txt = "Bisheriger Chat:\n" + "\n".join(lines) + "\n\n"

    return (
        f"{history_txt}"
        f"=== THREAD-KONTEXT (neueste zuletzt) ===\n{thread_ctx}\n=== ENDE ===\n\n"
        f"Antworte auf die LETZTE Mail im Thread (von {target.get('from_name') or target.get('from_addr')}).\n"
        f"Robins Vorgabe: {user_prompt}\n\n"
        f"Liefere jetzt das JSON mit 1-3 Vorschlägen."
    )


# ---------- Claude CLI ----------

def _extract_json(text: str) -> dict | None:
    """Try to parse a JSON block from Claude's answer."""
    # Try ```json ... ``` first
    m = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    # Try generic ``` ... ```
    m = re.search(r"```\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    # Try bare JSON
    m = re.search(r"(\{\s*\"suggestions\"\s*:.*\})", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    return None


async def suggest_replies(message_id: int, user_prompt: str,
                          chat_history: list[dict] | None = None,
                          timeout_s: int = DEFAULT_SUGGEST_TIMEOUT_S) -> dict:
    """Run Claude CLI to generate reply suggestions. Returns structured result."""
    chat_history = chat_history or []
    thread_ctx, target = _build_thread_context(message_id)
    user_msg = _build_user_prompt(target, thread_ctx, user_prompt, chat_history)

    full_prompt = f"{SUGGEST_SYSTEM}\n\n{user_msg}"

    proc = await asyncio.create_subprocess_exec(
        CLAUDE_EXE, "-p", full_prompt,
        "--model", "sonnet",
        "--output-format", "text",
        "--max-turns", "12",                    # up from 1: allow tool use for research/memory lookups
        "--permission-mode", "bypassPermissions",  # Jarvis gets same tool access as Claude-Code session
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        cwd=JARVIS_CWD,                         # matches main session so memory auto-loads
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "error": f"timeout after {timeout_s}s"}

    stdout = stdout_b.decode("utf-8", errors="replace").strip()
    stderr = stderr_b.decode("utf-8", errors="replace").strip()

    if proc.returncode != 0:
        return {"ok": False, "error": stderr or stdout or f"claude rc={proc.returncode}"}

    parsed = _extract_json(stdout)
    if parsed and isinstance(parsed.get("suggestions"), list):
        clean = []
        for s in parsed["suggestions"]:
            if not isinstance(s, dict):
                continue
            clean.append({
                "label": str(s.get("label") or "vorschlag"),
                "subject": str(s.get("subject") or f"RE: {target.get('subject') or ''}").strip(),
                "body": str(s.get("body") or "").strip(),
            })
        if clean:
            return {"ok": True, "type": "suggestions", "suggestions": clean, "target_id": message_id}

    # No JSON → Modus B (free chat). Return as free-text, frontend renders as bubble.
    return {
        "ok": True,
        "type": "chat",
        "text": stdout,
        "target_id": message_id,
    }


# ---------- Outlook COM: find original message ----------

# MAPI property URL schema — PidTagInternetMessageIdW (0x1035, PT_UNICODE=0x001F)
_PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F"


def _find_outlook_item_by_message_id(outlook, internet_message_id: str):
    """Locate a mail in Outlook Desktop by its Internet-Message-ID.

    Tried in two passes:
      1) Priority default folders (Inbox, Sent, Drafts) — fast
      2) Recursive walk of all stores, capped at depth 4 — thorough

    Returns the COM MailItem or None. Search is resilient — any folder access
    error is swallowed and iteration continues.
    """
    if not internet_message_id:
        return None

    mid = internet_message_id.strip().strip("<>")
    if not mid:
        return None

    def make_filter(val):
        escaped = val.replace("'", "''")
        return f'@SQL="{_PR_INTERNET_MESSAGE_ID}" = \'{escaped}\''

    candidates = [make_filter(mid), make_filter(f"<{mid}>")]

    def try_folder(folder):
        try:
            items = folder.Items
        except Exception:
            return None
        for f in candidates:
            try:
                match = items.Find(f)
                if match:
                    return match
            except Exception:
                pass
        return None

    ns = outlook.GetNamespace("MAPI")

    # 1) Priority folders
    for folder_const in (6, 5, 16):  # olFolderInbox=6, olFolderSentMail=5, olFolderDrafts=16
        try:
            f = ns.GetDefaultFolder(folder_const)
        except Exception:
            continue
        r = try_folder(f)
        if r:
            return r

    # 2) Depth-limited walk of all stores
    def walk(folder, depth=0, max_depth=4):
        r = try_folder(folder)
        if r:
            return r
        if depth >= max_depth:
            return None
        try:
            subs = folder.Folders
        except Exception:
            return None
        for i in range(subs.Count):
            try:
                sub = subs.Item(i + 1)
            except Exception:
                continue
            r = walk(sub, depth + 1, max_depth)
            if r:
                return r
        return None

    try:
        stores = ns.Stores
        for i in range(stores.Count):
            try:
                store = stores.Item(i + 1)
                root = store.GetRootFolder()
            except Exception:
                continue
            r = walk(root)
            if r:
                return r
    except Exception:
        pass

    return None


# ---------- EML fallback: write + os.startfile ----------

def _build_quoted_original_html(original: dict) -> str:
    """Format an original message as an Outlook-style quote block."""
    if not original:
        return ""
    from_name = original.get("from_name") or ""
    from_addr = original.get("from_addr") or ""
    from_line = f"{from_name} &lt;{from_addr}&gt;" if from_name and from_addr else (from_name or from_addr)
    date = original.get("date") or ""
    # try to render as German locale human string
    try:
        from datetime import datetime
        d = datetime.fromisoformat(date.replace("Z", "+00:00"))
        date_str = d.strftime("%A, %d. %B %Y %H:%M")
    except Exception:
        date_str = date
    to_list = original.get("to") or []
    to_str = ", ".join(
        (f"{x.get('name')} &lt;{x.get('addr')}&gt;" if x.get("name") and x.get("addr")
         else (x.get("name") or x.get("addr") or ""))
        for x in to_list if x
    )
    subj = (original.get("subject") or "").replace("<", "&lt;").replace(">", "&gt;")
    body_html = original.get("body_html")
    body_text = original.get("body_text")
    if body_html:
        # Keep sender's HTML but isolate it in a blockquote so our UI doesn't
        # merge styling. Strip <html>/<body> wrappers if present.
        content = re.sub(r"</?(html|body|head)[^>]*>", "", body_html, flags=re.IGNORECASE)
    else:
        # Fall back to plain text, preserve line breaks
        txt = (body_text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        content = txt.replace("\n", "<br>")
    header = (
        "<div style=\"font-family:Calibri,Segoe UI,sans-serif;font-size:11pt;"
        "border-top:1px solid #ccc;padding-top:10px;margin-top:14px\">"
        f"<p><b>Von:</b> {from_line}<br>"
        f"<b>Gesendet:</b> {date_str}<br>"
        + (f"<b>An:</b> {to_str}<br>" if to_str else "")
        + f"<b>Betreff:</b> {subj}</p>"
        "</div>"
    )
    return header + f"<blockquote style=\"margin:0 0 0 12px;padding-left:12px;border-left:2px solid #ccc\">{content}</blockquote>"


def _open_draft_via_eml(*, to: list[str], cc: list[str] | None,
                        subject: str, body: str,
                        reply_to_internet_id: str | None,
                        attachments: list[str] | None,
                        original_msg: dict | None = None,
                        from_email: str | None = None) -> dict:
    """Write a .eml file and let Windows open it with the default mail handler.

    Works regardless of COM integrity level — so this is our answer when Outlook
    is already running and refuses COM connect. Caveats:
    - Outlook typically opens the .eml in a READ window, not directly in compose.
      Robin then clicks "Antworten" in Outlook; threading headers are correct so
      the reply stays in the thread.
    - With attachments: MIME multipart/mixed. Outlook imports the attachments
      into its compose on click-Reply.

    For true Reply-semantics (quoted original + compose mode), the COM path is
    better — we try that first and only fall back here if COM failed.
    """
    import email.mime.multipart
    import email.mime.text
    import email.mime.base
    import email.encoders
    import email.policy
    from email.utils import make_msgid

    safe_to = [a for a in (to or []) if a]
    safe_cc = [a for a in (cc or []) if a]

    has_attach = bool(attachments)
    # For a real reply, we want headers + a simple HTML body. Multipart/mixed if
    # attachments, else multipart/alternative.
    if has_attach:
        root = email.mime.multipart.MIMEMultipart("mixed")
    else:
        root = email.mime.multipart.MIMEMultipart("alternative")

    # X-Unsent: 1 is the magic header that tells Outlook "this is a draft — open
    # it in COMPOSE mode with a Send button", not in the read-only inspector.
    # Without it, Outlook treats the .eml as received mail and shows the
    # useless read-pane Robin just reported.
    root["X-Unsent"] = "1"
    root["Subject"] = subject or ""
    # NOTE: We intentionally DO NOT set From here. Outlook ignores a From header
    # inside an EML when it comes to the actual Send operation — it always uses
    # the default Send account of the current profile. If From says 'uni-ulm'
    # but Send runs via the outlook.com Exchange tenant, Exchange returns
    # SendAsDenied (0x80070005). The user must manually switch the "Von" dropdown
    # in the compose window to send from a different configured account.
    _from_hint = from_email   # kept for future use (e.g. suggesting account)
    if safe_to:
        root["To"] = ", ".join(safe_to)
    if safe_cc:
        root["Cc"] = ", ".join(safe_cc)
    # Give our draft a Message-ID so Outlook doesn't generate a dummy one
    root["Message-ID"] = make_msgid(domain="jarvis.local")
    if reply_to_internet_id:
        mid = reply_to_internet_id.strip()
        if not mid.startswith("<"):
            mid = f"<{mid}"
        if not mid.endswith(">"):
            mid = f"{mid}>"
        root["In-Reply-To"] = mid
        root["References"] = mid

    safe_body = body or ""
    quoted_html = _build_quoted_original_html(original_msg) if original_msg else ""
    # Plain text version: our body, then simple dashed quote
    plain_quote = ""
    if original_msg:
        o_from = original_msg.get("from_name") or original_msg.get("from_addr") or ""
        o_date = (original_msg.get("date") or "")[:19]
        o_subj = original_msg.get("subject") or ""
        o_body = original_msg.get("body_text") or ""
        if not o_body and original_msg.get("body_html"):
            o_body = re.sub(r"<[^>]+>", " ", original_msg["body_html"])
        plain_quote = f"\n\n-----\nVon: {o_from}\nGesendet: {o_date}\nBetreff: {o_subj}\n\n" + (o_body or "").strip()
    plain_part = email.mime.text.MIMEText(safe_body + plain_quote, "plain", "utf-8")
    html_src = (
        "<div style=\"font-family:Calibri,Segoe UI,sans-serif;font-size:11pt\">"
        + safe_body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
          .replace("\n", "<br>")
        + "</div>"
        + quoted_html
    )
    html_part = email.mime.text.MIMEText(html_src, "html", "utf-8")

    if has_attach:
        alt = email.mime.multipart.MIMEMultipart("alternative")
        alt.attach(plain_part)
        alt.attach(html_part)
        root.attach(alt)
        attach_errors: list[str] = []
        for p_str in attachments or []:
            p = Path(p_str)
            if not p.exists():
                attach_errors.append(f"nicht gefunden: {p_str}")
                continue
            try:
                with open(p, "rb") as f:
                    raw = f.read()
                att = email.mime.base.MIMEBase("application", "octet-stream")
                att.set_payload(raw)
                email.encoders.encode_base64(att)
                att.add_header("Content-Disposition", "attachment", filename=p.name)
                root.attach(att)
            except Exception as e:
                attach_errors.append(f"{p.name}: {e}")
    else:
        root.attach(plain_part)
        root.attach(html_part)
        attach_errors = []

    # Write to temp .eml with a friendly filename
    safe_subj = re.sub(r"[^\w.\- ]+", "", (subject or "draft"))[:60].strip() or "draft"
    eml_dir = Path(tempfile.gettempdir()) / "jarvis-drafts"
    eml_dir.mkdir(parents=True, exist_ok=True)
    eml_path = eml_dir / f"{safe_subj}-{int(__import__('time').time())}.eml"
    eml_path.write_bytes(root.as_bytes(policy=email.policy.SMTP))

    try:
        os.startfile(str(eml_path))
    except Exception as e:
        return {"ok": False, "error": f"Konnte .eml nicht öffnen: {e}", "eml_path": str(eml_path)}

    note = "Draft in Outlook-Compose-Fenster offen — Senden drücken."
    if attach_errors:
        note += f" ⚠️ Attachment-Probleme: {'; '.join(attach_errors[:3])}"
    return {"ok": True, "via": "eml", "note": note, "eml_path": str(eml_path),
            "attach_errors": attach_errors}


# ---------- Outlook COM: open draft ----------

def open_draft_in_outlook(*, to: list[str], cc: list[str] | None,
                          subject: str, body: str,
                          reply_to_internet_id: str | None = None,
                          account_email: str | None = None,
                          attachments: list[str] | None = None,
                          original_msg: dict | None = None) -> dict:
    """Create a MailItem in Outlook Desktop and show its compose window.

    Runs synchronously - returns after Outlook has shown the window.
    Must be called from a process with desktop access (MC server under user session).
    """
    try:
        import pythoncom  # noqa: F401 — needed for COM in threads
        import win32com.client as win32
    except ImportError as e:
        return {"ok": False, "error": f"pywin32 not installed: {e}"}

    try:
        # CoInitialize for the current thread (aiohttp runs handlers on its event loop thread,
        # which may or may not have COM initialized)
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass

    try:
        # Connect to Outlook. Dispatch() is the right primary: on a running Outlook
        # it returns a reference to the existing instance; if not running, it launches
        # one. GetActiveObject is a fallback only if Dispatch trips on some edge case.
        # Most failures here are integrity-level mismatches (Outlook opened as admin
        # at some point, or MC somehow has a different integrity).
        outlook = None
        connect_err = None
        for attempt in ("dispatch", "active"):
            try:
                if attempt == "dispatch":
                    outlook = win32.Dispatch("Outlook.Application")
                else:
                    outlook = win32.GetActiveObject("Outlook.Application")
                _ = outlook.Version   # raises if connection is stale
                break
            except Exception as e:
                connect_err = e
                outlook = None
        if outlook is None:
            # COM unavailable — typically because Outlook runs at a different
            # integrity level (e.g. user opened Outlook from the Start menu and
            # Windows registered it in a session we can't see from MC).
            # Fall back to the .eml path — universally works.
            print(f"[open_draft] COM unreachable ({connect_err}) → EML fallback")
            return _open_draft_via_eml(
                to=to, cc=cc, subject=subject, body=body,
                reply_to_internet_id=reply_to_internet_id,
                attachments=attachments,
                original_msg=original_msg,
                from_email=account_email,
            )

        # Find the Outlook account matching our source-mail account (Uni, Gmail, …).
        # We'll (a) create the draft in THAT account's Drafts folder (forces Outlook
        # to treat the mail as belonging to that account) and (b) set SendUsingAccount
        # on it so Send uses that account's SMTP. Without (a), Outlook often ignores
        # SendUsingAccount and falls back to the default profile account.
        target_acc = None
        target_drafts = None
        if account_email:
            try:
                session = outlook.Session
                for i in range(session.Accounts.Count):
                    acc = session.Accounts.Item(i + 1)
                    smtp = (acc.SmtpAddress or "").lower()
                    if smtp == account_email.lower():
                        target_acc = acc
                        try:
                            store = acc.DeliveryStore
                            target_drafts = store.GetDefaultFolder(16)  # olFolderDrafts
                        except Exception as e:
                            print(f"[open_draft] no drafts folder for {smtp}: {e}")
                        print(f"[open_draft] target account found: {smtp}")
                        break
                else:
                    print(f"[open_draft] no Outlook account matches {account_email} — default account will be used")
            except Exception as e:
                print(f"[open_draft] account enumeration failed: {e}")

        # --- Try to do a PROPER reply (threaded, with quoted original) if we
        # can find the source mail in Robin's local Outlook store. Outlook's
        # .Reply() auto-fills To, prefixes "RE:", sets In-Reply-To headers and
        # quotes the original — exactly the semantics Robin expects.
        original = None
        if reply_to_internet_id:
            try:
                original = _find_outlook_item_by_message_id(outlook, reply_to_internet_id)
            except Exception as e:
                print(f"[open_draft] search by msg-id failed: {e}")

        our_html = (
            "<div style=\"font-family:Calibri,Segoe UI,sans-serif;font-size:11pt\">"
            + (body or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
              .replace("\n", "<br>")
            + "</div>"
        )

        if original is not None:
            # True reply: preserves threading, keeps the quoted original below our text.
            try:
                mail = original.Reply()
                quoted = mail.HTMLBody or ""
                mail.HTMLBody = our_html + "<br>" + quoted
                # Only override subject/to/cc if caller explicitly supplied values
                # DIFFERENT from what Reply() already filled.
                if subject and subject.strip() and subject.strip() != (mail.Subject or "").strip():
                    mail.Subject = subject
                if to and not mail.To:
                    mail.To = "; ".join(to)
                if cc:
                    mail.CC = "; ".join(cc)
            except Exception as e:
                print(f"[open_draft] Reply() on original failed, fallback to new mail: {e}")
                original = None

        if original is None:
            # Fallback: fresh MailItem. If we have a target account's Drafts folder,
            # create the item THERE (binds it to that account). Otherwise default.
            if target_drafts is not None:
                mail = target_drafts.Items.Add(0)  # olMailItem = 0
            else:
                mail = outlook.CreateItem(0)
            mail.Subject = subject or ""
            mail.To = "; ".join(to or [])
            if cc:
                mail.CC = "; ".join(cc)
            mail.Body = body or ""
            mail.HTMLBody = our_html

        # Attach files BEFORE Display so they appear in the compose window
        attach_errors: list[str] = []
        for path in (attachments or []):
            p = Path(path)
            if not p.exists():
                attach_errors.append(f"nicht gefunden: {path}")
                continue
            try:
                # olByValue=1 (copy as attachment, not link). Absolute path required.
                mail.Attachments.Add(str(p.resolve()), 1)
            except Exception as e:
                attach_errors.append(f"{p.name}: {e}")

        # Pin sending account if we found a match (target_acc). Using
        # SendUsingAccount PLUS having the item in that account's Drafts folder
        # gives Outlook two strong signals to use this account's SMTP.
        if target_acc is not None:
            try:
                mail.SendUsingAccount = target_acc
                # Save forces the account binding to be committed before Display,
                # otherwise some Outlook builds reset it on show.
                mail.Save()
                print(f"[open_draft] sending account pinned + draft saved")
            except Exception as e:
                print(f"[open_draft] account-pin save failed: {e}")

        # Display(False) = modeless so the aiohttp handler can return immediately
        mail.Display(False)

        # Bring the window to front. Outlook often opens minimized when MC spawns it.
        try:
            import win32gui, win32con
            # Find the compose window by class
            def enum(hwnd, results):
                title = win32gui.GetWindowText(hwnd)
                if title and subject and subject[:50] in title:
                    results.append(hwnd)
            hwnds: list[int] = []
            win32gui.EnumWindows(enum, hwnds)
            for h in hwnds:
                try:
                    win32gui.ShowWindow(h, win32con.SW_RESTORE)
                    win32gui.SetForegroundWindow(h)
                except Exception:
                    pass
        except Exception:
            pass

        if original is not None:
            note = "Antwort-Fenster ist offen (als echte Antwort auf den Thread, mit Zitat)."
        else:
            note = "Outlook-Compose offen (Original in Outlook nicht gefunden — als neue Mail mit RE:-Betreff)."
        if attachments:
            n = len(attachments) - len(attach_errors)
            note += f" {n} Anhang/Anhänge drangepackt."
        if attach_errors:
            note += f" ⚠️ Probleme mit: {'; '.join(attach_errors[:3])}"
        return {"ok": True, "note": note, "is_reply": original is not None, "attach_errors": attach_errors}
    except Exception as e:
        return {
            "ok": False,
            "error": f"Outlook-COM-Fehler: {e}",
            "trace": traceback.format_exc(),
        }


# ---------- Graph-based draft (works with New Outlook / Web / Classic) ----------

SCRIPTS_DIR = Path("C:/Users/Robin/Jarvis/scripts")


def create_graph_draft(*, to: list[str], cc: list[str] | None,
                       subject: str, body: str) -> dict:
    """Create a draft in the user's Outlook.com mailbox via Graph API.

    Returns {ok, web_link, draft_id} or {ok: False, error}.

    The draft lives server-side, so the returned webLink opens it in whichever
    Outlook client Robin prefers (Web, New Outlook, Classic, iPhone) — all
    clients show the same draft. Sending happens via Microsoft's servers, not
    via local SMTP, so it sidesteps the Classic-Outlook-Outbox stuck-queue
    problem entirely.
    """
    # Write body to a temp file so we don't have to worry about shell-escaping
    # newlines, quotes, unicode, etc.
    tf = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".txt", delete=False)
    try:
        tf.write(body or "")
        tf.close()

        cmd = [
            sys.executable, str(SCRIPTS_DIR / "outlook_graph.py"), "create-draft",
            "--to", ",".join(to or []),
            "--subject", subject or "",
            "--body-file", tf.name,
        ]
        if cc:
            cmd += ["--cc", ",".join(cc)]
        env = {**os.environ,
               "PYTHONIOENCODING": "utf-8",
               "MS_CLIENT_ID": os.environ.get("MS_CLIENT_ID", "59386692-536e-4afe-9ae2-0f728d617727"),
               "MS_TENANT_ID": os.environ.get("MS_TENANT_ID", "common")}
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env,
                              timeout=30, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            return {"ok": False, "error": err[:500] or "Graph draft failed"}
        try:
            data = json.loads(proc.stdout.strip())
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"Draft response not JSON: {e} / raw={proc.stdout[:200]}"}
        return {
            "ok": True,
            "web_link": data.get("webLink"),
            "draft_id": data.get("id"),
            "note": "Draft ist in deinem Outlook.com angelegt. Der Link öffnet ihn in Outlook Web — du kannst ihn auch im neuen Outlook unter 'Entwürfe' finden.",
        }
    finally:
        try:
            os.unlink(tf.name)
        except Exception:
            pass


# ---------- Helpers for building reply defaults ----------

def build_reply_defaults(message_id: int) -> dict:
    """Return {to, cc, subject, quoted_body} pre-filled from the original message."""
    msg = email_db.get_message(message_id, with_body=True)
    if not msg:
        return {"error": "Message not found"}
    to = [msg["from_addr"]] if msg.get("from_addr") else []
    cc: list[str] = []
    subj = msg.get("subject") or ""
    if not re.match(r"^\s*(re|aw)\s*:", subj, re.IGNORECASE):
        subj = f"RE: {subj}"
    return {
        "to": to,
        "cc": cc,
        "subject": subj,
        "original_date": msg.get("date"),
        "original_from": msg.get("from_name") or msg.get("from_addr"),
    }
