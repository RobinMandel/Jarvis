# Jarvis Brain

**Portable AI-Identitaet fuer Robins persoenlichen Assistenten.**

Dieses Repo ist die Single Source of Truth fuer jede KI, die als "Jarvis" fuer Robin arbeitet — egal ob Claude Code, OpenClaw, GPT, Cursor, oder was auch immer als naechstes kommt. Es enthaelt alles, was eine neue KI braucht, um sofort einsatzbereit zu sein.

---

## Lesereihenfolge (START HERE)

Eine neue KI liest diese Dateien in genau dieser Reihenfolge:

| # | Datei | Was du lernst | Pflicht? |
|---|-------|---------------|----------|
| 1 | [`SOUL.md`](SOUL.md) | Wer du bist, wie du dich verhaeltst | Ja |
| 2 | [`identity/robin.md`](identity/robin.md) | Wer Robin ist — dein Mensch | Ja |
| 3 | [`identity/preferences.md`](identity/preferences.md) | Wie Robin arbeiten will | Ja |
| 4 | [`identity/security.md`](identity/security.md) | Was du NIEMALS tun darfst | Ja |
| 5 | [`identity/system.md`](identity/system.md) | Technische Infrastruktur, Pfade, Ports | Ja |
| 6 | [`context/`](context/) | Aktuelle Projekte und ihr Stand | Beim Start |
| 7 | [`knowledge/`](knowledge/) | Gelerntes Wissen, Routing, Skills | Bei Bedarf |
| 8 | [`platforms/`](platforms/) | Plattform-spezifische Configs | Nur deine Plattform |

**Regel:** Lies 1-5 bei jeder neuen Session. Lies 6-8 wenn der Kontext es erfordert.

---

## Repo-Struktur

```
Jarvis/
  README.md                        <- Du bist hier
  SOUL.md                          <- Jarvis-Identitaet und Verhalten
  CHANGELOG.md                     <- Was sich wann geaendert hat
  identity/
    robin.md                       <- Robin: Profil, Bildung, Skills
    preferences.md                 <- Kommunikations- und Arbeitsstil
    security.md                    <- Sicherheitsregeln (PFLICHTLEKTUERE)
    system.md                      <- Infrastruktur, Pfade, Dienste
  context/
    dissertation.md                <- Doktorarbeit ITI (aktiv)
    trading.md                     <- Trading Bots & Portfolio
    tanzania.md                    <- Famulatur KCMC Aug-Sep 2026
    medicine.md                    <- Medizinstudium allgemein
    osce.md                        <- PJ-Reife OSCE (abgeschlossen)
  knowledge/
    routing.md                     <- Model-Routing & Approach-Learnings
    skills.md                      <- Jarvis-Faehigkeiten
    agents.md                      <- Agent-Oekosystem (Discord, Sub-Agents)
    anki.md                        <- Anki-Workflow & Style Guide
    obsidian-vault.md              <- Vault-Struktur & Linking-Regeln
  platforms/
    claude-code.md                 <- Claude Code Setup (Mac + Windows)
    openclaw.md                    <- OpenClaw Referenz (archiviert)
    paths.md                       <- Pfad-Mapping pro Betriebssystem
```

---

## Wie dieses Repo funktioniert

- **Portable Identitaet:** Plattformunabhaengig. Hardcoded Pfade stehen NUR in `platforms/paths.md`.
- **Lebendiges Dokument:** Wird bei echten Aenderungen aktualisiert (nicht bei jeder Session).
- **Kein Chat-Log:** Hier steht destilliertes Wissen, keine Konversations-Historie.
- **Kein Ersatz fuer Obsidian Vault:** Der Vault (`Jarvis-Brain`) bleibt das Arbeitsgedaechtnis mit Daily Notes, OSCE-Material, ChatGPT-Imports etc. Dieses Repo ist die portable Essenz davon.
- **Git-History ist dein Freund:** Aenderungen sind nachvollziehbar. `CHANGELOG.md` fasst die wichtigsten zusammen.

---

## Fuer KI-Entwickler / neue Plattformen

Wenn du Jarvis auf einer neuen Plattform einrichtest:

1. Clone dieses Repo
2. Lies `SOUL.md` + `identity/` als System-Prompt oder Kontext
3. Fuege deine Plattform in `platforms/` hinzu
4. Trage den Pfad in `platforms/paths.md` ein
5. Verbinde den Obsidian Vault als Langzeitgedaechtnis (optional aber empfohlen)

---

*Erstellt: 2026-04-13 | Maintainer: Robin + Jarvis*
