# System-Architektur

> Technischer Ueberblick ueber die Jarvis-Infrastruktur. Plattform-spezifische Pfade stehen in [`platforms/paths.md`](../platforms/paths.md).

---

## Gedaechtnis-Architektur

```
+--------------------------------------------------+
|                  JARVIS BRAIN                     |
|                                                   |
|  GitHub Repo (dieses hier)                        |
|  = Portable Identitaet, destilliertes Wissen      |
|                                                   |
|  Plattform-Memory (z.B. Claude Code Auto-Memory)  |
|  = Session-uebergreifendes Arbeitsgedaechtnis     |
|                                                   |
|  Obsidian Vault (Jarvis-Brain)                    |
|  = Langzeitgedaechtnis: Daily Notes, Material,    |
|    Knowledge Graph, ChatGPT/Claude-Imports        |
|                                                   |
+--------------------------------------------------+
```

**Hierarchie:** Repo > Plattform-Memory > Vault

- **Repo:** Was jede KI wissen MUSS. Wird selten geaendert, immer aktuell.
- **Plattform-Memory:** Plattform-spezifisches Arbeitsgedaechtnis (z.B. `~/.claude/memory/`). Kann verloren gehen.
- **Vault:** Alles. Daily Notes, OSCE-Material, 320 ChatGPT-Imports, Analyse-Dateien. Nicht alles davon ist relevant — context/ Files sind die Einstiegspunkte.

---

## Dienste & Ports (Windows-Jarvis)

| Service | Port | Beschreibung |
|---|---|---|
| OpenClaw Gateway | 18789 | WebSocket + API (archiviert, ersetzt durch Claude Code) |
| Mission Control | 8082 | Dashboard Frontend (Python/aiohttp) |
| bots.py | 8080 | Trading Bots API (Alpaca) |
| Supervisor | 8083 | Process Manager fuer 8080 + 8082 |
| AnkiConnect | 8765 | Anki Plugin API (localhost) |

---

## Kommunikationskanaele

| Kanal | Status | Beschreibung |
|---|---|---|
| **Terminal / CLI** | Primaer (Mac + Windows) | Claude Code direkt |
| **Mission Control** | Aktiv (Windows) | Web-Dashboard mit Chat, Voice, Trading |
| **Telegram** | Aktiv (Windows) | @RobinMandels_Jarvis_bot, Polling-Bridge |
| **Discord** | Archiviert | War Bot-Oekosystem mit 12 Bots (Otto, Paul, etc.) |
| **WhatsApp** | Konfiguriert | Selten genutzt |

---

## Email-Zugriff

| Account | Methode |
|---|---|
| robinmandel@outlook.de | Microsoft Graph API + OAuth |
| robin.mandel@uni-ulm.de | IMAP (imap.uni-ulm.de:993) |

Scripts und Credentials: siehe plattform-spezifische Docs.

---

## Kalender

- iCloud CalDAV (primaer)
- Credentials in secrets-Dateien (nicht im Repo)

---

## Backup-Strategie

| Was | Wie | Wann |
|---|---|---|
| Dieses Repo | Git + GitHub | Bei echten Aenderungen |
| Obsidian Vault | OneDrive Sync | Kontinuierlich |
| Workspace | Git Commit (lokal) | Wochentlich |

---

## Obsidian Vault Struktur (Kurzfassung)

Der Vault `Jarvis-Brain` ist das Langzeitgedaechtnis. Struktur:

```
Jarvis-Brain/
  OSCE.md, Anki.md, Medizin.md, ...    <- 7 Hub-Pages (Einstiegspunkte)
  LINKING-GUIDE.md                       <- Vault-Konventionen
  Jarvis-Memory/                         <- Daily Notes, Context-Files, OSCE-Analysen
  Jarvis-Knowledge/                      <- Destilliertes Wissen (Robin, System, Skills)
  ChatGPT-Import/                        <- 320 Conversations (Archiv)
  Claude-Import/                         <- Claude-Chat-Exports (Archiv)
```

- **Hub-Pages** sind die Einstiegspunkte pro Thema
- **Daily Notes** (`YYYY-MM-DD.md`) dokumentieren was an einem Tag passiert ist
- **Context-Files** (`context-*.md`) fassen den aktuellen Stand pro Bereich zusammen
- **Import-Ordner** sind Archiv — nuetzlich fuer Suche, aber nicht aktiv gepflegt

Volle Vault-Dokumentation: [`knowledge/obsidian-vault.md`](../knowledge/obsidian-vault.md)
