"""Demo-Strategie: Heartbeat-only. Echter Alpaca-Zugriff kommt spaeter.

Vertrag:
    class Strategy:
        def __init__(self, bot_id: str, params: dict): ...
        def tick(self) -> dict: ...   # darf beliebig lang laufen, keine Endlosschleife

Strategies sollen nebenwirkungsarm sein: Orders nur wenn params["live"] == True.
"""
from __future__ import annotations

import random
from datetime import datetime


class Strategy:
    def __init__(self, bot_id: str, params: dict) -> None:
        self.bot_id = bot_id
        self.params = params or {}
        self.symbol = self.params.get("symbol", "SPY")
        self.live = bool(self.params.get("live", False))

    def tick(self) -> dict:
        # Platzhalter: waehlt zufaellig "signal", fuehrt aber nichts aus
        signal = random.choice(["hold", "hold", "hold", "buy", "sell"])
        return {
            "symbol": self.symbol,
            "signal": signal,
            "live": self.live,
            "ts": datetime.now().isoformat(),
            "note": "demo heartbeat; no orders placed",
        }
