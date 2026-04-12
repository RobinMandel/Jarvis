# Anki — Workflow & Style Guide

> Verbindlich fuer alle Jarvis-erstellten Anki-Karten.

---

## Setup

- **AnkiConnect:** `http://localhost:8765` (Plugin muss laufen)
- **Gesamt:** 10.000+ Karten (`1 VORKLINIK` + `2 KLINIK`)
- **Jarvis-Decks:** `2 KLINIK::8. Semester (Block)::Jarvis::OSCE::{Fach}::Prio`

---

## OSCE-Karten Stand (nach Pruefung 08.04.2026)

| Fach | Karten |
|---|---|
| Chirurgie | ~316 |
| Innere | ~175 |
| HNO | ~101 |
| Augenheilkunde | ~99 |
| Psychiatrie | ~39 |
| Anaesthesie | ~33 |
| Urologie | ~27 |
| **Gesamt** | **~2979** |

---

## Karten-Typen

### 1. Cloze (Standard)
- `{{c1::Antwort}}` Lueckentext
- Fach-Badge oben links
- Extra-Box fuer Zusatzinfo
- Amboss-Box fuer Querverweis

### 2. AllInOne MC
- Multiple Choice mit Erklaerung
- Fuer Differentialdiagnosen, Zuordnungen

### 3. Blickdiagnose
- Bild + Frage
- Fuer Radiologie, Derma, Patho

---

## Design-Regeln

- **Dark Theme:** Hintergrund #1E1E1E
- **Farbcodierung:** Rot/Gelb/Blau/Gruen/Lila je nach Relevanz
- **Custom CSS** im Cloze Note Type
- **Fach-Badge** (z.B. "CHIRURGIE") oben links
- **OSCE Timer-Bar** optional (6 min Countdown-Visualisierung)

---

## Technische Hinweise

- `scripts/anki-api.py` — Python Wrapper fuer AnkiConnect
- `scripts/fix-anki-encoding.py` — UTF-8/Latin-1 Bug Fix (lief auf 719 Karten)
- AnkiConnect gibt "duplicate" Error bei existierenden Karten (expected)
- Batch-Groesse: max 50 Karten pro Run (Sonnet reicht dafuer)

---

*Vollstaendiger Style Guide im Obsidian Vault: `Jarvis-Memory/anki-card-style-guide.md`*
