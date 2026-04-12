# Pfad-Mapping

> Alle plattform-spezifischen Pfade an EINEM Ort. Hardcoded Pfade gehoeren NUR hierher.

---

## Windows (Haupt-PC)

| Ressource | Pfad |
|---|---|
| Home | `C:\Users\Robin\` |
| Jarvis Repo | `C:\Users\Robin\Jarvis\` |
| OneDrive | `E:\OneDrive\` |
| Obsidian Vault | `E:\OneDrive\AI\Obsidian-Vault\Jarvis-Brain\` |
| OpenClaw Archiv | `E:\OneDrive\AI\OpenClaw-Jarvis\` |
| Dissertation | `E:\OneDrive\Dokumente\Studium\!!Medizin\03 Doktorarbeit\ITI\` |
| Diss Jarvis Workspace | `E:\OneDrive\Dokumente\Studium\!!Medizin\03 Doktorarbeit\ITI\Jarvis Workspace\` |
| Mission Control | `C:\Users\Robin\Jarvis\Mission-Control\` |
| Claude Code Config | `C:\Users\Robin\.claude\` |
| Claude Code CLAUDE.md | `E:\OneDrive\AI\Claude-Code-Jarvis\CLAUDE.md` |
| OpenClaw Workspace | `C:\Users\Robin\.openclaw\workspace-clean\` |
| OpenClaw Config | `C:\Users\Robin\.openclaw-clean\openclaw.json` |
| LCM Datenbank | `C:\Users\Robin\.openclaw\lcm.db` |
| Scripts | Workspace + `scripts/` |
| Secrets | Workspace `secrets/` (nicht im Repo) |
| Prism (GraphPad) | `C:\Program Files\GraphPad\Prism 10\prism.exe` |
| Anki Decks | via AnkiConnect `localhost:8765` |

---

## Mac (MacBook Air)

| Ressource | Pfad |
|---|---|
| Home | `/Users/robinmandel/` |
| Jarvis Repo | `/Users/robinmandel/Jarvis/` |
| OneDrive | `/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich/` |
| Obsidian Vault | `/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich/AI/Obsidian-Vault/Jarvis-Brain/` |
| OpenClaw Archiv | `/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich/AI/OpenClaw-Jarvis/` |
| Dissertation | `/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich/Dokumente/Studium/!!Medizin/03 Doktorarbeit/ITI/` |
| Claude Code Config | `/Users/robinmandel/.claude/` |
| Claude Code Memory | `/Users/robinmandel/.claude/projects/-Users-robinmandel/memory/` |

**Hinweis Mac:** OneDrive-Dateien muessen auf "Always Keep on This Device" stehen, sonst Timeout beim Lesen.

---

## Plattform-Erkennung

Fuer Scripts die auf beiden Systemen laufen:

```python
import platform
OS = platform.system()  # "Windows" oder "Darwin"

PATHS = {
    "Windows": {
        "vault": r"E:\OneDrive\AI\Obsidian-Vault\Jarvis-Brain",
        "onedrive": r"E:\OneDrive",
        "diss": r"E:\OneDrive\Dokumente\Studium\!!Medizin\03 Doktorarbeit\ITI",
    },
    "Darwin": {
        "vault": "/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich/AI/Obsidian-Vault/Jarvis-Brain",
        "onedrive": "/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich",
        "diss": "/Users/robinmandel/Library/CloudStorage/OneDrive-Persönlich/Dokumente/Studium/!!Medizin/03 Doktorarbeit/ITI",
    }
}
```

---

*Wenn du einen neuen Rechner einrichtest, fuege ihn hier hinzu.*
