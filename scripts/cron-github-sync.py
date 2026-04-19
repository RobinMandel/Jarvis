#!/usr/bin/env python3
"""
Nightly GitHub sync for the Jarvis repo.
Stages all tracked/untracked changes (respecting .gitignore), commits if there
are changes, and pushes to origin/master.
"""
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

REPO = Path(r"C:\Users\Robin\Jarvis")
LOG = REPO / "data" / "github-sync.log"
LOG.parent.mkdir(parents=True, exist_ok=True)


def run(cmd: list[str]) -> tuple[int, str]:
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {msg}"
    print(line)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def main() -> int:
    log("=== nightly github sync start ===")

    code, out = run(["git", "status", "--porcelain"])
    if code != 0:
        log(f"git status failed: {out.strip()}")
        return 1
    if not out.strip():
        log("no changes, skip")
        return 0

    changed = [l for l in out.splitlines() if l.strip()]
    log(f"{len(changed)} change(s) detected")

    code, out = run(["git", "add", "-A"])
    if code != 0:
        log(f"git add failed: {out.strip()}")
        return 1

    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    msg = f"nightly sync {stamp}"
    code, out = run(["git", "commit", "-m", msg])
    if code != 0:
        log(f"git commit failed: {out.strip()}")
        return 1
    log(f"commit ok: {msg}")

    code, out = run(["git", "push", "origin", "master"])
    if code != 0:
        log(f"git push failed: {out.strip()}")
        return 1
    log("push ok")
    log("=== done ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
