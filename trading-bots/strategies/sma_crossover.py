"""SMA-Crossover Strategie (Alpaca Paper, stdlib only).

Kurze vs. lange Simple Moving Average auf Minuten-Bars.
- short SMA kreuzt long SMA von unten  -> BUY-Signal
- short SMA kreuzt long SMA von oben   -> SELL-Signal
- sonst                                -> HOLD

Orders werden nur platziert, wenn params["live"] == True.
Per Default nutzt die Strategie das Alpaca Paper-Endpoint aus
secrets/alpaca-paper-cred.json -> auch bei "live": true bleibt es Papertrading,
solange der Endpoint paper-api.alpaca.markets ist.

Params:
    symbol        (str)   Ticker, Default "SPY"
    qty           (int)   Ordergroesse in Shares, Default 1
    short_window  (int)   Bars fuer kurzen SMA, Default 5
    long_window   (int)   Bars fuer langen SMA,  Default 20
    timeframe     (str)   Alpaca-Timeframe ("1Min","5Min","15Min","1Hour","1Day"),
                          Default "5Min"
    live          (bool)  Wenn True -> echter Order-Versand (Paper-Acc), sonst dry-run
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SECRETS = Path("C:/Users/Robin/Jarvis/secrets")
_STATE_DIR = Path(__file__).parent.parent / "state"
CRED_FILES = ("alpaca-paper-cred.json", "alpaca-cred.json")
DATA_BASE = "https://data.alpaca.markets/v2"


def _load_creds() -> dict:
    for name in CRED_FILES:
        p = SECRETS / name
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"Kein Alpaca-Cred in {SECRETS}")


def _headers(creds: dict) -> dict:
    return {
        "APCA-API-KEY-ID": creds.get("api_key") or creds.get("key_id", ""),
        "APCA-API-SECRET-KEY": creds.get("api_secret") or creds.get("secret_key", ""),
        "Accept": "application/json",
    }


def _http_get(url: str, headers: dict, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post(url: str, headers: dict, payload: dict, timeout: float = 10.0) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={**headers, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _sma(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


class Strategy:
    def __init__(self, bot_id: str, params: dict) -> None:
        self.bot_id = bot_id
        self.params = params or {}
        self.symbol = str(self.params.get("symbol", "SPY")).upper()
        self.qty = int(self.params.get("qty", 1))
        self.short_w = int(self.params.get("short_window", 5))
        self.long_w = int(self.params.get("long_window", 20))
        self.timeframe = str(self.params.get("timeframe", "5Min"))
        self.live = bool(self.params.get("live", False))

        if self.short_w >= self.long_w:
            raise ValueError("short_window must be < long_window")

        self.creds = _load_creds()
        self.headers = _headers(self.creds)
        # Trading-Endpoint: sicherstellen dass /v2 drin ist
        base = self.creds.get("endpoint") or self.creds.get("base_url") or "https://paper-api.alpaca.markets"
        if not base.endswith("/v2"):
            base = base.rstrip("/") + "/v2"
        self.trade_base = base

        # Letzter SMA-Diff fuer Cross-Detection
        self._prev_diff: float | None = None
        # Trade-Returns fuer Sortino (in-memory + State)
        self._entry_price: float | None = None
        self._returns: list[float] = self._load_returns()

    def _load_returns(self) -> list[float]:
        p = _STATE_DIR / f"{self.bot_id}.state.json"
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("returns", []) if p.exists() else []
        except Exception:
            return []

    def _persist_returns(self) -> None:
        p = _STATE_DIR / f"{self.bot_id}.state.json"
        try:
            data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        except Exception:
            data = {}
        data["returns"] = self._returns
        p.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _fetch_bars(self) -> list[float]:
        """Zieh die letzten N Closes fuer self.symbol."""
        # Tage-Lookback gross genug, damit auch ausserhalb Handelszeiten/am WE
        # genug historische Bars da sind.
        days_back = {
            "1Min": 3, "5Min": 5, "15Min": 10, "1Hour": 20, "1Day": 400,
        }.get(self.timeframe, 5)
        end = datetime.now(timezone.utc) - timedelta(minutes=16)  # IEX 15min-Delay
        start = end - timedelta(days=days_back)

        params = {
            "timeframe": self.timeframe,
            "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "limit": str(max(self.long_w + 10, 100)),
            "feed": "iex",  # Free-Tier kompatibel
            "adjustment": "raw",
        }
        url = f"{DATA_BASE}/stocks/{self.symbol}/bars?{urllib.parse.urlencode(params)}"
        data = _http_get(url, self.headers)
        bars = data.get("bars", []) or []
        closes = [float(b["c"]) for b in bars if "c" in b]
        return closes

    def _place_order(self, side: str) -> dict:
        payload = {
            "symbol": self.symbol,
            "qty": str(self.qty),
            "side": side,
            "type": "market",
            "time_in_force": "day",
        }
        return _http_post(f"{self.trade_base}/orders", self.headers, payload)

    def tick(self) -> dict:
        ts = datetime.now().isoformat()
        try:
            closes = self._fetch_bars()
        except urllib.error.HTTPError as e:
            return {"ts": ts, "error": f"http {e.code}", "symbol": self.symbol}
        except Exception as e:
            return {"ts": ts, "error": f"bars: {e}", "symbol": self.symbol}

        if len(closes) < self.long_w:
            return {
                "ts": ts, "symbol": self.symbol, "signal": "hold",
                "note": f"warmup: {len(closes)}/{self.long_w} bars",
            }

        short_sma = _sma(closes[-self.short_w:])
        long_sma = _sma(closes[-self.long_w:])
        diff = short_sma - long_sma
        prev = self._prev_diff
        self._prev_diff = diff

        signal = "hold"
        if prev is not None:
            if prev <= 0 < diff:
                signal = "buy"
            elif prev >= 0 > diff:
                signal = "sell"

        result: dict = {
            "ts": ts,
            "symbol": self.symbol,
            "price": closes[-1],
            "short_sma": round(short_sma, 4),
            "long_sma": round(long_sma, 4),
            "diff": round(diff, 4),
            "signal": signal,
            "live": self.live,
            "bars": len(closes),
        }

        # Trade-Return Tracking (buy→sell Roundtrip)
        price = closes[-1]
        if signal == "buy" and self._entry_price is None:
            self._entry_price = price
        elif signal == "sell" and self._entry_price is not None:
            ret = (price - self._entry_price) / self._entry_price
            self._returns.append(round(ret, 6))
            self._entry_price = None
            self._persist_returns()

        if signal in ("buy", "sell") and self.live:
            try:
                order = self._place_order(signal)
                result["order_id"] = order.get("id")
                result["order_status"] = order.get("status")
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8")[:200]
                except Exception:
                    pass
                result["order_error"] = f"http {e.code}: {body}"
            except Exception as e:
                result["order_error"] = str(e)

        return result
