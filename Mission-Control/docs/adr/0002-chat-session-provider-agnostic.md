# ADR-0002: Chat-Session provider-agnostisch

**Status:** Accepted (2026-04-23)

## Context

`ClaudeSession` war seit Anfang an Claude-CLI-spezifisch: `cli_session_id` für
`--resume`, Subprocess-Handle im `session.process`, Stale-Resume-Retry mit
Claude-spezifischer Error-Erkennung („Session X not found"). Beim Schritt auf
Multi-Provider (ADR-0001) entstand die Frage: wie splitten wir State und Logik
sauber?

Codex (in seiner Review-Rolle) verlangte explizit:
1. Getrennte Resume-Felder statt eines unscharfen gemeinsamen Feldes —
   `provider_thread_id` ist providerspezifisch und **nicht** zwischen Providern
   übertragbar.
2. `provider` und `model` im State getrennt persistieren — kombiniert nur in UI.
3. Bei Provider-Wechsel die alte Resume-ID **hart** verwerfen mit sichtbarer
   System-Message im Chat, nicht stillen Kontextverlust.
4. ErrorEvent und MessageStop exakt einmal in einen stabilen WS-Abschluss
   überführen, damit Frontend nie einen hängenden Turn sieht.

## Decision

`ClaudeSession` behält seinen Namen (Backward-Compat mit bestehenden Serialisierungen),
bekommt aber drei neue Felder:

- `provider: str` (default `"claude-cli"`)
- `model: str` (default `""` — CLI-Provider nehmen Account-Default)
- `provider_thread_id: str | None` (generisches Resume-Token, ersetzt
  `cli_session_id` semantisch; letzteres bleibt als Legacy-Alias synchron erhalten)

`_run_claude` delegiert an neues `_run_chat(ws, session, message, attachments)`,
das provider-agnostisch ist:
- Nutzt `_history_to_messages()` und `_build_provider_kwargs()` als Zwischen­
  schichten — der einzige Ort mit provider-Branching.
- Konsumiert nur normalisierte `StreamEvent`s (TextDelta, ToolUseStart/End,
  ToolResultEvent, UsageEvent, MessageStop, ErrorEvent).
- `_done_sent`-Flag + `_send_done()`-Helper garantieren exakt ein Abschluss-Event.
- Stale-Resume-Retry bleibt Claude-CLI-spezifisch (nur dort triggert die
  „Session not found"-Heuristik).

Provider-Switch-Logik in `_set_session_provider()` zentralisiert:
- Nur-Model-Wechsel bei gleichem Provider → kein Thread-Reset, keine Systemmeldung
- Provider-Wechsel → `provider_thread_id = None` **hart** + Systemmeldung in
  `history` + WebSocket-`chat.system`-Broadcast

## Consequences

**Positiv:**
- Neue Provider in Chat aktivieren = UI-Option im Picker hinzufügen, keine
  Session-Logik-Änderung.
- Keine provider-spezifische Branches in WS-Handlern oder im Frontend-Code.
- Fehler sichtbar im Chat als System-/Fehlermeldung, nicht nur Backend-Log.

**Negativ:**
- `ClaudeSession` heißt weiterhin so, obwohl es längst nicht mehr Claude-
  exklusiv ist — Rename würde alle sessions.json-Migrationen durcheinander
  bringen. Akzeptiert als kosmetische Schuld.
- Legacy-Feld `cli_session_id` wird noch persistiert zur Rückwärts-Kompatibilität
  mit sessions.json-Snapshots aus älteren Deploys. In ~2 Wochen entfernbar.

## Referenzen

- Switch-Flow-Fix (Race beim Send+Switch): Switch läuft jetzt **nach**
  Lock-Check, sodass ein busy-abgelehnter Send keinen stillen Provider-Wechsel
  hinterlässt.
- ErrorEvent-Handler im Frontend bereinigt `_activeServerStreams` auch im
  Fehlerpfad — ohne diesen Fix blieb der Send-Button „stumm disabled" nach
  einem Provider-Fehler.
