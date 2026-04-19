#!/usr/bin/env python3
"""
Lernplan-Generator — Spaced Repetition → iCloud Kalender

Erzeugt einen Lernplan fuer eine Vorlesung/Thema und schreibt die Termine
direkt in iCloud (via scripts/icloud-calendar.py).

Usage:
  python lernplan-generator.py \
      --topic "Kardiologie - Herzinsuffizienz" \
      --exam-date 2026-06-15 \
      --time 18:00 \
      --duration 45 \
      --subtopics "Pathophysio,Diagnostik,Therapie,Leitlinien" \
      --calendar "Kalender"

Optional: --dry-run  (zeigt Plan nur an, ohne zu schreiben)
          --start-date 2026-04-17  (default: heute)
          --json       (gibt Plan als JSON aus)

Spaced-Repetition-Abstand: 1d, 3d, 7d, 14d nach Erstlernen + Final-Review 1 Tag vor Pruefung.
"""
import sys, os, json, argparse, importlib.util
from datetime import datetime, date, timedelta, time as dtime

# Importiere icloud-calendar.py als Modul (Bindestrich im Dateinamen → spec-import)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ICAL_PATH = os.path.join(SCRIPT_DIR, "icloud-calendar.py")

def load_icloud():
    spec = importlib.util.spec_from_file_location("icloud_calendar", ICAL_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

REVIEW_OFFSETS = [1, 3, 7, 14]  # Tage nach Erstlernen

def parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()

def parse_time(s):
    h, m = s.split(":")
    return dtime(int(h), int(m))

def build_plan(topic, subtopics, start_date, exam_date, learn_time, duration_min):
    """
    Rueckgabe: Liste von Events [{date, time, duration, title, description, kind}]
    Verteilt Erstlern-Sessions pro Subtopic ueber die verfuegbaren Tage,
    fuegt 1/3/7/14-Tage-Reviews hinzu, plus Final-Review am Vortag.
    """
    today = start_date
    days_available = (exam_date - today).days
    if days_available <= 0:
        raise ValueError(f"Pruefungsdatum ({exam_date}) liegt nicht in der Zukunft.")

    topics = subtopics if subtopics else [topic]
    n = len(topics)

    # Erstlern-Termine gleichmaessig verteilen, aber mindestens 15 Tage vor Pruefung,
    # damit Reviews passen. Wenn zu wenig Zeit: so frueh wie moeglich.
    latest_first_learn = exam_date - timedelta(days=max(REVIEW_OFFSETS) + 1)
    if latest_first_learn <= today:
        latest_first_learn = exam_date - timedelta(days=1)

    span_days = (latest_first_learn - today).days
    span_days = max(span_days, 0)

    events = []
    first_learn_dates = []
    for i, st in enumerate(topics):
        # Gleichmaessige Verteilung: 0, 1/(n-1), 2/(n-1)...
        if n == 1:
            offset = 0
        else:
            offset = round(i * span_days / (n - 1))
        d = today + timedelta(days=offset)
        first_learn_dates.append(d)
        events.append({
            "date": d,
            "time": learn_time,
            "duration": duration_min,
            "title": f"📚 Lernen: {st}",
            "description": f"Erstlernen — {topic}\nSubthema: {st}\n\nZiel: Konzepte verstehen, Notizen, ggf. Anki-Karten erstellen.",
            "kind": "learn",
            "subtopic": st,
        })

    # Reviews
    for d0, st in zip(first_learn_dates, topics):
        for off in REVIEW_OFFSETS:
            r_date = d0 + timedelta(days=off)
            if r_date >= exam_date:
                continue
            events.append({
                "date": r_date,
                "time": learn_time,
                "duration": max(15, duration_min // 2),
                "title": f"🔁 Review (T+{off}): {st}",
                "description": f"Spaced-Repetition-Review — {topic}\nSubthema: {st}\nRunde: T+{off}\n\nAnki-Karten durchgehen, Zusammenfassung kurz rekonstruieren.",
                "kind": "review",
                "subtopic": st,
            })

    # Final review am Vortag
    final_date = exam_date - timedelta(days=1)
    if final_date >= today:
        events.append({
            "date": final_date,
            "time": learn_time,
            "duration": duration_min,
            "title": f"✅ Final-Review: {topic}",
            "description": f"Pruefungsvorbereitung — letzter Durchgang.\nAlle Subthemen, Schwachstellen gezielt wiederholen.",
            "kind": "final",
            "subtopic": "",
        })

    # Sortiere chronologisch
    events.sort(key=lambda e: (e["date"], e["time"]))
    return events

def format_plan(events):
    lines = []
    current = None
    for e in events:
        day = e["date"].strftime("%a %d.%m.%Y")
        if day != current:
            current = day
            lines.append(f"\n{day}")
            lines.append("-" * len(day))
        t = e["time"].strftime("%H:%M")
        lines.append(f"  {t} ({e['duration']}m) | {e['title']}")
    return "\n".join(lines)

def main():
    ap = argparse.ArgumentParser(description="Lernplan-Generator -> iCloud")
    ap.add_argument("--topic", required=True, help="Haupt-Thema, z.B. 'Kardiologie - Herzinsuffizienz'")
    ap.add_argument("--exam-date", required=True, help="Pruefungsdatum YYYY-MM-DD")
    ap.add_argument("--start-date", default=None, help="Start YYYY-MM-DD (default: heute)")
    ap.add_argument("--time", default="18:00", help="Uhrzeit der Sessions HH:MM (default 18:00)")
    ap.add_argument("--duration", type=int, default=45, help="Dauer in Min (default 45)")
    ap.add_argument("--subtopics", default="", help="Komma-separiert, z.B. 'Patho,Diagnostik,Therapie'")
    ap.add_argument("--calendar", default="Kalender", help="iCloud-Kalender-Name (default: Kalender)")
    ap.add_argument("--dry-run", action="store_true", help="Nur Plan anzeigen, nicht schreiben")
    ap.add_argument("--json", action="store_true", help="Plan + Ergebnis als JSON ausgeben")
    args = ap.parse_args()

    start_date = parse_date(args.start_date) if args.start_date else date.today()
    exam_date = parse_date(args.exam_date)
    learn_time = parse_time(args.time)
    subtopics = [s.strip() for s in args.subtopics.split(",") if s.strip()]

    try:
        events = build_plan(args.topic, subtopics, start_date, exam_date, learn_time, args.duration)
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}) if args.json else f"Fehler: {e}")
        sys.exit(2)

    if args.dry_run:
        if args.json:
            out = [{
                "date": e["date"].isoformat(),
                "time": e["time"].strftime("%H:%M"),
                "duration": e["duration"],
                "title": e["title"],
                "kind": e["kind"],
            } for e in events]
            print(json.dumps({"ok": True, "dry_run": True, "count": len(events), "events": out}, ensure_ascii=False))
        else:
            print(f"Lernplan (DRY-RUN, {len(events)} Events):")
            print(format_plan(events))
        return

    # Events in Kalender schreiben
    ical = load_icloud()
    import requests
    from requests.auth import HTTPBasicAuth
    apple_id, app_pw = ical.load_creds()
    session = requests.Session()
    session.auth = HTTPBasicAuth(apple_id, app_pw)

    created = 0
    failed = 0
    results = []
    for e in events:
        start_dt = datetime.combine(e["date"], e["time"])
        try:
            ok = ical.create_event(
                session,
                title=e["title"],
                start=start_dt,
                duration_min=e["duration"],
                calendar_name=args.calendar,
                location="",
                description=e["description"],
                all_day=False,
            )
            if ok: created += 1
            else: failed += 1
            results.append({"title": e["title"], "date": e["date"].isoformat(), "ok": bool(ok)})
        except Exception as ex:
            failed += 1
            results.append({"title": e["title"], "date": e["date"].isoformat(), "ok": False, "error": str(ex)})

    if args.json:
        print(json.dumps({
            "ok": failed == 0,
            "created": created,
            "failed": failed,
            "total": len(events),
            "calendar": args.calendar,
            "events": results,
        }, ensure_ascii=False))
    else:
        print(format_plan(events))
        print(f"\n→ {created}/{len(events)} Events angelegt in Kalender '{args.calendar}' ({failed} Fehler).")

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
