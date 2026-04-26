# ADR-0003: Anki Bulk-Sync via AnkiConnect

**Status:** Accepted (2026-04-23)

## Context

Der Karten-Generator (`api_learn_generate`) erzeugte hochwertige Anki-Karten aus
Vorlesungsmaterial + Amboss/ViaMedici-Kontext, exportierte aber nur als ZIP
(TSV + Bilder + README). Der reale Workflow:

1. ZIP herunterladen
2. ZIP entpacken
3. Alle Bilder manuell in Ankis `collection.media/`-Ordner kopieren
4. Anki öffnen
5. Datei → Importieren → .txt-Dateien auswählen

Fünf Schritte pro Karten-Batch, jeder mit Copy-Paste-Fehlerrisiko. AnkiConnect
(HTTP-Plugin auf `localhost:8765`) wurde bereits im Quick-Action-FAB für
Einzelkarten genutzt.

## Decision

Neuer Endpoint `POST /api/anki/bulk-sync` (`subject`, `deck`, `cards[]`) macht
einen **atomaren Sync**:

1. `createDeck` (idempotent) — sorgt dass Zieldeck existiert, inkl. Hierarchie
   wie `Medizin::Kardio`.
2. Für jedes Bild: `storeMediaFile` mit base64-encoded Bytes — kein manuelles
   Copy nach `collection.media/` mehr.
3. Ein einziges `addNotes`-Batch mit allen Karten, `duplicateScope: "deck"` →
   Ankis nativer Dedup greift pro Deck.
4. `canAddNotes`-Check im Nachlauf um bei `null`-Returns zwischen „Duplikat"
   und „Fehler" zu unterscheiden → granularer Report: `{added, duplicates,
   errors, media, cards:[{index, ok, note_id?, is_duplicate?}]}`.

UI (`medizin.js`): Deck-Eingabe als editable `<datalist>` (existierende Decks
aus `GET /api/anki/decks`, freie Eingabe erlaubt). „→ In Anki speichern"-Button
neben dem bestehenden ZIP-Button. Pro-Karte-Badges auf den Preview-Karten nach
Sync (grün „✓ in Anki", grau „↺ Duplikat", rot „✗ Fehler").

## Consequences

**Positiv:**
- Ein-Klick von generierter Karte in Ankis Review-Stapel.
- Automatischer Dedup über Deck-Boundary → kein manuelles Filtern alter Karten.
- ZIP-Export bleibt als Fallback falls AnkiConnect nicht läuft (Anki nicht
  offen, Plugin deaktiviert, anderer PC) — UX degradiert sauber statt hart
  zu brechen.

**Negativ:**
- AnkiConnect muss laufen (Anki geöffnet + Plugin installiert). Wird bei
  `/api/anki/decks` preflight-geprüft und im UI mit Warnhinweis signalisiert.
- Cards-Schema ist an den internen Generator-Output gekoppelt (Felder
  `front`, `back`, `image`, `funfact`, `merkhilfe`, `source`, `occlusions`).
  Bei Schema-Änderungen beide Seiten (`_card_to_anki_note` + ZIP-Export
  `api_learn_export_zip`) updaten.

## Nicht-Ziele

- Bidirektionaler Sync (Karten aus Anki zurück nach MC) — nicht gebraucht.
- Review-Statistiken aus Anki ins MC ziehen — wäre interessant, aber separate
  Feature.
