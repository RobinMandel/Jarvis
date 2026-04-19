"""Push notifications via ntfy.sh.

Usage:
    from notify import send_push
    send_push("Jarvis", "Test 🚀", priority=4, tags=["rocket"])

CLI:
    python notify.py "Titel" "Nachricht"

Safe to call from any sync context; never raises. Returns True/False.
"""
import json
import urllib.request
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent / "config.json"


def _load_config():
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def send_push(title, message, *, priority=3, tags=None, click=None, timeout=10):
    """Send a push via ntfy.sh.

    priority: 1=min, 3=default, 4=high, 5=urgent
    tags: list of ntfy tags (emoji shortcodes like 'rocket', 'warning')
    click: URL opened when the notification is tapped
    """
    cfg = _load_config()
    topic = cfg.get("ntfy_topic")
    if not topic:
        print("[notify] No ntfy_topic in config.json")
        return False
    server = cfg.get("ntfy_server", "https://ntfy.sh").rstrip("/")
    payload = {
        "topic": topic,
        "title": title,
        "message": message,
        "priority": int(priority),
    }
    if tags:
        payload["tags"] = list(tags) if isinstance(tags, (list, tuple)) else [str(tags)]
    if click:
        payload["click"] = click
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            server,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception as e:
        print(f"[notify] push failed: {e}")
        return False


if __name__ == "__main__":
    import sys
    title = sys.argv[1] if len(sys.argv) > 1 else "Jarvis Mission Control"
    msg = sys.argv[2] if len(sys.argv) > 2 else "Test-Push vom MC ✅"
    ok = send_push(title, msg, priority=4, tags=["white_check_mark"])
    print(f"sent: {ok}")
