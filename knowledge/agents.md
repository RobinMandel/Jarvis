# Agent-Oekosystem

> Ueberblick ueber alle Jarvis Sub-Agents und Bots. Historisch gewachsen, teilweise archiviert.

---

## Claude Code Agents (aktiv, Stand April 2026)

| Name | Rolle | Beschreibung |
|---|---|---|
| study-med (Dr. Theo) | Medizin | Klinische Fragen, OSCE, Anki |
| orga (Nina) | Organisation | Kalender, Email-Triage, Planung |
| market (Marcus) | Trading | Markt-Analyse, Portfolio-Monitoring |
| mail (Sophia) | Email | Email-Check, Entwuerfe, Triage |
| research (Nova) | Forschung | Paper-Recherche, Datenanalyse |

---

## Discord Bots (archiviert, liefen auf OpenClaw)

Core Team (12 Bots, deaktiviert seit Migration zu Claude Code):

| Bot | Rolle |
|---|---|
| JARVIS | Kern-Agent |
| Axel | Tech Lead |
| Dr. Theo | Medizin |
| Elena | Schreiben |
| Don | Advisory |
| Luna | Kreativ |
| Toni | Orga |
| Ivy | Research |
| Paul | Mail-Sender |
| Otto | Mail-Reader |
| Zara | Security |
| PortfoiLio | Trading |

---

## OpenClaw Agent-Verzeichnis (archiviert)

29 Agents waren konfiguriert: advisory-lead, amboss-worker, browser-lead, calendar-worker, crypto-worker, discord-profi, image-worker, jarvis-core, literature-worker, mail-reader, mail-safe, mail-sender, main, market-news-lead, media-lab, moodle-worker, ops-safe, orga-lead, portfolio-worker, publish-worker, research-writer, security-chief, study-med, tech-lead, travel-lead, via-medici-worker, video-worker, writing-worker.

Configs archiviert unter: `OneDrive/AI/OpenClaw-Jarvis/agents/`

---

## Email-Agents (Sonderrolle)

### Otto (Mail-Reader)
- Liest Emails aus Outlook + Uni
- Triage: URGENT -> RELEVANT -> NICE-TO-KNOW -> SKIP
- Scripts: `check-all-emails.ps1`, `read-email-folder.ps1`

### Paul (Mail-Sender)
- Entwirft und sendet Emails
- **SENDEN-Regel:** 2x explizites "SENDEN" von Robin noetig
- Scripts: `send-email.ps1`

Beide haben eigene CREDENTIALS.md (nicht in diesem Repo, liegt in OpenClaw-Jarvis/agents/).

---

## Wichtige Personen im System

| Name | Rolle | Kontext |
|---|---|---|
| Robin | Chef, Mensch | Alles |
| Ernst Mandel (Papa) | Familie | Email: ernstmandel@outlook.de, Token-Benachrichtigungen |

---

*Letzte Aktualisierung: 2026-04-13*
