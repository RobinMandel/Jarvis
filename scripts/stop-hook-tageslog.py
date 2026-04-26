#!/usr/bin/env python3
"""
Stop-Hook: Reminder fuer Tageslog-Update (Auto-Brain-Write, Charta Regel 1).

Liest Stop-Hook-Payload von stdin (JSON), parst das Transcript,
prueft ob die Session substanzielle Tool-Calls hatte und ob heute
schon ins Tageslog geschrieben wurde. Wenn substanziell aber kein
Tageslog-Update -> block mit Reason.

Loop-Schutz: stop_hook_active=true -> sofort durchwinken.
Bei jeder Exception -> stillschweigend exit 0 (Hook darf Session nie killen).
"""
import json
import sys
from datetime import datetime
from pathlib import Path

VAULT_LOG_DIR = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
SUBSTANTIVE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"}
EDIT_TOOLS = {"Edit", "Write", "MultiEdit"}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("stop_hook_active"):
        sys.exit(0)

    transcript_path = payload.get("transcript_path")
    if not transcript_path or not Path(transcript_path).exists():
        sys.exit(0)

    today = datetime.now().strftime("%Y-%m-%d")
    today_log_name = f"{today}.md"
    today_log_path = VAULT_LOG_DIR / today_log_name

    has_substantive = False
    has_log_edit = False

    try:
        with open(transcript_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                msg = rec.get("message", {}) or {}
                if msg.get("role") != "assistant":
                    continue
                content = msg.get("content", [])
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") != "tool_use":
                        continue
                    name = block.get("name", "")
                    inp = block.get("input", {}) or {}
                    if name in SUBSTANTIVE_TOOLS:
                        has_substantive = True
                    if name in EDIT_TOOLS:
                        fp = str(inp.get("file_path", "")).replace("\\", "/")
                        if fp and today_log_name in fp:
                            has_log_edit = True
    except Exception:
        sys.exit(0)

    if has_substantive and not has_log_edit:
        reason = (
            "Auto-Brain-Write (Jarvis-Charta Regel 1): "
            f"Diese Session hatte substanzielle Tool-Calls, aber das heutige "
            f"Tageslog ({today_log_path}) wurde NICHT aktualisiert. "
            "Schreib jetzt Aktivitaeten/Erkenntnisse/Offene-Punkte rein, "
            "bevor du beendest. War die Session rein trivial: einfach erneut "
            "beenden — der Loop-Schutz laesst dich dann durch."
        )
        print(json.dumps({"decision": "block", "reason": reason}))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
