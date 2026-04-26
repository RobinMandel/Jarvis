"""jarvis_mcp.py — Jarvis-Capability-Layer als MCP-Server.

Macht MCs Kern-Fähigkeiten (Vault-Read, RAG-Search, Memory-Read, Anki-Sync,
Vault-Bundles) als MCP-Tools verfügbar, sodass **alle** tool-fähigen Provider
(Claude-CLI, Claude-API, Gemini-CLI, OpenAI) sie nativ aufrufen können —
statt dass jede Integration separat pro Provider gewired wird.

Der Server läuft als stdio-basierter MCP-Server und wird typischerweise über
`.mcp.json` bei den Clients eingetragen. Startbar direkt:

    python -m jarvis_mcp              # für Direktaufruf via python -m
    python jarvis_mcp.py              # standalone

Oder in `.mcp.json` (Claude-CLI / Gemini-CLI):

    {
      "mcpServers": {
        "jarvis": {
          "command": "python",
          "args": ["C:/Users/Robin/Jarvis/Mission-Control/jarvis_mcp.py"]
        }
      }
    }

Tool-Set (v1):
  - vault_search(query, n_results)     — semantische RAG-Suche über Vault + Diss
  - vault_read_bundle(bundle)          — kompletter Inhalt eines Themen-Bundles
  - vault_list_bundles()               — verfügbare Bundle-Namen
  - memory_read(filename)              — MC-Memory-Files (projects.md, decisions.md, …)
  - memory_list()                      — Namen aller verfügbaren Memory-Files
  - anki_list_decks()                  — Deck-Liste aus laufendem Anki
  - mc_health()                        — aktueller MC-Status (läuft? PID? sessions?)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

# Ermögliche Import der bestehenden MC-Module (rag, amboss_client etc.)
_MC_DIR = Path(__file__).resolve().parent
if str(_MC_DIR) not in sys.path:
    sys.path.insert(0, str(_MC_DIR))

# --- MCP SDK ---
try:
    from mcp.server import Server, NotificationOptions
    from mcp.server.models import InitializationOptions
    from mcp.server.stdio import stdio_server
    import mcp.types as mcp_types
except ImportError as e:
    print(
        f"[jarvis-mcp] mcp SDK nicht installiert: {e}\n"
        f"Installieren mit: pip install mcp",
        file=sys.stderr,
    )
    sys.exit(1)


# --- Paths ---
# Master-Brain liegt im Vault (Single Source of Truth, alle Modelle teilen).
# Memory wurde 2026-04-26 von MC/data/memory in den Vault konsolidiert; das
# alte MC-lokale Verzeichnis ist abgeschaltet und nach data/memory-archive-*
# verschoben (siehe Tageslog 2026-04-26).
_VAULT_ROOT = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain")
_MEMORY_DIR = _VAULT_ROOT / "Jarvis-Memory"

#: Wie in server.py — Single-Source-of-Truth wäre besser, aber für MCP-Server-
#: Isolation duplizieren wir kontrolliert. Bei Änderung in server.py auch hier
#: angleichen (siehe ADR-0006).
VAULT_CONTEXT_BUNDLES: dict[str, list[str]] = {
    "dissertation": ["Dissertation-ITI.md", "Jarvis-Knowledge/Dissertation-ITI"],
    "medizin":      ["Medizin.md", "OSCE.md", "Anki.md", "Jarvis-Knowledge/Medizin"],
    "trading":      ["Trading.md", "Jarvis-Knowledge/Trading"],
    "openclaw":     ["OpenClaw-Tech.md", "Jarvis-Knowledge/OpenClaw"],
    "famulatur":    ["Famulatur-Tanzania.md"],
}


# --- Capability Matrix & Routing ---

BOT_CAPABILITIES = {
    "claude-cli": {
        "name": "Claude 3.5 Sonnet",
        "strengths": ["coding", "mcp", "complex-reasoning", "bash", "filesystem", "precise-tools"],
        "description": "Bester Allrounder für technische Aufgaben und Dateimanipulation.",
    },
    "gemini-cli": {
        "name": "Gemini 2.0 Flash",
        "strengths": ["long-context", "multimodal", "medical-research", "large-data-analysis", "recherche"],
        "description": "Experte für große Datenmengen, Medizin und aktuelle Websuche.",
    },
    "codex-cli": {
        "name": "GPT-4o (Codex)",
        "strengths": ["fast-coding", "simple-scripts", "quick-logic"],
        "description": "Schnelle Code-Snippets und einfache Logik-Aufgaben.",
    },
    "openai": {
        "name": "GPT-4o / o1",
        "strengths": ["general-knowledge", "reasoning", "vision", "creative-writing"],
        "description": "Hohe Reasoning-Leistung ohne MCP-Tool-Overhead.",
    }
}

def _tool_route_task(query: str) -> dict:
    """Empfiehlt den besten Bot-Provider basierend auf der Aufgabe."""
    q = (query or "").lower()
    scores = {name: 0 for name in BOT_CAPABILITIES}
    
    # Heuristische Punktevergabe
    if any(k in q for k in ["code", "python", "script", "bug", "fix", "datei", "file", "schreibe", "edit"]):
        scores["claude-cli"] += 3
        scores["codex-cli"] += 2
    if any(k in q for k in ["medizin", "doktor", "anatomie", "studium", "osce", "klinik", "patient"]):
        scores["gemini-cli"] += 5
    if any(k in q for k in ["trading", "chart", "aktien", "markt", "finanzen"]):
        scores["gemini-cli"] += 3
        scores["claude-cli"] += 2
    if any(k in q for k in ["recherche", "such", "finde", "info", "wissen", "erklär"]):
        scores["gemini-cli"] += 3
        scores["openai"] += 2
    if len(q) > 10000:
        scores["gemini-cli"] += 10 # Long context winner
        
    best_provider = max(scores, key=scores.get)
    return {
        "ok": True,
        "recommended_provider": best_provider,
        "explanation": BOT_CAPABILITIES[best_provider]["description"],
        "capabilities": BOT_CAPABILITIES[best_provider]["strengths"],
        "scores": scores
    }

# --- Tool-Implementations ----------------------------------------------------

def _tool_vault_search(query: str, n_results: int = 5) -> dict:
    """Semantische RAG-Suche (ChromaDB + bge-m3, 9412 Chunks)."""
    try:
        from rag.search import query as rag_query
        hits = rag_query(query, int(n_results))
        return {
            "ok": True,
            "hits": [
                {
                    "score": float(h.get("score") or 0),
                    "source": str(h.get("source") or ""),
                    "text": (h.get("text") or "")[:1500],
                }
                for h in hits
            ],
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _tool_vault_read_bundle(bundle: str, max_chars: int = 40000) -> dict:
    """Lädt kompletten Inhalt eines Themen-Bundles als konkateniertes Markdown."""
    bundle_name = (bundle or "").lower()
    paths = VAULT_CONTEXT_BUNDLES.get(bundle_name)
    if not paths:
        return {
            "ok": False,
            "error": f"Unbekanntes Bundle {bundle!r}. Erlaubt: {list(VAULT_CONTEXT_BUNDLES)}",
        }
    loaded: list[dict] = []
    total = 0
    for rel in paths:
        abs_path = _VAULT_ROOT / rel
        if not abs_path.exists():
            continue
        if abs_path.is_file() and abs_path.suffix.lower() == ".md":
            try:
                content = abs_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            loaded.append({"path": rel, "content": content})
            total += len(content)
        elif abs_path.is_dir():
            for md in sorted(abs_path.rglob("*.md")):
                try:
                    content = md.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    continue
                rp = str(md.relative_to(_VAULT_ROOT)).replace("\\", "/")
                loaded.append({"path": rp, "content": content})
                total += len(content)
                if total >= max_chars:
                    break
        if total >= max_chars:
            break
    return {"ok": True, "bundle": bundle_name, "file_count": len(loaded), "files": loaded}


def _tool_vault_list_bundles() -> dict:
    """Gibt alle verfügbaren Bundle-Namen + File-Counts zurück."""
    out = []
    for name, paths in VAULT_CONTEXT_BUNDLES.items():
        count = 0
        for rel in paths:
            p = _VAULT_ROOT / rel
            if p.is_file() and p.suffix.lower() == ".md":
                count += 1
            elif p.is_dir():
                count += sum(1 for _ in p.rglob("*.md"))
        out.append({"name": name, "paths": paths, "file_count": count})
    return {"ok": True, "bundles": out}


def _tool_memory_list() -> dict:
    """Listet Memory-Files in MCs data/memory/."""
    if not _MEMORY_DIR.exists():
        return {"ok": False, "error": f"{_MEMORY_DIR} existiert nicht"}
    files = sorted(f.name for f in _MEMORY_DIR.glob("*.md"))
    return {"ok": True, "files": files, "dir": str(_MEMORY_DIR)}


def _tool_vault_backlinks(target: str) -> dict:
    """Liest den Wiki-Link-Index (von build-wikilinks-index.py erzeugt) und
    gibt Backlinks + Forward-Links + Status zurueck. Schneller + vollstaendiger
    als ein Live-Scan via vault_search.
    """
    if not target:
        return {"ok": False, "error": "target required"}
    idx_path = _VAULT_ROOT / "wikilinks-index.json"
    if not idx_path.exists():
        return {
            "ok": False,
            "error": "wikilinks-index.json fehlt — laeuft nightly oder via build-wikilinks-index.py",
        }
    try:
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"Index-Read-Fehler: {e}"}

    # Normalisierung analog zum Indexer
    norm = target.strip().rstrip("\\/").strip()
    if norm.lower().endswith(".md"):
        norm = norm[:-3]
    if "/" in norm:
        norm = norm.rsplit("/", 1)[-1]
    norm = norm.strip().lower()

    backlinks = idx.get("backlinks", {}).get(norm, [])
    # Forward-Links: alle wo dieser Stem die Source ist
    forward = []
    for source_path, targets in idx.get("forward", {}).items():
        if source_path.lower().endswith(f"/{norm}.md") or source_path.lower() == f"{norm}.md":
            forward = targets
            break

    return {
        "ok": True,
        "target": target,
        "normalized": norm,
        "backlinks": backlinks,
        "backlinks_count": len(backlinks),
        "forward": forward,
        "forward_count": len(forward),
        "index_generated_at": idx.get("generated_at"),
    }


def _tool_memory_read(filename: str) -> dict:
    """Liest ein einzelnes Memory-File."""
    safe_name = os.path.basename(filename or "")
    if not safe_name.endswith(".md"):
        return {"ok": False, "error": "Nur .md-Files erlaubt"}
    path = _MEMORY_DIR / safe_name
    if not path.exists():
        return {"ok": False, "error": f"{safe_name} existiert nicht"}
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
        return {"ok": True, "filename": safe_name, "content": content, "chars": len(content)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _acquire_memory_lock(target: Path, timeout_s: float = 5.0, stale_s: float = 30.0) -> Path | None:
    """Atomic Lock fuer Memory-File-Edits. Race-frei via O_CREAT|O_EXCL.
    Stale-Detection: Lock-Files aelter als stale_s werden als verlassen erkannt.
    Return: Pfad zum Lock-File wenn erfolgreich, sonst None.
    """
    lock_path = target.with_suffix(target.suffix + ".lock")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, f"pid={os.getpid()};ts={datetime.now().isoformat()}".encode())
            finally:
                os.close(fd)
            return lock_path
        except FileExistsError:
            try:
                age = time.time() - lock_path.stat().st_mtime
                if age > stale_s:
                    try:
                        lock_path.unlink()
                    except FileNotFoundError:
                        pass
                    continue
            except FileNotFoundError:
                continue
            time.sleep(0.1)
    return None


def _release_memory_lock(lock_path: Path | None) -> None:
    if not lock_path:
        return
    try:
        lock_path.unlink()
    except Exception:
        pass


def _audit_memory(action: str, filename: str, detail: str = "") -> None:
    """Audit-Trail fuer alle Memory-Mutationen. Append-only Log neben dem Memory-Dir."""
    try:
        audit = _MEMORY_DIR.parent / "memory-audit.log"
        with open(audit, "a", encoding="utf-8") as f:
            ts = datetime.now().isoformat(timespec="seconds")
            f.write(f"[{ts}] {action} {filename} {detail}\n")
    except Exception:
        pass  # Audit darf nie die eigentliche Operation killen


def _tool_memory_append(filename: str, content: str, section: str = "") -> dict:
    """Atomic-append zu Memory-File mit File-Lock und Audit-Trail.

    Hauptmotivation: am 2026-04-26 wurde das Tageslog mehrfach von parallel
    arbeitenden Modellen ueberschrieben — Drift verloren. Mit `memory_append`
    schreiben alle Modelle (Claude/Codex/Gemini) atomar und seriell.

    `section`: optional. Wenn gesetzt, wird vor dem Inhalt ein Header `## {section}`
    eingefuegt (mit Leerzeile davor). Sonst wird content direkt am Ende angehaengt.
    """
    safe_name = os.path.basename(filename or "")
    if not safe_name.endswith(".md"):
        return {"ok": False, "error": "Nur .md-Files erlaubt"}
    if not content:
        return {"ok": False, "error": "content ist leer"}
    target = _MEMORY_DIR / safe_name
    target.parent.mkdir(parents=True, exist_ok=True)

    lock = _acquire_memory_lock(target)
    if not lock:
        return {"ok": False, "error": "Lock-Timeout (5s) — anderer Schreiber haelt das File"}

    try:
        existing_size = target.stat().st_size if target.exists() else 0
        with open(target, "a", encoding="utf-8") as f:
            if existing_size and section:
                f.write("\n")  # Separator zur vorherigen Sektion
            if section:
                f.write(f"\n## {section}\n")
            f.write(content)
            if not content.endswith("\n"):
                f.write("\n")
        new_size = target.stat().st_size
        appended = new_size - existing_size
        _audit_memory("APPEND", safe_name, f"+{appended}b section={section!r}")
        return {
            "ok": True,
            "filename": safe_name,
            "appended_bytes": appended,
            "new_total_bytes": new_size,
            "section": section,
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        _release_memory_lock(lock)


def _tool_memory_write(filename: str, content: str, allow_overwrite: bool = False) -> dict:
    """Atomic-write (komplett ueberschreiben) — nutze `memory_append` wann immer
    moeglich. Schreibt via temp-file + rename (crash-safe). Bewahrt eine .bak des
    vorigen Stands fuer Recovery.

    `allow_overwrite=True` ist Pflicht — explizite Bestaetigung dass das
    bestehende File geleert+ersetzt werden soll. Default false verhindert
    Versehen-Overrides.
    """
    safe_name = os.path.basename(filename or "")
    if not safe_name.endswith(".md"):
        return {"ok": False, "error": "Nur .md-Files erlaubt"}
    if not allow_overwrite and (_MEMORY_DIR / safe_name).exists():
        return {
            "ok": False,
            "error": f"{safe_name} existiert. Setze allow_overwrite=true wenn du wirklich ueberschreiben willst — sonst nutze memory_append.",
        }
    target = _MEMORY_DIR / safe_name
    target.parent.mkdir(parents=True, exist_ok=True)

    lock = _acquire_memory_lock(target)
    if not lock:
        return {"ok": False, "error": "Lock-Timeout (5s)"}

    try:
        # crash-safe: tmp -> rename, mit .bak des vorigen Stands
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        existing = target.exists()
        if existing:
            bak = target.with_suffix(target.suffix + ".bak")
            try:
                if bak.exists():
                    bak.unlink()
                target.replace(bak)
            except Exception:
                pass  # backup best-effort
        tmp.replace(target)
        _audit_memory("WRITE", safe_name, f"size={len(content)}b overwrite={existing}")
        return {"ok": True, "filename": safe_name, "bytes": len(content), "overwrote": existing}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        _release_memory_lock(lock)


def _tool_anki_list_decks() -> dict:
    """Deck-Liste via AnkiConnect (benötigt laufendes Anki auf :8765)."""
    try:
        import urllib.request
        payload = {"action": "deckNames", "version": 6}
        req = urllib.request.Request(
            "http://localhost:8765",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        if result.get("error"):
            return {"ok": False, "error": str(result["error"])}
        return {"ok": True, "decks": sorted(result.get("result") or [])}
    except Exception as e:
        return {"ok": False, "error": f"Anki nicht erreichbar: {e}"}


def _tool_mc_health() -> dict:
    """Prüft ob MC auf :8090 läuft und liefert Status."""
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:8090/api/health", timeout=3) as resp:
            return {"ok": True, "mc": json.loads(resp.read().decode("utf-8"))}
    except Exception as e:
        return {"ok": False, "error": f"MC nicht erreichbar: {e}"}


def _tool_skills_list() -> dict:
    """Listet alle in MC installierten Skills mit Metadaten (slug, name,
    description, triggers, tags). Liest direkt vom MC-REST-Endpoint.
    """
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:8090/api/skills", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        skills = data.get("skills") or data.get("items") or data
        # Reduziere auf Wesentliches damit der LLM-Tool-Output kompakt bleibt
        compact = []
        if isinstance(skills, list):
            for s in skills:
                if not isinstance(s, dict):
                    continue
                compact.append({
                    "slug": s.get("slug") or s.get("name"),
                    "name": s.get("name"),
                    "description": (s.get("description") or "")[:300],
                    "triggers": s.get("triggers") or [],
                    "tags": s.get("tags") or [],
                })
        return {"ok": True, "skills": compact, "count": len(compact)}
    except Exception as e:
        return {"ok": False, "error": f"MC /api/skills nicht erreichbar: {e}"}


def _tool_skill_get(slug: str) -> dict:
    """Liest die vollständige SKILL.md eines Skills (System-Instruktionen,
    Tool-Vorgaben, Workflow-Beschreibung). Nutzbar damit ein Bot den Skill
    kennt und seinen Workflow imitieren kann.
    """
    if not slug:
        return {"ok": False, "error": "slug erforderlich"}
    try:
        import urllib.request
        from urllib.parse import quote as _quote
        url = f"http://localhost:8090/api/skills/{_quote(slug)}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {"ok": True, "skill": data}
    except Exception as e:
        return {"ok": False, "error": f"MC /api/skills/{slug} nicht erreichbar: {e}"}


_MC_SKILLS_DIR = Path("C:/Users/Robin/Jarvis/skills")
_CC_SKILLS_DIR = Path.home() / ".claude" / "skills"


def _tool_skill_activate(slug: str, scope: str = "claude-cli") -> dict:
    """Aktiviert einen MC-Skill für claude-cli, indem seine SKILL.md als
    Wrapper nach ~/.claude/skills/{slug}.md kopiert wird. Claude-CLI lädt
    den Ordner automatisch beim Start → ab nächstem Chat-Turn kennt Claude
    den Skill als eingebaute Fähigkeit.

    scope: aktuell nur "claude-cli" unterstützt. Gemini-CLI nutzt
    `~/.agents/skills/`, Codex-CLI eigene Locations — die fügen wir bei
    Bedarf hinzu.
    """
    if not slug or "/" in slug or "\\" in slug or ".." in slug:
        return {"ok": False, "error": f"Ungültiger slug {slug!r}"}

    src_dir = _MC_SKILLS_DIR / slug
    if not src_dir.is_dir():
        return {
            "ok": False,
            "error": f"Skill {slug!r} nicht in {_MC_SKILLS_DIR} gefunden",
        }
    src_file = src_dir / "SKILL.md"
    if not src_file.exists():
        # Fallback auf README.md falls SKILL.md fehlt
        src_file = src_dir / "README.md"
        if not src_file.exists():
            return {
                "ok": False,
                "error": f"Weder SKILL.md noch README.md in {src_dir}",
            }

    _GEMINI_SKILLS_DIR = Path.home() / ".agents" / "skills"

    if scope == "claude-cli":
        dest_dir = _CC_SKILLS_DIR
        dest_path = dest_dir / f"{slug}.md"
    elif scope == "gemini-cli":
        dest_dir = _GEMINI_SKILLS_DIR / slug
        dest_path = dest_dir / "SKILL.md"
    else:
        return {"ok": False, "error": f"scope {scope!r} nicht unterstützt"}

    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_path
    dest = _CC_SKILLS_DIR / f"{slug}.md"

    try:
        content = src_file.read_text(encoding="utf-8", errors="replace")
        dest.write_text(content, encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": f"Schreiben fehlgeschlagen: {e}"}

    return {
        "ok": True,
        "slug": slug,
        "scope": scope,
        "wrapper_path": str(dest),
        "source": str(src_file),
        "note": "Wirksam ab nächster claude.exe-Invokation (neuer Chat-Turn).",
    }


def _tool_skill_deactivate(slug: str, scope: str = "claude-cli") -> dict:
    """Entfernt den claude-cli-Wrapper wieder. Der MC-Master-Skill bleibt
    unberührt — nur die Aktivierung wird zurückgenommen.
    """
    if not slug or "/" in slug or "\\" in slug or ".." in slug:
        return {"ok": False, "error": f"Ungültiger slug {slug!r}"}
    if scope != "claude-cli":
        return {"ok": False, "error": f"scope {scope!r} nicht unterstützt"}

    dest = _CC_SKILLS_DIR / f"{slug}.md"
    if not dest.exists():
        return {"ok": False, "error": f"Kein Wrapper {dest}"}
    try:
        dest.unlink()
    except Exception as e:
        return {"ok": False, "error": f"Löschen fehlgeschlagen: {e}"}
    return {"ok": True, "slug": slug, "scope": scope, "removed": str(dest)}


async def _tool_ask_peer(
    provider: str,
    query: str,
    context: str = "",
    model: str = "",
    session_id: str = "",
) -> dict:
    """Frage einen anderen Provider (Peer) one-shot ab und hol seine Antwort
    zurück. Nützlich wenn der aktuelle Bot eine Second-Opinion braucht
    (z.B. Jarvis-Main fragt Gemini nach Recherche-Input, Claude fragt Codex
    für reinen Code-Review, etc.).

    Ruft den existierenden MC-Endpoint /api/llm/ask-peer auf. Non-streaming,
    ein Turn auf Peer-Seite. Wenn `session_id` mitkommt, wird das Ergebnis
    als `chat.peer_answer`-Event an die Session-Subscriber broadcastet.
    """
    import aiohttp
    body: dict = {"provider": provider, "query": query}
    if context:
        body["context"] = context
    if model:
        body["model"] = model
    if session_id:
        body["session_id"] = session_id
    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                "http://localhost:8090/api/llm/ask-peer",
                json=body,
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                return await resp.json()
    except Exception as e:
        return {"ok": False, "error": f"MC /api/llm/ask-peer nicht erreichbar: {e}"}


async def _tool_generate_image(
    prompt: str,
    provider: str = "gemini",
    model: str | None = None,
    size: str = "1024x1024",
    session_id: str | None = None,
) -> dict:
    """Generiert ein Bild via MC-Endpoint und gibt Pfad+URL zurück.

    Wir rufen den HTTP-Endpoint auf statt image_client direkt — damit das Bild
    im MC-Upload-Verzeichnis landet und via `/api/uploads/…` sichtbar wird,
    und damit bei gesetztem session_id automatisch ein chat.image_generated-
    Event gefeuert wird.
    """
    import aiohttp
    payload: dict = {"provider": provider, "prompt": prompt, "size": size}
    if model:
        payload["model"] = model
    if session_id:
        payload["session_id"] = session_id
    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                "http://localhost:8090/api/image/generate",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                body = await resp.json()
                return body
    except Exception as e:
        return {"ok": False, "error": f"MC nicht erreichbar: {e}"}


# --- MCP-Server-Setup --------------------------------------------------------

_SERVER = Server("jarvis")


@_SERVER.list_tools()
async def _list_tools() -> list[mcp_types.Tool]:
    return [
        mcp_types.Tool(
            name="vault_search",
            description=(
                "Semantic search across Robin's Obsidian Vault (Jarvis-Brain) and "
                "Dissertation PDFs. Uses bge-m3 embeddings against 9412 indexed "
                "chunks. Use this when you need factual context about Robin's "
                "medical studies, projects, or notes."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language query"},
                    "n_results": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                },
                "required": ["query"],
            },
        ),
        mcp_types.Tool(
            name="vault_read_bundle",
            description=(
                "Load the full markdown content of a curated vault bundle "
                "(e.g. all Dissertation notes, all OSCE/Medizin/Anki material). "
                "Use this when you need the complete topic context, not just "
                "semantic snippets. Call vault_list_bundles first to see options."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "bundle": {
                        "type": "string",
                        "enum": list(VAULT_CONTEXT_BUNDLES),
                        "description": "Name of the bundle",
                    },
                    "max_chars": {"type": "integer", "default": 40000},
                },
                "required": ["bundle"],
            },
        ),
        mcp_types.Tool(
            name="vault_list_bundles",
            description="List all available vault bundles with file counts.",
            inputSchema={"type": "object", "properties": {}},
        ),
        mcp_types.Tool(
            name="vault_backlinks",
            description=(
                "Look up Obsidian-style [[Wiki-Link]] backlinks for a vault note. "
                "Returns who links TO this note (backlinks) + who this note links to "
                "(forward). Reads pre-built index `wikilinks-index.json` (refreshed "
                "nightly 02:35 via Scheduled Task 'Jarvis Wiki-Link Index'). Use this "
                "when you need to understand the graph context of a note — much faster "
                "than scanning the vault yourself."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Note stem (e.g. 'Mission-Control', 'Aortenstenose', 'AKI')",
                    },
                },
                "required": ["target"],
            },
        ),
        mcp_types.Tool(
            name="memory_list",
            description=(
                "List MCs internal memory files (SOUL.md, identity.md, projects.md, "
                "decisions.md, todos.md, robin.md, …). These are the short-form "
                "facts MC keeps about Robin and current state."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        mcp_types.Tool(
            name="memory_read",
            description="Read a single MC memory file by name (e.g. 'projects.md').",
            inputSchema={
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "e.g. 'projects.md'"},
                },
                "required": ["filename"],
            },
        ),
        mcp_types.Tool(
            name="memory_append",
            description=(
                "Atomic-append text to a memory file (Tageslog, decisions.md, etc.) "
                "with file-lock and audit-trail. PREFERRED over direct filesystem "
                "writes when multiple agents (Claude/Codex/Gemini) might be active. "
                "Prevents drift and overwrite-races. If `section` is given, prepends "
                "a `## {section}` header before the content."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "e.g. '2026-04-26.md' or 'decisions.md'"},
                    "content": {"type": "string", "description": "Markdown content to append"},
                    "section": {"type": "string", "description": "Optional H2 header to insert before content", "default": ""},
                },
                "required": ["filename", "content"],
            },
        ),
        mcp_types.Tool(
            name="memory_write",
            description=(
                "Crash-safe overwrite of a memory file (tmp+rename, keeps .bak). "
                "Use ONLY when you genuinely need to replace the entire file — "
                "for additions/updates use `memory_append` instead to avoid drift. "
                "Refuses to overwrite existing files unless `allow_overwrite=true`."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "filename": {"type": "string"},
                    "content": {"type": "string"},
                    "allow_overwrite": {"type": "boolean", "default": False, "description": "Required true if file already exists"},
                },
                "required": ["filename", "content"],
            },
        ),
        mcp_types.Tool(
            name="anki_list_decks",
            description=(
                "Return the list of Anki decks from the running Anki instance "
                "(requires AnkiConnect plugin on localhost:8765)."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        mcp_types.Tool(
            name="mc_health",
            description="Check if Mission Control is running on localhost:8090.",
            inputSchema={"type": "object", "properties": {}},
        ),
        mcp_types.Tool(
            name="skills_list",
            description=(
                "List all installed Jarvis Skills with name, description, "
                "triggers, tags. Use this to discover what specialized "
                "workflows are available before solving a task."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        mcp_types.Tool(
            name="skill_get",
            description=(
                "Read a single Skill's full SKILL.md (system instructions, "
                "tool definitions, workflow). Use when skills_list shows a "
                "skill that fits the current task — adopt its approach."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Skill slug from skills_list"},
                },
                "required": ["slug"],
            },
        ),
        mcp_types.Tool(
            name="skill_activate",
            description=(
                "Deploy an MC Skill as a claude-cli wrapper in ~/.claude/skills/, "
                "so Claude-CLI loads it automatically on next invocation. Use "
                "when the user asks to 'aktiviere Skill X' or when you think "
                "a skill from skills_list would be useful long-term. "
                "Effective from the next chat turn on."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Skill slug"},
                    "scope": {
                        "type": "string",
                        "enum": ["claude-cli", "gemini-cli"],
                        "default": "claude-cli",
                    },
                },
                "required": ["slug"],
            },
        ),
        mcp_types.Tool(
            name="skill_deactivate",
            description=(
                "Remove the claude-cli wrapper for a skill. The MC master "
                "skill stays intact — only the claude-cli activation is "
                "undone."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "scope": {"type": "string", "default": "claude-cli"},
                },
                "required": ["slug"],
            },
        ),
        mcp_types.Tool(
            name="ask_peer",
            description=(
                "Ask another LLM provider (Peer) a single question and get "
                "the answer back. Use this for second opinions, cross-checking, "
                "or delegating a specific task to the model best suited for it. "
                "Example: Claude asks Gemini for a medical search, or Codex "
                "asks Claude for code review. One-shot (no multi-turn). "
                "If session_id is given, the Q+A appears as chat.peer_answer "
                "in that session's log."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "provider": {
                        "type": "string",
                        "enum": ["claude-cli", "claude-api", "codex-cli",
                                 "gemini-cli", "openai", "openclaw"],
                        "description": "Which peer provider to ask",
                    },
                    "query": {
                        "type": "string",
                        "description": "The question / task for the peer",
                    },
                    "context": {
                        "type": "string",
                        "description": "Optional background context (will be "
                                       "shown in peer's system prompt)",
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional model override for the peer",
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Optional: MC chat session to broadcast "
                                       "the peer answer into",
                    },
                },
                "required": ["provider", "query"],
            },
        ),
        mcp_types.Tool(
            name="generate_image",
            description=(
                "Generate an image from a text prompt. Saves the image to MC's "
                "uploads folder and returns a public `/api/uploads/…` URL you can "
                "reference in chat messages (use Markdown: `![alt](url)`). "
                "Set session_id to automatically post the image to that chat "
                "session — the user will see it inline in the Chat UI."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "Detailed image description in English or German",
                    },
                    "provider": {
                        "type": "string",
                        "enum": ["gemini", "openai"],
                        "default": "gemini",
                        "description": (
                            "gemini (= Nano Banana / gemini-2.5-flash-image, "
                            "Free Tier, Default) or openai (gpt-image-1/dall-e-3, "
                            "needs OPENAI_API_KEY)"
                        ),
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional model override",
                    },
                    "size": {
                        "type": "string",
                        "default": "1024x1024",
                        "description": "Image size (ignored by gemini)",
                    },
                    "session_id": {
                        "type": "string",
                        "description": (
                            "Optional: MC chat session UUID to post the image into. "
                            "When set, the image appears inline in that chat."
                        ),
                    },
                },
                "required": ["prompt"],
            },
        ),
    ]


@_SERVER.call_tool()
async def _call_tool(name: str, arguments: dict | None) -> list[mcp_types.TextContent]:
    args = arguments or {}
    result: dict

    if name == "vault_search":
        result = await asyncio.to_thread(
            _tool_vault_search, args.get("query", ""), args.get("n_results", 5),
        )
    elif name == "vault_read_bundle":
        result = await asyncio.to_thread(
            _tool_vault_read_bundle, args.get("bundle", ""), args.get("max_chars", 40000),
        )
    elif name == "vault_list_bundles":
        result = _tool_vault_list_bundles()
    elif name == "vault_backlinks":
        result = await asyncio.to_thread(_tool_vault_backlinks, args.get("target", ""))
    elif name == "memory_list":
        result = _tool_memory_list()
    elif name == "memory_read":
        result = _tool_memory_read(args.get("filename", ""))
    elif name == "memory_append":
        result = await asyncio.to_thread(
            _tool_memory_append,
            args.get("filename", ""),
            args.get("content", ""),
            args.get("section", ""),
        )
    elif name == "memory_write":
        result = await asyncio.to_thread(
            _tool_memory_write,
            args.get("filename", ""),
            args.get("content", ""),
            bool(args.get("allow_overwrite", False)),
        )
    elif name == "anki_list_decks":
        result = await asyncio.to_thread(_tool_anki_list_decks)
    elif name == "mc_health":
        result = await asyncio.to_thread(_tool_mc_health)
    elif name == "skills_list":
        result = await asyncio.to_thread(_tool_skills_list)
    elif name == "skill_get":
        result = await asyncio.to_thread(_tool_skill_get, args.get("slug", ""))
    elif name == "skill_activate":
        result = await asyncio.to_thread(
            _tool_skill_activate,
            args.get("slug", ""),
            args.get("scope", "claude-cli"),
        )
    elif name == "skill_deactivate":
        result = await asyncio.to_thread(
            _tool_skill_deactivate,
            args.get("slug", ""),
            args.get("scope", "claude-cli"),
        )
    elif name == "ask_peer":
        result = await _tool_ask_peer(
            provider=args.get("provider", ""),
            query=args.get("query", ""),
            context=args.get("context", ""),
            model=args.get("model", ""),
            session_id=args.get("session_id", ""),
        )
    elif name == "generate_image":
        result = await _tool_generate_image(
            prompt=args.get("prompt", ""),
            provider=args.get("provider", "gemini"),
            model=args.get("model"),
            size=args.get("size", "1024x1024"),
            session_id=args.get("session_id"),
        )
    else:
        result = {"ok": False, "error": f"Unknown tool: {name}"}

    return [mcp_types.TextContent(
        type="text",
        text=json.dumps(result, ensure_ascii=False, indent=2),
    )]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await _SERVER.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="jarvis",
                server_version="1.0.0",
                capabilities=_SERVER.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


if __name__ == "__main__":
    asyncio.run(main())
