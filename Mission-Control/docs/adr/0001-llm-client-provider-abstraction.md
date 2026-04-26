# ADR-0001: llm_client Provider-Abstraktion

**Status:** Accepted (2026-04-23)

## Context

MC rief Claude direkt via `claude.exe`-Subprocess an 16+ Stellen auf (Chat-Stream,
Arena-Execution, SmartTasks, Email-Reply-Suggestions, Karten-Generator, YouTube-
Transkript etc.). Jeder Call-Site baute eigene `cmd`-Arrays und `asyncio.create_
subprocess_exec`-Aufrufe mit provider-spezifischen Flags.

Robin wollte künftig zwischen Claude, GPT (via Codex CLI) und Gemini pro Session
und pro Arena-Bot umschalten können — ohne dass MC auf einen einzigen Vendor
fixiert bleibt. Codex-CLI nutzt OAuth mit ChatGPT-Account, Gemini-CLI OAuth mit
Google-Account, Claude-API braucht `ANTHROPIC_API_KEY`. Die Integration per
Copy-Paste des Subprocess-Patterns wäre 5× Wartungs-Schuld gewesen.

Alternativen, die verworfen wurden:
- Nur Claude-spezifisch bleiben → hartes Vendor-Lock-in
- „Dünne Adapter jetzt, einheitliches Format später" (Codex-Vorschlag Nr. 1
  aus der ersten Runde) → hätte bei 16 Call-Sites später 4-5 Migrationen
  gemeint statt einer

## Decision

Neues Modul `llm_client.py` als **einziger** Entry-Point für alle LLM-Calls:

- **Neutrale Input-Typen** (`Message`, `ContentBlock`-Union mit
  `TextBlock`/`ImageBlock`/`ToolUseBlock`/`ToolResultBlock`) — orientiert am
  Anthropic-SDK-Shape, weil der am expressivsten ist (Downgrade zu OpenAI
  oder Gemini ist einfacher als umgekehrt).
- **Neutrale Output-Events** (`TextDelta`, `ToolUseStart/Delta/End`,
  `ToolResultEvent`, `MessageStop`, `UsageEvent`, `ErrorEvent`). Der
  WebSocket-Client konsumiert nur diese, er weiß nicht welcher Provider läuft.
- **Capability-Flags pro Provider** (`requires_model`, `supports_resume`,
  `supports_native_tools`, `streams_incremental_text`, `supports_images`) —
  damit UI und Session-Logik dynamisch anpassen ohne hartkodierte Checks
  auf Provider-Namen.
- **5 Provider** in stabiler Reihenfolge: `claude-cli`, `claude-api`,
  `codex-cli`, `gemini-cli`, `openai`.

## Consequences

**Positiv:**
- Jeder neue Call-Site nutzt nur `invoke_llm()` — keine subprocess-Logik mehr
  duplizieren.
- Neue Provider dranhängen braucht ~60 Zeilen (ein neuer `LLMProvider`-Subclass
  + Registry-Eintrag + UI-Label).
- Tests (`test_llm_client.py`) sichern die Contracts.

**Negativ:**
- Abstraction-Layer kostet eine dünne Indirektions-Schicht (messages flatten,
  events parsen) — kleiner Overhead pro Call.
- Provider-spezifische Features (z.B. Claude-CLI `--permission-mode`) laufen
  via `provider_kwargs`-Dict — das ist weniger typisiert als native Flags.

**Nicht-Ziel:**
- Die 11 bestehenden Claude-CLI-Call-Sites *außerhalb* von Chat-Session und
  Arena (SmartTasks, YouTube-Transkript, Diss-Prism etc.) wurden **noch nicht**
  migriert. Das ist bewusste Phase 3 — Chat-Session war der größte Nutzen.
