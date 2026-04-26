# Architecture Decision Records

Kurze Entscheidungsprotokolle (ADRs) für nicht-triviale Architekturentscheidungen
in Mission Control. Jedes ADR beantwortet **Warum** wir so gebaut haben, nicht
**Was** der Code macht (das zeigt der Code selbst).

**Format pro ADR:**
- **Status** — "Accepted" / "Superseded by ADR-N" / "Deprecated"
- **Context** — was war das Problem, welche Constraints waren da
- **Decision** — was haben wir entschieden
- **Consequences** — Vor- und Nachteile die wir akzeptiert haben

**Wann ein ADR schreiben:**
Sobald eine Entscheidung 1) nicht aus dem Code allein herzuleiten ist und
2) in 6 Monaten jemand (auch Robin selbst) fragen könnte „warum hast du das so gebaut?".

**Liste:**
- [0001 — llm_client Provider-Abstraktion](0001-llm-client-provider-abstraction.md)
- [0002 — Chat-Session provider-agnostisch](0002-chat-session-provider-agnostic.md)
- [0003 — Anki Bulk-Sync via AnkiConnect](0003-anki-bulk-sync-ankiconnect.md)
- [0004 — ViaMedici Keycloak Silent-Auth](0004-viamedici-keycloak-silent-auth.md)
- [0005 — Email Panel v2 mit SQLite-Cache](0005-email-panel-v2-sqlite-cache.md)
- [0006 — Shared RAG via System-Prompt-Injection](0006-shared-rag-system-prompt.md)
