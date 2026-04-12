# OpenClaw — Referenz (archiviert)

> OpenClaw war die primaere Plattform von Feb bis April 2026. Ersetzt durch Claude Code.
> Config und Agent-Dateien archiviert unter `OneDrive/AI/OpenClaw-Jarvis/`.

---

## Was war OpenClaw?

AI Agent Orchestration Platform mit:
- Gateway (WebSocket + API) auf Port 18789
- Multi-Agent-System (29 Agents)
- Discord-Bot-Oekosystem (12 aktive Bots)
- LCM (Lossless Context Management) fuer Session-Kompression
- Cron-Jobs (12 konfiguriert, mehrere mit Timeout-Problemen)
- Telegram + Discord + WhatsApp Kanaele

---

## Warum archiviert?

- Gateway instabil (Crashes, Restart noetig)
- Abstraktionsschichten verlangsamten die Kommunikation
- Claude Code bietet direkteren API-Zugang mit besserer Performance
- Infrastruktur-Overhead war zu hoch fuer einen einzelnen User

---

## Was bleibt nuetzlich

- **Agent-Konzepte:** Die Aufteilung in spezialisierte Agents (Mail, Research, Trading etc.) wurde in Claude Code uebernommen
- **Memory-Architektur:** Daily Notes + Context-Files + Knowledge Graph funktioniert plattformuebergreifend
- **Email-Scripts:** PowerShell-Scripts fuer Graph API + IMAP sind wiederverwendbar
- **Credential-Docs:** Agent-spezifische CREDENTIALS.md in den Archiv-Ordnern
- **LCM-Docs:** Architektur-Dokumentation in `OpenClaw-Jarvis/lcm-docs/`

---

## Archiv-Standort

`OneDrive/AI/OpenClaw-Jarvis/`
- `agents/` — 29 Agent-Verzeichnisse mit Configs
- `cron/` — 12 Cron-Job-Definitionen
- `lcm-docs/` — LCM System-Dokumentation
- `memory/` — SQLite-Datenbanken (jarvis-core, main, image-worker)

---

*Nicht loeschen — dient als Referenz falls Konzepte wiederverwendet werden.*
