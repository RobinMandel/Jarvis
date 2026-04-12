# Claude Code — Plattform-Setup

> Aktuelle primaere Plattform (seit April 2026, ersetzt OpenClaw).

---

## Warum Claude Code?

Robin hat am 10.04.2026 von OpenClaw zu Claude Code migriert. Gruende:
- Direkter API-Zugang ohne Abstraktionsschichten -> bessere Performance
- Weniger Infrastruktur-Overhead
- Native Tool-Integration (Read, Write, Edit, Bash, Agent)
- Stabile CLI ohne Gateway-Crashes

---

## Setup

### CLAUDE.md (Projekt-Level)
Liegt auf OneDrive: `AI/Claude-Code-Jarvis/CLAUDE.md`
Wird als Projekt-Instruktion geladen (Symlink oder Copy in Arbeitsverzeichnis).

### Memory
- Auto-Memory in `~/.claude/projects/.../memory/`
- MEMORY.md als Index
- Einzelne Memory-Dateien mit Frontmatter (type: user/feedback/project/reference)

### Installierte Skills (69 total)
**Anthropic offiziell:** pdf, docx, xlsx, pptx, canvas-design, frontend-design, claude-api, mcp-builder, web-artifacts-builder, webapp-testing, algorithmic-art, theme-factory, skill-creator, doc-coauthoring

**Community:** ui-ux-pro-max, med-research, anki-connect, deep-research-pro, trading, zotero, brainstorming, systematic-debugging, verification-before-completion, writing-plans, executing-plans, dispatching-parallel-agents, kaizen, subagent-driven-development, csv-summarizer, d3js, playwright, youtube-transcript, remotion, context-engineering (13 sub), marketing (40 sub), ruflo (Referenz)

### Custom Agents (5)
- `study-med` (Dr. Theo) — Medizin
- `orga` (Nina) — Organisation
- `market` (Marcus) — Trading
- `mail` (Sophia) — Email
- `research` (Nova) — Forschung

### Cron-Jobs (6)
| Job | Schedule | Beschreibung |
|---|---|---|
| Auto-Dream | 03:00 | Memory Konsolidierung |
| Diss-Recherche | 02:00 | PubMed/Paper Suche |
| Trading Summary | 20:00 Mo-Fr | Portfolio + Markt |
| Memory Sync | stuendlich | Memory aufraumen |
| Telegram Bridge | Login | Bot-Polling starten |
| Mission Control | Login | Dashboard starten |

### Hooks
- **Session-Start:** Heartbeat-Script (Email-Check, Kalender-Check)

### Env-Vars (in settings.json)
- `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` — Graph API
- `ALPACA_*` — Trading API
- `ELEVENLABS_API_KEY` — TTS
- `ICLOUD_*` — Kalender
- `TELEGRAM_BOT_TOKEN` — Telegram Bridge
- `ZOTERO_*` — Literatur

---

## Bekannte Limitierungen

- Kein nativer Telegram-Support (braucht Bridge-Script)
- Kein nativer Discord-Support (bewusst entfernt)
- Chat mit Bildern: Timeout bei grossen Bildern (Claude braucht zu lange)
- Build Queue: `claude -p` Subprocess haengt bei komplexen Tasks

---

*Letzte Aktualisierung: 2026-04-13*
