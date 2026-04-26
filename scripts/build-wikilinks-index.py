#!/usr/bin/env python3
"""
Wiki-Link-Indexer fuer den Obsidian-Vault.

Scannt alle .md-Files unter `Jarvis-Brain/`, extrahiert `[[Wiki-Link]]`-Syntax
(plus `[[Target|Display]]` und `[[Target#Section]]` Varianten), baut
Adjacency-Maps + Orphans + Broken-Links. Output als JSON unter
`Jarvis-Brain/wikilinks-index.json`.

Use-Cases:
  - vault_backlinks(target) MCP-Tool kann den JSON lesen statt jedesmal scannen
  - Orphan-Detection (welche Notes verlinkt niemand?)
  - Broken-Link-Report (welche [[Targets]] existieren nicht als Note?)

Idempotent + fehler-tolerant. Laeuft typischerweise via Scheduled Task nightly,
plus on-demand wenn jemand explizit triggert.
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

VAULT_ROOT = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain")
OUTPUT = VAULT_ROOT / "wikilinks-index.json"
LOG = Path(__file__).resolve().parent / "wikilinks-index.log"

# [[Target]], [[Target|Display]], [[Target#Section]], [[Target#Section|Display]]
WIKI_LINK_RE = re.compile(r"\[\[([^\]\|#]+?)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]")

SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules", ".smart-env", ".obsidian-git"}


def log(msg: str) -> None:
    ts = datetime.now().isoformat(timespec="seconds")
    line = f"[{ts}] {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def _normalize_target(raw: str) -> str:
    """`[[Mission-Control]]` and `[[mission-control]]` and a file `Projects/Mission-Control.md`
    should match. Plus Pfad-Links wie `[[Jarvis-Memory/osce/innere-anki]]` werden
    auf den letzten Pfad-Teil reduziert, damit Stem-Match funktioniert."""
    t = raw.strip().rstrip("\\/").strip()  # Markdown-escape backslashes weg
    if t.lower().endswith(".md"):
        t = t[:-3]
    # Pfad-Notation -> nur den letzten Bestandteil als Stem
    if "/" in t:
        t = t.rsplit("/", 1)[-1]
    if "\\" in t:
        t = t.rsplit("\\", 1)[-1]
    return t.strip()


def _walk_md_files() -> list[Path]:
    out = []
    for p in VAULT_ROOT.rglob("*.md"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        out.append(p)
    return out


def _short_path(p: Path) -> str:
    """Vault-relativer Pfad mit Forward-Slashes."""
    try:
        return str(p.relative_to(VAULT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(p)


def build_index() -> dict:
    md_files = _walk_md_files()
    log(f"Scanning {len(md_files)} .md files in {VAULT_ROOT}")

    # Note-Index: Map normalisiertes Namen -> alle Pfade die diesen Stem haben
    name_to_paths: dict[str, list[str]] = defaultdict(list)
    for p in md_files:
        stem = p.stem  # ohne .md
        name_to_paths[_normalize_target(stem).lower()].append(_short_path(p))

    # Pro Note: Outgoing Links extrahieren
    forward: dict[str, list[str]] = {}    # source -> [targets-raw]
    backlinks: dict[str, list[str]] = defaultdict(list)  # target-norm -> [sources]
    broken_links: list[dict] = []
    total_links = 0

    for p in md_files:
        try:
            content = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        targets = WIKI_LINK_RE.findall(content)
        if not targets:
            continue
        rel = _short_path(p)
        forward[rel] = []
        for raw in targets:
            norm = _normalize_target(raw).lower()
            forward[rel].append(raw.strip())
            total_links += 1
            # Backlink-Eintrag (auch wenn target nicht existiert — fuer Reporting)
            backlinks[norm].append(rel)

    # Orphans: Notes die nirgendwo backlinked sind
    referenced = set(backlinks.keys())
    orphans = [
        paths[0]
        for stem, paths in name_to_paths.items()
        if stem not in referenced
    ]

    # Broken Links: target ohne entsprechende File
    existing_stems = set(name_to_paths.keys())
    for source, targets in forward.items():
        for raw in targets:
            norm = _normalize_target(raw).lower()
            if norm not in existing_stems:
                broken_links.append({"source": source, "target": raw})

    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "vault_root": str(VAULT_ROOT),
        "stats": {
            "files_scanned": len(md_files),
            "files_with_links": len(forward),
            "total_links": total_links,
            "unique_targets": len(referenced),
            "orphans": len(orphans),
            "broken_links": len(broken_links),
        },
        "forward": forward,
        "backlinks": {k: sorted(set(v)) for k, v in backlinks.items()},
        "orphans": sorted(orphans),
        "broken_links": sorted(broken_links, key=lambda x: x["source"]),
    }

    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(
        f"Wrote {OUTPUT.name}: {payload['stats']['files_with_links']}/{len(md_files)} "
        f"files have links, {total_links} total, {payload['stats']['orphans']} orphans, "
        f"{payload['stats']['broken_links']} broken"
    )
    return payload


def main() -> int:
    if not VAULT_ROOT.exists():
        log(f"FATAL: Vault not found at {VAULT_ROOT}")
        return 1
    try:
        payload = build_index()
        # Top-3 broken pro Run im Log fuer Quick-View
        for b in payload["broken_links"][:3]:
            log(f"  broken: [[{b['target']}]] in {b['source']}")
        if len(payload["broken_links"]) > 3:
            log(f"  ... +{len(payload['broken_links']) - 3} more in {OUTPUT.name}")
        return 0
    except Exception as e:
        log(f"FATAL: {e!r}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
