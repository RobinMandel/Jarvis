# ADR-0005: Email-Panel v2 — SQLite-Cache vor Graph/IMAP

**Status:** Accepted (2026-04-19)

## Context

Robin verwaltet drei E-Mail-Accounts parallel: Outlook (Microsoft Graph API),
Uni Ulm (IMAP), Gmail (IMAP). Die erste Email-Integration in MC rief die
APIs pro UI-Interaktion live auf — jeder Klick auf einen Ordner löste einen
Netzwerk-Roundtrip aus, Ordnerwechsel fühlten sich träge an, bei IMAP-Timeouts
blockierte das UI.

Ziel: Outlook-ähnliche 3-Pane-UI (Baum | Liste | Detail) mit der Latenz einer
lokalen Anwendung.

## Decision

**SQLite-Cache (`data/emails.db`) als Frontend-Sicht:**

- Tabellen: `accounts` (3 feste Einträge), `folders` (hierarchisch), `messages`
  (vollständiger Header + Body), `attachments`.
- UI liest **immer** aus SQLite — Ordnerwechsel, Message-Open, Suche sind alle
  lokal und sofort.
- Hintergrund-Sync (`email_sync.py`) aktualisiert SQLite aus den Backends:
  - Outlook: `scripts/outlook_graph.py folders|messages --with-body` via
    Subprocess (vermeidet `msal`-Init-Overhead im MC-Server-Prozess)
  - Uni/Gmail: `imaplib` direkt im Worker
- Sync-Trigger: manuell via UI-Button, automatisch alle X Minuten (aktuell
  ausgeschaltet bis Robin es aktiviert).

## Consequences

**Positiv:**
- Ordnerbaum-Rendering: instant, egal wie groß die Mailbox.
- Offline-Nutzung: einmal synced, Messages bleiben lesbar auch wenn Graph/IMAP
  down sind.
- Granulares Resilience-Modell: wenn ein Backend ausfällt, funktionieren die
  anderen zwei weiter (statt „Email-Tab ist tot").

**Negativ:**
- Messages sind immer minimal stale (bis zum nächsten Sync). Akzeptiert —
  Robin triggert bei Bedarf einen Sync.
- Jedes Konto synct initial viele hundert Mails (z.B. 557 für Orga-Account
  mit Klinik-Mails) → erster Sync-Durchlauf dauert. Delta-Sync (Graph
  `@odata.deltaLink`, IMAP `CONDSTORE`/`MODSEQ`) steht noch aus.
- IMAP-Ordnernamen mit Umlauten kommen als UTF-7-encoded (`Beh&APY-rde` statt
  `Behörde`) — stdlib hat keinen UTF-7-IMAP-Decoder; `imap-tools` oder manuelle
  Codec-Registrierung geplant.

## Phase-Struktur

- **Phase 1 (erledigt 2026-04-19):** 3-Pane-UI + SQLite-Cache + 3 Accounts
- **Phase 2 (erledigt 2026-04-19):** Reply-Chat mit Claude-Suggestions + Outlook-
  COM-Draft (`pywin32` → `Outlook.Application.CreateItem(0)` → `Display(False)`).
- **Phase 3 (offen):** Attachments per Chat-Befehl, Delta-Sync, UTF-7-Decoder,
  „Antwort an alle"/Weiterleiten, Read/Unread-Push zurück ins Postfach.
