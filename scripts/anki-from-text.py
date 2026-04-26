#!/usr/bin/env python3
"""
anki-from-text.py — Generiert Anki-Karten aus einem Vorlesungstext per Klick.

Nutzt Claude CLI (headless) um strukturierte Cloze-Karten zu erzeugen,
und pusht sie direkt via AnkiConnect nach Anki.

Usage:
    echo "Vorlesungstext..." | python anki-from-text.py --deck "Medizin::Sem8" --title "Herzinsuffizienz"
    python anki-from-text.py --file vorlesung.txt --deck "Medizin::..."

Output: JSON mit {ok, created, deck, note_ids, errors}
"""
import sys
import os
import json
import subprocess
import argparse
import re

sys.path.insert(0, os.path.dirname(__file__))
# Importiere anki-api.py (Bindestrich -> via exec)
_anki_ns = {}
exec(open(os.path.join(os.path.dirname(__file__), 'anki-api.py')).read().split("if __name__")[0], _anki_ns)
create_deck = _anki_ns['create_deck']
add_cloze_card = _anki_ns['add_cloze_card']
add_basic_card = _anki_ns['add_basic_card']
add_notes_batch = _anki_ns['add_notes_batch']

CLAUDE_EXE = r"C:\Users\Robin\.local\bin\claude.exe"

PROMPT_TEMPLATE = """Du bist ein Medizin-Tutor fuer Robin (Sem 8, Uni Ulm). Erzeuge aus dem folgenden Vorlesungstext hochwertige Anki-Lernkarten.

REGELN:
- 5-15 Karten, je nach Textlaenge
- Bevorzuge Cloze-Deletions: {{c1::Antwort}}, {{c2::zweite Gruppe}}, usw.
- Eine Karte = ein Konzept. Keine Zettel-Karten.
- Klinisch relevant, OSCE-tauglich, praezise.
- Deutsche Fachsprache (Kreatinin, nicht creatinine).
- KEIN Markdown, KEINE Code-Fences. Nur reines JSON.

BILDER (optional pro Karte):
- Bei Karten wo ein generiertes Bild merkbar zum Verstaendnis beitraegt → Feld
  "image_prompt" hinzufuegen (englisch, ~25-60 Woerter, klare Szene).
- Gute Kandidaten: Anatomie/Topographie, Pathophysiologie-Mechanismen, Histologie,
  raeumliche Konzepte, OP-Techniken, Diagramme/Schemata.
- Schlechte Kandidaten: reine Definitionen, Zahlen/Werte, Listen, abstrakte Konzepte
  ohne visuellen Anker — bei diesen Feld weglassen oder null setzen.
- Maximal die Haelfte der Karten sollte ein Bild bekommen — Sparsamkeit.
- Image-Prompt-Stil: medizinische Illustration, klare Beschriftung, neutraler
  Hintergrund. KEIN photorealistic. Z.B. "Anatomical illustration of the human
  heart cross-section showing the four chambers with labeled vessels, clean
  textbook style, white background."

AUSGABE (genau dieses Format):
{{"cards": [
  {{"type": "cloze", "text": "Karteninhalt mit {{c1::cloze}}", "tags": ["tag1", "tag2"], "image_prompt": "Anatomical illustration of ..."}},
  {{"type": "basic", "front": "Frage", "back": "Antwort", "tags": ["tag"]}}
]}}

TITEL/KONTEXT: {title}

VORLESUNGSTEXT:
{text}

Gib NUR das JSON aus, nichts anderes."""


def call_claude(prompt: str, timeout: int = 120) -> str:
    """Ruft Claude CLI headless auf und gibt die Response zurueck."""
    try:
        result = subprocess.run(
            [CLAUDE_EXE, "-p", prompt, "--model", "claude-haiku-4-5-20251001"],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode != 0:
            raise RuntimeError(f"claude CLI exit {result.returncode}: {result.stderr[:500]}")
        return result.stdout.strip()
    except FileNotFoundError:
        raise RuntimeError(f"Claude CLI nicht gefunden unter {CLAUDE_EXE}")


def extract_json(text: str) -> dict:
    """Extrahiert JSON aus Claude-Output — auch wenn Code-Fences/Text drumrum ist."""
    # Versuche direkt
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    # Finde erstes { bis letztes }
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    return json.loads(text)


def generate(text: str, deck: str, title: str = "", extra_tags: list = None, cards_only: bool = False) -> dict:
    """cards_only=True → returnt nur die parsed cards (mit image_prompt etc.) und
    pusht NICHT direkt in Anki. Caller (z.B. MC-Server) macht dann Image-Gen +
    Bulk-Sync via existierende Routinen."""
    if not text.strip():
        return {"ok": False, "error": "Leerer Text"}

    prompt = PROMPT_TEMPLATE.format(title=title or "(ohne Titel)", text=text[:8000])
    raw = call_claude(prompt)

    try:
        parsed = extract_json(raw)
    except Exception as e:
        return {"ok": False, "error": f"JSON-Parse-Fehler: {e}", "raw": raw[:500]}

    cards = parsed.get("cards", [])
    if not cards:
        return {"ok": False, "error": "Keine Karten von Claude erhalten", "raw": raw[:500]}

    base_tags = extra_tags or []
    # Tags pro Karte normalisieren + auto-tag adden
    for c in cards:
        c["tags"] = list(set((c.get("tags") or []) + base_tags + ["auto-generated"]))

    if cards_only:
        return {"ok": True, "cards": cards, "deck": deck, "title": title}

    # Deck anlegen (idempotent)
    try:
        create_deck(deck)
    except Exception as e:
        return {"ok": False, "error": f"Deck-Fehler (Anki laeuft?): {e}"}

    # Karten zu AnkiConnect-Note-Dicts konvertieren und via Batch einfuegen.
    notes = []
    for c in cards:
        if c.get("type") == "cloze" or "{{c" in c.get("text", ""):
            notes.append({
                "deckName": deck,
                "modelName": "Cloze",
                "fields": {"Text": c.get("text", ""), "Extra": title},
                "tags": c["tags"],
            })
        else:
            notes.append({
                "deckName": deck,
                "modelName": "Basic",
                "fields": {"Front": c.get("front", ""), "Back": c.get("back", "")},
                "tags": c["tags"],
            })

    batch = add_notes_batch(notes)
    return {
        "ok": True,
        "created": batch["created"],
        "attempted": batch["attempted"],
        "deck": deck,
        "note_ids": batch["note_ids"],
        "errors": batch["errors"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deck", default="Medizin::Sem8::Auto")
    ap.add_argument("--title", default="")
    ap.add_argument("--file", default=None)
    ap.add_argument("--tags", default="")  # comma-separated
    ap.add_argument("--cards-only", action="store_true", help="Returnt nur cards JSON, kein Anki-Push (fuer MC-Image-Pass)")
    args = ap.parse_args()

    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    else:
        text = sys.stdin.read()

    tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    result = generate(text, args.deck, args.title, tags, cards_only=args.cards_only)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
