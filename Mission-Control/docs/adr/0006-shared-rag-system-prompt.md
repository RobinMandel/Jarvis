# ADR-0006: Shared RAG via System-Prompt-Injection

**Status:** Accepted (2026-04-23)

## Context

Mit Multi-Provider-Chat (ADR-0001, ADR-0002) sahen alle 5 Provider (Claude-CLI,
Claude-API, Codex-CLI, Gemini-CLI, OpenAI) den gleichen statischen System-Prompt
(SOUL + identity + robin + decisions + projects + todos + Claude-Memory-Files).
Sie kannten Robin, die Diss, MC-Projekte, Kommunikationsstil — aber **nicht den
eigentlichen Inhalt** des Obsidian-Vaults (Daily Notes, Knowledge Pages, ITI-
Wiki) oder der Dissertations-PDFs.

Die RAG-Infrastruktur stand bereits: ChromaDB mit 9412 Chunks, bge-m3-Embedding-
Modell, `/api/rag/search`-Endpoint, funktionierende Query-API.

**Zwei Wiring-Optionen:**

1. **Tool-basiert:** Jeder tool-fähige Provider bekommt ein `rag_search`-Tool,
   entscheidet selbst wann er suchen will. Problem: Codex-CLI hat keine
   konfigurierbaren Tools (`supports_native_tools=False`) → müsste man per
   Prompt-Injection dennoch lösen → zwei parallele Codepfade.

2. **System-Prompt-Injection:** Pro User-Message einmal RAG-Query, Top-N Hits
   über Score-Threshold als Block ans System-Prompt anhängen. Funktioniert
   universell, keine Provider-Diskrimination.

Gemini (als Peer in der Architektur-Diskussion) empfahl explizit Option 2 für
den Phase-1-Start, Option 1 als spätere Verfeinerung.

## Decision

`_build_rag_context(user_message)` in `server.py`:

- Query gegen ChromaDB mit bge-m3 (top-4, threshold 0.35).
- Jeder Chunk wird auf 800 Zeichen gekürzt, mit Source-Pfad (`Vault/…`) und
  Relevance-Score präfixiert.
- Rückgabe ist ein System-Prompt-appendbarer Markdown-Block mit Intro
  („Folgende Ausschnitte aus Robins Obsidian-Vault … — nutze sie wenn relevant,
  ignoriere sonst.").
- Wenn keine Hits über Schwelle: leerer String, kein Block.

In `_run_chat`: Nach `_build_system_prompt()` wird `_build_rag_context(message)`
aufgerufen, Result angehängt. Broadcast eines `chat.rag_info`-Events mit
Chunk-Zahl — Frontend kann später anzeigen „📚 3 Vault-Chunks als Kontext".

## Consequences

**Positiv:**
- Alle 5 Provider sehen Vault + Diss automatisch wenn semantisch relevant.
- Zero-Config für den User: keine „Vault-Modus"-Umschaltung nötig.
- Threshold (0.35 bge-m3-cosine) blockiert Noise bei zufälligen Queries
  („Wie spät ist es?" triggert nichts).

**Negativ:**
- Token-Overhead pro Message (~400-3200 zusätzliche Input-Tokens wenn Chunks
  reinkommen). Bei Claude/Gemini günstig; bei Codex/GPT-5 nennenswert.
- Latenz: bge-m3-Embedding pro Query kostet ~200-500 ms. Wird in
  `asyncio.to_thread` ausgeführt, blockiert also nicht den Event-Loop, aber
  der erste Token kommt entsprechend später.
- „Ignoriere wenn irrelevant" ist eine Bitte an das Modell, keine Garantie.
  Bei langweiliger User-Frage + schwach relevanten RAG-Hits kann das Modell
  trotzdem in die Vault-Details abdriften.

## Erweiterungen (Phase 2)

- Tool-basierte Variante zusätzlich für Providers mit `supports_native_tools=True`:
  `rag_search(query, n)` als `ToolDefinition`. Provider entscheidet selbst ob
  er mehrmals pro Turn querien will.
- Selbst-Limit auf Token-Budget: wenn System-Prompt + RAG zu groß wird, Chunks
  aggressiver kürzen oder weniger mitschicken.
- Metadata-Filter: `type="markdown"` nur Vault, `type="pdf"` nur Diss —
  pro-Session konfigurierbar.
