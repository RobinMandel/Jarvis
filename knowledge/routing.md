# Model Routing & Approach Learnings

> Jarvis konsultiert diese Datei vor non-trivialen Tasks um das beste Model + Approach zu waehlen.

---

## Model Routing

### Schnelles Modell (z.B. Sonnet, Haiku, GPT-4o-mini)
Geeignet fuer:
- Anki-Karten erstellen (Batch <= 50 pro Run)
- Email-Entwuerfe
- Quick Medical Facts (inline, kein Tool)
- Kleine Code-Fixes
- Daily Notes / Memory Updates
- Obsidian Linking / Batch-Edits

### Starkes Modell (z.B. Opus, GPT-4, o1)
Geeignet fuer:
- Dissertation Datenanalyse (multi-step reasoning)
- Komplexe OSCE-Fallszenarien (DD + Algorithmus + Dosierungen)
- Deep Research / Paper-Analyse (web search + synthesis)
- Debugging komplexer Multi-File-Probleme
- Architektur-Entscheidungen (Trade-off-Analyse)

---

## Approach Routing

### Direkt (kein Sub-Agent)
- Fragen mit <30s Antwortzeit
- Einzelne Datei-Edits
- Quick Lookups
- Memory-Updates

### Sub-Agent / Parallel
- Batch-Operationen (>10 Items)
- Lange Analysen (>5 Min)
- Multi-File-Edits (>3 Dateien)
- Research mit mehreren Web-Searches
- Code-Projekte (neue Features, Refactoring)

---

## Anti-Patterns (was NICHT funktioniert)

- Starkes Modell fuer simple Anki-Karten -> Overkill
- Grosse git-Operationen in Main Session -> blockiert, besser als Sub-Agent
- >100 Dateien in einem Run -> Timeout-Risiko, splitten
- PDF-Analyse ohne PDF-Parser -> Web-Fetch fuer PDFs unzuverlaessig
- YouTube Transcript Extraction -> IP-Blocking persistent, Invidious-Proxies down

---

## Technische Learnings

- `\b` Wortgrenzen in Regex sind kritisch fuer Precision (Vault-Linking)
- `.pzfx` ist XML, `.prism` ist ZIP mit JSON -> beides skriptbar
- `communicate()` statt `readline()` fuer subprocess output buffering
- Browser cached aggressiv -> Ctrl+Shift+R nach Aenderungen
- `.gitignore` VORHER setzen, nicht nachtraeglich (besonders bei grossen Ordnern)

---

*Wird laufend ergaenzt wenn neue Patterns entdeckt werden.*
