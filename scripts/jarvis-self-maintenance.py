#!/usr/bin/env python3
"""
Jarvis Self-Maintenance — periodische Hygiene-Checks.

Laeuft via Scheduled Task alle paar Stunden. Aufgaben (alle idempotent,
fehler-tolerant):
  1. Memory-Lock-Cleanup: stale `.lock`-Files (>5 min alt) loeschen, falls
     ein Crash/Kill den Lock-Release verpasst hat.
  2. Audit-Log-Rotation: wenn `memory-audit.log` > 1 MB, in
     `memory-audit-YYYY-WW.log` archivieren und neu anfangen.
  3. Tageslog-Existence-Check: wenn das heutige `YYYY-MM-DD.md` fehlt,
     leere Skelett-Datei anlegen damit `memory_append` nicht crasht.
  4. Stale-Backup-Warnung: wenn Backups (_backup-*, Archive/openclaw-*) > 30
     Tage alt sind, loggen — Loeschung bleibt manuell.

Nichts hier ist destruktiv ausser Stale-Locks (die per Definition tot sind).
"""
from __future__ import annotations

import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

VAULT_MEMORY = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
JARVIS_BRAIN = VAULT_MEMORY.parent
AUDIT_LOG = JARVIS_BRAIN / "memory-audit.log"
LOG_FILE = Path(__file__).resolve().parent / "self-maintenance.log"

LOCK_STALE_S = 5 * 60  # 5 min
AUDIT_ROTATE_BYTES = 1 * 1024 * 1024  # 1 MB
BACKUP_WARN_DAYS = 30


def log(msg: str) -> None:
    ts = datetime.now().isoformat(timespec="seconds")
    line = f"[{ts}] {msg}"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def cleanup_stale_locks() -> int:
    """Loescht *.lock-Files in Jarvis-Memory die aelter als LOCK_STALE_S sind."""
    if not VAULT_MEMORY.exists():
        return 0
    count = 0
    now = time.time()
    for lock in VAULT_MEMORY.glob("*.lock"):
        try:
            age = now - lock.stat().st_mtime
            if age > LOCK_STALE_S:
                lock.unlink()
                log(f"  removed stale lock: {lock.name} (age {age:.0f}s)")
                count += 1
        except Exception as e:
            log(f"  lock cleanup error on {lock.name}: {e}")
    return count


def rotate_audit_log() -> bool:
    """Rotiert audit-log wenn > 1MB. Wochen-suffix."""
    if not AUDIT_LOG.exists():
        return False
    try:
        size = AUDIT_LOG.stat().st_size
        if size < AUDIT_ROTATE_BYTES:
            return False
        ts = datetime.now().strftime("%Y-W%V")
        archive = AUDIT_LOG.with_name(f"memory-audit-{ts}.log")
        # Falls Archive-Name kollidiert: numerischen Suffix anhaengen
        i = 1
        while archive.exists():
            archive = AUDIT_LOG.with_name(f"memory-audit-{ts}.{i}.log")
            i += 1
        shutil.move(str(AUDIT_LOG), str(archive))
        log(f"  rotated audit log -> {archive.name} ({size/1024:.0f} KB)")
        return True
    except Exception as e:
        log(f"  audit rotation error: {e}")
        return False


def ensure_today_log() -> bool:
    """Wenn heutiges Tageslog fehlt, leere Skelett-Datei anlegen.

    Das verhindert dass memory_append beim ersten Schreiber des Tages
    eine ueberraschende Race hat — die Datei existiert dann schon mit
    Header, alle Append-Operationen anfueren ans Ende.
    """
    if not VAULT_MEMORY.exists():
        return False
    today = datetime.now().strftime("%Y-%m-%d")
    target = VAULT_MEMORY / f"{today}.md"
    if target.exists():
        return False
    try:
        skeleton = (
            f"# {today} — Tageslog\n\n"
            "## Aktivitaeten\n\n"
            "## Erkenntnisse & Entscheidungen\n\n"
            "## Offene Punkte\n"
        )
        target.write_text(skeleton, encoding="utf-8")
        log(f"  created today log skeleton: {target.name}")
        return True
    except Exception as e:
        log(f"  today log create error: {e}")
        return False


def warn_stale_backups() -> int:
    """Findet alte Backups + Archive und loggt sie (loescht NICHT)."""
    candidates = [
        Path("E:/OneDrive/AI"),
        Path("C:/Users/Robin/Archive"),
    ]
    now = time.time()
    cutoff = now - (BACKUP_WARN_DAYS * 86400)
    count = 0
    for parent in candidates:
        if not parent.exists():
            continue
        for entry in parent.iterdir():
            if not entry.is_dir():
                continue
            name = entry.name.lower()
            if not (name.startswith("_backup-") or name.startswith("openclaw-legacy-") or "-pre-" in name):
                continue
            try:
                age_d = (now - entry.stat().st_mtime) / 86400
                if entry.stat().st_mtime < cutoff:
                    log(f"  STALE BACKUP ({age_d:.0f}d): {entry} — review for deletion")
                    count += 1
            except Exception:
                pass
    return count


def main() -> int:
    log("=== Self-Maintenance start ===")
    locks = cleanup_stale_locks()
    rotated = rotate_audit_log()
    log_created = ensure_today_log()
    stale_backups = warn_stale_backups()
    log(
        f"=== Done: locks_cleaned={locks} audit_rotated={rotated} "
        f"today_log_created={log_created} stale_backups={stale_backups} ==="
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e!r}")
        sys.exit(1)
