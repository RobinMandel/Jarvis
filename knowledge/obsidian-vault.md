# Obsidian Vault — Jarvis-Brain

> Vollstaendige Dokumentation des Langzeitgedaechtnisses. Pfade in [`platforms/paths.md`](../platforms/paths.md).

---

## Vault-Statistik (Stand April 2026)

- **~198+ Markdown-Dateien**
- **7 Hub-Pages** (Root-Ebene)
- **320 ChatGPT-Import-Conversations** (69 Hubs)
- **23 Claude-Import-Conversations**
- **500+ Wiki-Links**

---

## Hub-Pages (Einstiegspunkte)

| Hub | Beschreibung |
|---|---|
| `OSCE.md` | PJ-Reife OSCE — alle Faecher, Material, Anki (bestanden 08.04.2026) |
| `Anki.md` | Anki-Workflow, Style Guide, Karten-Stand |
| `Medizin.md` | Allgemeine medizinische Themen |
| `Dissertation-ITI.md` | Doktorarbeit, Zotero, Datenanalyse |
| `Trading.md` | Trading Bots, Mission Control, Portfolio |
| `OpenClaw-Tech.md` | OpenClaw-Infrastruktur, Discord, Email |
| `Famulatur-Tanzania.md` | KCMC Moshi, Flug, Todos |

---

## Ordnerstruktur

```
Jarvis-Brain/
  *.md                              <- Hub-Pages
  LINKING-GUIDE.md                  <- Konventionen (Tags, Links, Naming)
  Jarvis-Memory/
    YYYY-MM-DD.md                   <- Daily Notes
    YYYY-WXX-summary.md            <- Weekly Summaries
    context-*.md                    <- Aktuelle Bereichskontexte
    failsafe.md                     <- Ausfall-Runbook
    routing-learnings.md            <- Model Routing (auch in diesem Repo)
    inbox.md                        <- Eingangskorb
    osce/                           <- OSCE Fach-Dateien + Anki-Guides
    osce-materialien/               <- Deep-Scrape Analysen (6 Dateien, 183KB)
    osce-material/                  <- PJ-Reife Stationen, Moodle-Downloads, PDFs
  Jarvis-Knowledge/
    INDEX.md                        <- Wissens-Index
    Kontext/Robin.md                <- Robin-Profil
    Kontext/Jarvis.md               <- Jarvis-Identitaet
    Meta/Jarvis-System.md           <- System-Architektur
    Forschung/context-iti.md        <- Dissertation-Kontext
    Skills/                         <- Skill-Dokumentation
    Technik/                        <- Technische Guides
    Medizin/                        <- Medizinisches Wissen
  ChatGPT-Import/
    INDEX.md                        <- 320 Conversations
    _Hubs/                          <- 69 Themen-Hubs
    Medizin/                        <- Medizin-Chats
    Technik/                        <- Tech-Chats
    Alltag/                         <- Alltags-Chats
    Forschung/                      <- Forschungs-Chats
    Claude-Import/                  <- 23 Claude-Chat-Exports
```

---

## Tag-System (kanonisch)

4 Ebenen: `#domain #context #status [#entity]`

- **Domain:** `#medical` `#anki` `#research` `#tech` `#finance` `#personal`
- **Context:** `#osce` `#cardio` `#famulatur` `#discord` `#openclaw`
- **Status:** `#active` `#pending` `#done` `#urgent`
- **Entity:** `#robin` `#jarvis` `#otto` `#paul`
- **Max 2-5 Tags pro Eintrag**

---

## Naming Convention

| Typ | Muster | Beispiel |
|---|---|---|
| Daily Note | `YYYY-MM-DD.md` | `2026-04-13.md` |
| Weekly | `YYYY-WXX-summary.md` | `2026-W14-summary.md` |
| OSCE Fach | `{fach-lowercase}.md` | `neurologie.md` |
| Context | `context-{bereich}.md` | `context-iti.md` |
| Hub | `{Thema-PascalCase}.md` | `Trading.md` |

---

## Linking-Regeln

- Daily Notes verlinken immer zu relevanten Hubs am Ende (`## Verknuepfungen`)
- OSCE-Dateien verlinken zu `[[OSCE]]` + `[[{fach}-anki]]`
- Trigger-Keywords bestimmen welche Hubs verlinkt werden (siehe LINKING-GUIDE.md im Vault)

---

*Fuer die volle Linking-Referenz: `LINKING-GUIDE.md` im Vault.*
