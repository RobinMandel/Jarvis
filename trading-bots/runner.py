"""Trading-Bot Runner.

Wird von Mission Control als Subprozess gestartet:
    python runner.py --id <bot_id> --config <config.json>

Laedt die Strategie-Klasse aus strategies/<strategy>.py, instanziiert sie
und ruft in einer Schleife strategy.tick() auf. Heartbeat + Status werden
nach data/trading-bots/<bot_id>.state.json geschrieben, damit MC den
Zustand auslesen kann ohne den Prozess zu beruehren.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import signal
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
STATE_DIR = ROOT / "state"
STATE_DIR.mkdir(exist_ok=True)

_running = True


def _stop(signum, frame):
    global _running
    _running = False


signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)


def _write_state(bot_id: str, **fields) -> None:
    path = STATE_DIR / f"{bot_id}.state.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        data = {}
    data.update(fields)
    data["updated_at"] = datetime.now().isoformat()
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _load_strategy(name: str):
    """Dynamisch strategies/<name>.py laden und Strategy-Klasse zurueckgeben."""
    strat_path = ROOT / "strategies" / f"{name}.py"
    if not strat_path.exists():
        raise FileNotFoundError(f"Strategy not found: {strat_path}")
    spec = importlib.util.spec_from_file_location(f"strategy_{name}", strat_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "Strategy"):
        raise AttributeError(f"{strat_path} exports no class 'Strategy'")
    return module.Strategy


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True, help="Bot-ID")
    parser.add_argument("--config", required=True, help="Pfad zu Bot-Config-JSON")
    args = parser.parse_args()

    bot_id = args.id
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    interval = int(cfg.get("interval_sec", 60))
    strategy_name = cfg.get("strategy", "demo")

    _write_state(bot_id, status="starting", pid_note="runner up", tick_count=0)

    try:
        StrategyCls = _load_strategy(strategy_name)
    except Exception as e:
        _write_state(bot_id, status="error", error=f"strategy-load: {e}")
        print(f"[{bot_id}] strategy load failed: {e}", file=sys.stderr)
        return 2

    try:
        strategy = StrategyCls(bot_id=bot_id, params=cfg.get("params", {}))
    except Exception as e:
        _write_state(bot_id, status="error", error=f"strategy-init: {e}")
        print(f"[{bot_id}] strategy init failed: {e}", file=sys.stderr)
        return 3

    _write_state(bot_id, status="running", strategy=strategy_name, error=None)
    print(f"[{bot_id}] running strategy={strategy_name} interval={interval}s", flush=True)

    tick_count = 0
    while _running:
        tick_count += 1
        try:
            result = strategy.tick() or {}
            _write_state(
                bot_id,
                status="running",
                tick_count=tick_count,
                last_tick=datetime.now().isoformat(),
                last_result=result,
            )
        except Exception as e:
            tb = traceback.format_exc()
            _write_state(bot_id, status="error", error=str(e), traceback=tb)
            print(f"[{bot_id}] tick error: {e}\n{tb}", file=sys.stderr, flush=True)
            # Weiterlaufen – Fehler killt den Bot nicht sofort.
        # sleep in kleinen Schritten, damit wir schnell auf STOP reagieren
        for _ in range(interval):
            if not _running:
                break
            time.sleep(1)

    _write_state(bot_id, status="stopped", last_tick=datetime.now().isoformat())
    print(f"[{bot_id}] stopped cleanly", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
