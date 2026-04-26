"""Bot Evaluator — taeglich nach Market Close ausfuehren.

Prueft alle Bots: Hat der schlechteste Bot >= MIN_TRADES und Sortino <= SORTINO_THRESHOLD?
Wenn ja: kick_and_mutate(loser, winner).

Aufruf: python evaluator.py
Optional: python evaluator.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

MC_DIR = Path(__file__).parent.parent / "Mission-Control"
sys.path.insert(0, str(MC_DIR))

from trading_bot_manager import kick_and_mutate, rank_bots_by_sortino  # noqa: E402

STATE_DIR = Path(__file__).parent / "state"
LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

MIN_TRADES = 20          # Mindest-Roundtrips bevor ein Bot evaluiert wird
SORTINO_THRESHOLD = 0.0  # Bots mit Sortino <= diesem Wert sind Kick-Kandidaten


def _count_trades(bot_id: str) -> int:
    p = STATE_DIR / f"{bot_id}.state.json"
    if not p.exists():
        return 0
    try:
        return len(json.loads(p.read_text(encoding="utf-8")).get("returns", []))
    except Exception:
        return 0


def _log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    log_file = LOG_DIR / f"evaluator_{datetime.now().strftime('%Y-%m')}.log"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run(dry_run: bool = False) -> None:
    _log("=== Evaluator Start ===")
    ranked = rank_bots_by_sortino()

    if len(ranked) < 2:
        _log(f"Nur {len(ranked)} Bot(s) registriert — min 2 benoetigt. Abbruch.")
        return

    winner = ranked[0]
    loser = ranked[-1]
    loser_trades = _count_trades(loser["id"])

    _log(f"Ranking ({len(ranked)} Bots):")
    for i, b in enumerate(ranked):
        trades = _count_trades(b["id"])
        _log(f"  #{i+1} {b['name']:30s}  sortino={b['sortino']:+.4f}  trades={trades}")

    if loser_trades < MIN_TRADES:
        _log(
            f"KEIN KICK: {loser['name']} hat erst {loser_trades}/{MIN_TRADES} "
            f"Trades — zu wenig Sample fuer statistisch valides Urteil."
        )
        return

    if loser["sortino"] > SORTINO_THRESHOLD:
        _log(
            f"KEIN KICK: Schlechtester Bot {loser['name']} hat Sortino={loser['sortino']:+.4f} "
            f"> Threshold {SORTINO_THRESHOLD} — alle Bots performen akzeptabel."
        )
        return

    _log(
        f"KICK: {loser['name']} (sortino={loser['sortino']:+.4f}, trades={loser_trades}) "
        f"→ mutiere Gewinner {winner['name']} (sortino={winner['sortino']:+.4f})"
    )

    if dry_run:
        _log("DRY-RUN: keine Aenderungen vorgenommen.")
        return

    result = kick_and_mutate(loser["id"], winner["id"])
    _log(f"Evolution abgeschlossen: {result}")
    _log("=== Evaluator Ende ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Bot-Evaluator (Survival of the Fittest)")
    parser.add_argument("--dry-run", action="store_true", help="Nur simulieren, kein Kick")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
