#!/usr/bin/env python3
"""
Diss Nacht-Recherche — PubMed/Literatursuche fuer Doktorarbeit
Laeuft taeglich um 02:00. Sucht neue Papers zu Robins Thema.
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0

CLAUDE_CLI = r"C:\Users\Robin\.local\bin\claude.exe"
ZOTERO_SCRIPT = Path(__file__).parent / "zotero-add.py"


def _zotero_import(raw_json: str, output_file: Path | None = None) -> str:
    """Extract DOIs from night-research JSON, push to Zotero, write status back."""
    try:
        data = json.loads(raw_json)
    except Exception:
        return raw_json
    changed = False
    for paper in data.get("papers", []):
        doi = (paper.get("doi") or "").strip()
        if not doi or doi == "null":
            paper["zotero"] = "no_doi"
            continue
        try:
            r = subprocess.run(
                [sys.executable, str(ZOTERO_SCRIPT), "--doi", doi],
                capture_output=True, text=True, timeout=30,
                encoding="utf-8", errors="replace",
            )
            out = r.stdout.strip() or r.stderr.strip()
            print(f"  Zotero [{doi}]: {out[:120]}")
            try:
                result = json.loads(out)
                paper["zotero"] = "ok" if result.get("ok") else "error"
            except Exception:
                paper["zotero"] = "ok" if r.returncode == 0 else "error"
        except Exception as e:
            print(f"  Zotero [{doi}] Fehler: {e}")
            paper["zotero"] = "error"
        changed = True
    updated = json.dumps(data, ensure_ascii=False, indent=2)
    if changed and output_file:
        output_file.write_text(updated, encoding="utf-8")
    return updated
VAULT_KNOWLEDGE = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Knowledge/Forschung")
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

import atexit as _atexit
DATA_DIR.mkdir(parents=True, exist_ok=True)
_log_fh = open(DATA_DIR / "cron-diss-recherche.log", "a", encoding="utf-8", buffering=1)
_orig_stdout = sys.stdout
class _Tee:
    def write(self, s): _orig_stdout.write(s); _log_fh.write(s)
    def flush(self): _orig_stdout.flush(); _log_fh.flush()
    def __getattr__(self, n): return getattr(_orig_stdout, n)
sys.stdout = _Tee()
_atexit.register(_log_fh.close)
print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] cron-diss-recherche START")


def recherche():
    today = datetime.now().strftime("%Y-%m-%d")
    output_file = DATA_DIR / "night-results" / f"{today}-diss-recherche.json"
    output_file.parent.mkdir(parents=True, exist_ok=True)

    if output_file.exists():
        print(f"Recherche fuer {today} existiert bereits. Ueberspringe.")
        return

    prompt = """Du bist Dr. Theo, Robins Forschungsassistent.

Robins Doktorarbeit: Kardiochirurgie-Kohorte, Thema AKI (Acute Kidney Injury) nach herzchirurgischen Eingriffen.
Fokus: Neutrophile, SIRS, Biomarker, Praediktion von AKI.

Suche mit web_search nach aktuellen Papers (letzter Monat) zu:
1. "acute kidney injury cardiac surgery biomarkers 2026"
2. "neutrophil SIRS cardiac surgery AKI prediction"
3. "KDIGO AKI prevention cardiac surgery"

Fasse die Top 3-5 relevantesten Ergebnisse zusammen als JSON:
{
  "date": "DATUM",
  "papers": [
    {
      "title": "Paper-Titel",
      "authors": "Erstautor et al.",
      "doi": "10.xxxx/xxxxx oder null",
      "summary": "2-3 Saetze Zusammenfassung",
      "relevance": "Warum relevant fuer Robins Arbeit",
      "url": "URL falls vorhanden"
    }
  ],
  "takeaway": "1 Satz: wichtigste Erkenntnis fuer Robin"
}

Wenn nichts Neues: papers=[], takeaway="Keine relevanten neuen Papers."
Gib NUR das JSON aus, kein anderer Text."""

    try:
        result = subprocess.run(
            [
                CLAUDE_CLI,
                "-p", prompt,
                "--output-format", "text",
                "--max-turns", "5",
                "--no-session-persistence",
                "--disallowed-tools", "Edit", "Write", "Glob", "Agent",
            ],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL,
            cwd="C:/Users/Robin/Jarvis",
            creationflags=_NO_WINDOW,
        )

        if result.returncode == 0 and result.stdout.strip():
            output_file.write_text(result.stdout.strip(), encoding="utf-8")
            print(f"Recherche geschrieben: {output_file}")
            _zotero_import(result.stdout.strip(), output_file)
        else:
            print(f"Claude Fehler: RC={result.returncode} | stdout={result.stdout[:100]!r} | stderr={result.stderr[:300]!r}")

    except subprocess.TimeoutExpired:
        print(f"Claude CLI TIMEOUT (>120s)")
    except Exception as e:
        print(f"Fehler: {type(e).__name__}: {e}")


if __name__ == "__main__":
    recherche()
