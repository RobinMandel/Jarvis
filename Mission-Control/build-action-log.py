"""Baut aus Mission-Control/data/actions.jsonl ein menschenlesbares
Markdown-Protokoll im Obsidian Vault.

Gruppiert nach Tag + Raum. Zeigt jede Aktion mit Status, Dauer und Ergebnis.
Dient als Nachvollziehbarkeits-Layer fuer die Bot-Orchestrierung.

Aufruf:  python build-action-log.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = Path(__file__).resolve().parent
ACTIONS_FILE = ROOT / "data" / "actions.jsonl"
OUT_DIR = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory/Action-Log")
INDEX_FILE = OUT_DIR / "README.md"


def load_events() -> list[dict]:
    if not ACTIONS_FILE.exists():
        return []
    events: list[dict] = []
    for line in ACTIONS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def build_actions(events: list[dict]) -> dict[str, list[dict]]:
    """Aggregiert queued -> running -> done zu einer Aktion pro (room_id, approval_id, action_idx)."""
    by_key: dict[tuple, dict] = {}
    for ev in events:
        key = (ev.get("room_id"), ev.get("approval_id"), ev.get("action_idx"))
        entry = by_key.setdefault(
            key,
            {
                "room_id": ev.get("room_id"),
                "approval_id": ev.get("approval_id"),
                "action_idx": ev.get("action_idx"),
                "action": ev.get("action", ""),
                "topic": ev.get("topic", ""),
                "status": "queued",
                "result": "",
                "ts_queued": None,
                "ts_running": None,
                "ts_done": None,
            },
        )
        event_type = ev.get("event", "")
        ts = ev.get("ts")
        if event_type == "action.queued":
            entry["ts_queued"] = ts
            if ev.get("topic"):
                entry["topic"] = ev["topic"]
        elif event_type == "action.running":
            entry["ts_running"] = ts
            entry["status"] = "running"
        elif event_type == "action.done":
            entry["ts_done"] = ts
            entry["status"] = ev.get("status", "done")
            entry["result"] = ev.get("result", "")
        if ev.get("action"):
            entry["action"] = ev["action"]

    by_day: dict[str, list[dict]] = defaultdict(list)
    for entry in by_key.values():
        primary_ts = entry["ts_done"] or entry["ts_running"] or entry["ts_queued"]
        if not primary_ts:
            continue
        day = primary_ts[:10]
        entry["_sort_ts"] = primary_ts
        by_day[day].append(entry)
    for day in by_day:
        by_day[day].sort(key=lambda e: e["_sort_ts"])
    return by_day


def fmt_duration(start: str | None, end: str | None) -> str:
    if not start or not end:
        return ""
    try:
        d = datetime.fromisoformat(end) - datetime.fromisoformat(start)
        secs = int(d.total_seconds())
        if secs < 60:
            return f"{secs}s"
        return f"{secs // 60}m {secs % 60}s"
    except ValueError:
        return ""


STATUS_EMOJI = {
    "done": "OK",
    "error": "ERR",
    "running": "RUN",
    "queued": "WAIT",
}


def render_day(day: str, entries: list[dict]) -> str:
    lines = [f"# Action-Log {day}", ""]
    topic_seen: dict[str, str] = {}
    rooms: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        rooms[e["room_id"] or "?"].append(e)
        if e.get("topic") and e["room_id"] not in topic_seen:
            topic_seen[e["room_id"]] = e["topic"]

    lines.append(f"_Generiert {datetime.now().isoformat(timespec='seconds')}_  ")
    lines.append(f"_Aktionen gesamt: {len(entries)} | Raeume: {len(rooms)}_")
    lines.append("")

    for room_id, room_entries in rooms.items():
        topic = topic_seen.get(room_id, "")
        short_room = (room_id or "?")[:8]
        topic_short = (topic[:140] + "...") if len(topic) > 140 else topic
        lines.append(f"## Raum {short_room}")
        if topic_short:
            lines.append(f"> {topic_short}")
        lines.append("")
        for e in room_entries:
            status = e["status"]
            badge = STATUS_EMOJI.get(status, status)
            dur = fmt_duration(e["ts_running"], e["ts_done"])
            time_part = (e.get("_sort_ts") or "")[11:19]
            suffix = f" ({dur})" if dur else ""
            lines.append(f"### [{badge}] {time_part}{suffix} — {e['action']}")
            if e.get("result"):
                result = e["result"].replace("\r", "").strip()
                lines.append("")
                lines.append(result)
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_index(days: list[str], counts: dict[str, int]) -> str:
    lines = ["# Action-Log Index", ""]
    lines.append("Protokoll aller Aktionen aus der Bot-Orchestrierung (Mission Control).")
    lines.append(f"Quelle: `{ACTIONS_FILE}`")
    lines.append("")
    lines.append("| Tag | Aktionen | Datei |")
    lines.append("|---|---|---|")
    for day in sorted(days, reverse=True):
        lines.append(f"| {day} | {counts[day]} | [[{day}]] |")
    lines.append("")
    lines.append(f"_Letztes Update: {datetime.now().isoformat(timespec='seconds')}_")
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    events = load_events()
    by_day = build_actions(events)
    if not by_day:
        print("Keine Aktionen gefunden.")
        return
    counts = {day: len(entries) for day, entries in by_day.items()}
    for day, entries in by_day.items():
        (OUT_DIR / f"{day}.md").write_text(render_day(day, entries), encoding="utf-8")
    INDEX_FILE.write_text(render_index(list(by_day.keys()), counts), encoding="utf-8")
    total = sum(counts.values())
    print(f"OK: {len(by_day)} Tage, {total} Aktionen -> {OUT_DIR}")


if __name__ == "__main__":
    main()
