"""heartbeat.py — autonomer Jarvis-Main-Agent mit periodischem Heartbeat.

Nach dem OpenClaw-Pattern (`agents.defaults.heartbeat.every = "30m"`): eine
**persistente Main-Session** mit fester Identity, die **alle N Minuten
autonom aufgewacht** wird — ohne User-Prompt — und selbstständig entscheidet,
was zu tun ist (TODOs prüfen, Kalender, Memory konsolidieren, Notifications
feuern, Skills aktivieren, usw.).

Konfiguration in `config.json → heartbeat`:

    {
      "heartbeat": {
        "enabled": true,
        "interval_minutes": 30,
        "boot_delay_seconds": 120,
        "provider": "claude-cli",
        "model": "sonnet",
        "autonomy": "high",
        "push_enabled": true,
        "max_tick_history": 20,
        "cron_jobs": [
          {"name": "morning-briefing", "time": "08:00", "prompt": "..."},
          {"name": "evening-review",    "time": "22:00", "prompt": "..."}
        ]
      }
    }

Autonomy-Levels (via System-Prompt):
  - "read-only":  darf nur lesen & loggen
  - "notify":     darf zusätzlich Push-Notifications senden
  - "high":       darf außerdem Files/Memory/Skills ändern (via MCP-Tools)

Die Main-Session hat immer die ID `jarvis-main` und überlebt MC-Neustarts.
Tick-Events werden als `heartbeat.tick` WebSocket-Event broadcastet damit
das Dashboard-Panel sie live sehen kann.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable


MAIN_SESSION_ID = "jarvis-main"
HEARTBEAT_SESSION_ID = "jarvis-heartbeat"
_STATE_FILE = Path(__file__).resolve().parent / "data" / "heartbeat-state.json"


_IDENTITY_TEMPLATE = """\
Du bist **Jarvis-Main** — der autonome Orchestrator-Agent von Robin Mandel.

ROLLE:
Du läufst 24/7 im Hintergrund von Mission Control. Alle {interval} Minuten wirst
du automatisch aufgewacht ("Heartbeat") und bekommst einen Status-Report über
Robins System. Zusätzlich triggerst du die konfigurierten Cron-Jobs zu festen
Uhrzeiten.

AUFGABEN:
1. Status-Check: MC-Health, offene Sessions, aktive Streams prüfen
2. Memory-Konsolidierung: Neue Erkenntnisse aus aktuellen Chats in den Vault
   integrieren (wenn autonomy >= high)
3. Proaktive Assistenz: Kalender-Termine, TODOs, offene Fragen erkennen
4. Notifications: bei wirklich wichtigen Dingen Push senden (ntfy.sh via
   send_push-Tool)
5. Research: offene Dissertations-/OSCE-Fragen durchdenken, Notizen machen

AUTONOMIE-LEVEL: **{autonomy}**
  - "read-only": nur beobachten und loggen. Keine Actions.
  - "notify":    du DARFST `send_push` aufrufen für wichtige Dinge.
  - "high":      du DARFST außerdem Memory-Files ändern, Skills aktivieren,
                 Dateien schreiben — autonom handeln wie ein selbstständiger
                 Assistent.

PRINZIPIEN:
- **Signal-to-Noise**: nur bei realer Relevanz handeln. Lieber "OK" antworten
  als unnötige Actions.
- **Push-Hygiene**: maximal 1-2 Pushes pro Tag, nur bei zeitkritischen Dingen
  (Termin in 30min, dringende Mail, …).
- **Knappe Antworten**: im Heartbeat-Turn ist kein User da — antworte kurz,
  strukturiert, als internes Protokoll.
- **Transparenz**: jede Action die du triggerst, auch im Antwort-Text
  dokumentieren (damit Robin sie im Heartbeat-Log sieht).

TOOLS (via jarvis-MCP verfügbar):
  vault_search, vault_read_bundle, memory_read, memory_list,
  anki_list_decks, mc_health, skills_list, skill_get, skill_activate,
  generate_image

Antwort-Format:
  STATUS: <kurz einschätzen>
  AKTIONEN: <was getan wurde, oder "keine">
  HINWEIS: <optional — was Robin wissen sollte>
"""


class HeartbeatManager:
    """Persistent, configurable heartbeat loop for the Jarvis-Main orchestrator
    agent. Runs as a single asyncio task inside the MC server process.
    """

    def __init__(
        self,
        config: dict,
        sessions: Any,                      # SessionManager
        invoke_llm_oneshot: Callable,       # async (provider, model, msg, system) → (text, usage, err)
        broadcast_all: Callable,            # async (dict) → None
        build_system_prompt: Callable,      # () → str (MC's full identity prompt)
        send_push: Callable | None = None,  # sync (title, msg, **kw) → bool
    ):
        self.config = dict(config or {})
        self.sessions = sessions
        self.invoke_llm = invoke_llm_oneshot
        self.broadcast = broadcast_all
        self.build_system = build_system_prompt
        self.send_push = send_push

        self._task: asyncio.Task | None = None
        self._loop_running = False
        self._last_health_status: dict = {}

        self.last_tick: datetime | None = None
        self.next_tick_eta: datetime | None = None
        self.tick_history: list[dict] = []  # letzte N Ticks
        self._cron_last_fired: dict[str, str] = {}  # job_name → "YYYY-MM-DD HH:MM"
        self._load_state()
        self._migrate_main_to_heartbeat()

    # -- Config-Helpers -------------------------------------------------------

    def is_enabled(self) -> bool:
        return bool(self.config.get("enabled", False))

    def interval_seconds(self) -> int:
        return int(self.config.get("interval_minutes", 30)) * 60

    def autonomy(self) -> str:
        return str(self.config.get("autonomy", "notify")).lower()

    def provider(self) -> str:
        return str(self.config.get("provider", "claude-cli"))

    def model(self) -> str:
        return str(self.config.get("model", ""))

    def max_history(self) -> int:
        return int(self.config.get("max_tick_history", 20))

    def cron_jobs(self) -> list[dict]:
        jobs = self.config.get("cron_jobs") or []
        return [j for j in jobs if isinstance(j, dict) and j.get("name") and j.get("time")]

    def update_config(self, patch: dict) -> dict:
        """Merged Config-Update. Wirkt ab nächstem Tick."""
        self.config.update(patch or {})
        return dict(self.config)

    # -- Persistenter State (last_tick übersteht MC-Neustarts) ----------------

    def _load_state(self) -> None:
        if not _STATE_FILE.exists():
            return
        try:
            d = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
            lt = d.get("last_tick")
            if lt:
                try: self.last_tick = datetime.fromisoformat(lt)
                except Exception: pass
            cf = d.get("cron_last_fired")
            if isinstance(cf, dict):
                self._cron_last_fired = {str(k): str(v) for k, v in cf.items()}
        except Exception as e:
            print(f"[Heartbeat] state load failed: {e}")

    def _save_state(self) -> None:
        try:
            _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            _STATE_FILE.write_text(json.dumps({
                "last_tick": self.last_tick.isoformat() if self.last_tick else None,
                "cron_last_fired": self._cron_last_fired,
            }, indent=2), encoding="utf-8")
        except Exception as e:
            print(f"[Heartbeat] state save failed: {e}")

    def _migrate_main_to_heartbeat(self) -> None:
        """Einmalige Migration: alle _heartbeat=True History-Eintraege aus
        jarvis-main raus, in jarvis-heartbeat rein. Laeuft idempotent — wenn
        in jarvis-main keine Heartbeat-Eintraege mehr sind, no-op."""
        try:
            main = self.sessions.sessions.get(MAIN_SESSION_ID)
            if not main or not getattr(main, "history", None):
                return
            hb_entries = [h for h in main.history if h.get("_heartbeat")]
            if not hb_entries:
                return
            hb_session = self.sessions.get_or_create(HEARTBEAT_SESSION_ID)
            existing_keys = {(h.get("role"), h.get("content")) for h in hb_session.history}
            for h in hb_entries:
                key = (h.get("role"), h.get("content"))
                if key in existing_keys: continue
                hb_session.history.append(h)
            hb_session.message_count = len(hb_session.history)
            if hb_session.history:
                last = hb_session.history[-1]
                ts = last.get("ts") or datetime.now().isoformat()
                hb_session.last_message = ts
            main.history = [h for h in main.history if not h.get("_heartbeat")]
            main.message_count = len(main.history)
            self.sessions.persist()
            print(f"[Heartbeat] migrated {len(hb_entries)} tick entries from jarvis-main → jarvis-heartbeat")
        except Exception as e:
            print(f"[Heartbeat] migration failed: {e}")

    # -- Lifecycle ------------------------------------------------------------

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        if not self.is_enabled():
            print("[Heartbeat] disabled via config — not starting")
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name="jarvis-heartbeat")
        print(f"[Heartbeat] started — interval={self.interval_seconds()}s, "
              f"autonomy={self.autonomy()}, cron_jobs={len(self.cron_jobs())}")

    async def stop(self) -> None:
        self._stopping = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def trigger_now(self, reason: str = "manual") -> dict:
        """Manuell einen Tick auslösen (für UI-Button oder Debug)."""
        return await self._tick(reason=reason)

    # -- Main Loop ------------------------------------------------------------

    async def _loop(self) -> None:
        # Warm-up delay damit MC-Boot nicht durch den ersten Tick belastet wird.
        # Wenn ein persistenter last_tick existiert, statt nur boot_delay den
        # tatsaechlich verbleibenden Rest bis zum naechsten regulaeren Tick warten —
        # damit haeufige MC-Restarts nicht jedesmal einen frischen Tick triggern.
        boot_delay = int(self.config.get("boot_delay_seconds", 120))
        interval = self.interval_seconds()
        if self.last_tick:
            elapsed = (datetime.now() - self.last_tick).total_seconds()
            wait = max(boot_delay, interval - elapsed)
            print(f"[Heartbeat] last_tick {int(elapsed)}s ago — waiting {int(wait)}s before next tick")
        else:
            wait = boot_delay
        try:
            await asyncio.sleep(wait)
        except asyncio.CancelledError:
            return

        while not self._stopping:
            try:
                # Cron-Jobs prüfen BEVOR der periodische Tick läuft.
                # Ein Cron-Match ersetzt den periodischen Tick (spart Tokens).
                fired = await self._check_cron_jobs()
                if not fired:
                    await self._tick(reason="periodic")
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Heartbeat] tick error: {type(e).__name__}: {e}")

            interval = self.interval_seconds()
            self.next_tick_eta = datetime.now() + timedelta(seconds=interval)
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break

    # -- Cron -----------------------------------------------------------------

    async def _check_cron_jobs(self) -> bool:
        """Simple HH:MM-matching. Feuert ein Job wenn aktuelle Zeit ±2 Min
        einem cron_jobs[*].time entspricht und er heute noch nicht gefeuert hat.
        """
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        fired_any = False

        for job in self.cron_jobs():
            name = job["name"]
            try:
                job_h, job_m = [int(x) for x in str(job["time"]).split(":")]
            except Exception:
                continue
            job_time = now.replace(hour=job_h, minute=job_m, second=0, microsecond=0)
            delta = abs((now - job_time).total_seconds())
            if delta > 120:  # außerhalb 2-Minuten-Fenster
                continue
            last_fired = self._cron_last_fired.get(name)
            if last_fired and last_fired.startswith(today):
                continue  # schon heute gefeuert

            self._cron_last_fired[name] = now.strftime("%Y-%m-%d %H:%M")
            self._save_state()

            if name.lower() == "auto-dream":
                await self.dream_cycle()
            else:
                await self._tick(reason=f"cron:{name}", extra_prompt=job.get("prompt"))
            
            fired_any = True

        return fired_any

    # -- Dream Cycle (Memory Consolidation) -----------------------------------

    async def get_today_sources(self) -> str:
        """Gather all information from today to consolidate (Sessions, Telegram, Research)."""
        today = datetime.now().strftime("%Y-%m-%d")
        parts = []

        # 1. Mission Control Sessions
        sessions_file = Path(__file__).resolve().parent / "data" / "sessions.json"
        if sessions_file.exists():
            try:
                sessions = json.loads(sessions_file.read_text(encoding="utf-8"))
                session_summaries = []
                for sid, s in sessions.items():
                    history = s.get("history", [])
                    if not history: continue
                    title = s.get("custom_title") or s.get("auto_title") or sid[:8]
                    user_msgs = [m["content"] for m in history if m.get("role") == "user"]
                    if not user_msgs: continue
                    session_summaries.append(f"- Session '{title}': {len(user_msgs)} Nachrichten")
                if session_summaries:
                    parts.append("## Mission Control Sessions (heute)")
                    parts.extend(session_summaries[:10])
            except Exception as e:
                print(f"[Dream] Error reading sessions: {e}")

        # 2. Telegram History
        tele_history_file = Path(__file__).resolve().parent.parent / "data" / "telegram-history.json"
        if tele_history_file.exists():
            try:
                history = json.loads(tele_history_file.read_text(encoding="utf-8"))
                if history:
                    parts.append("\n## Telegram-Gespraeche (heute)")
                    for entry in history[-20:]:  # Letzte 20
                        role = "Robin" if entry["role"] == "user" else "Jarvis"
                        parts.append(f"- {role}: {entry['text'][:200]}")
            except Exception: pass

        return "\n".join(parts)

    async def dream_cycle(self) -> None:
        """Nightly consolidation of raw logs into Obsidian Vault."""
        today = datetime.now().strftime("%Y-%m-%d")
        vault_path = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
        output_file = vault_path / f"{today}.md"
        
        print(f"[Dream] Starting Dream Cycle for {today}...")
        sources = await self.get_today_sources()
        if not sources.strip():
            print("[Dream] No sources found, skipping.")
            return

        prompt = f"Hier sind die Rohdaten des Tages für {today}:\n\n{sources}\n\nErstelle ein prägnantes Obsidian-Tageslog (Deutsch). Beinhalte Zusammenfassung, Aktivitäten, Erkenntnisse und Verknüpfungen ([[WikiLinks]])."
        
        try:
            from llm_client import invoke_llm, Message
            response_text = ""
            async for ev in invoke_llm(
                provider=self.provider(),
                model=self.model(),
                messages=[Message(role="user", content=prompt)],
                system="Du bist Jarvis-Main. Konsolidiere das Tagesgedächtnis prägnant.",
            ):
                if hasattr(ev, "text"):
                    response_text += ev.text
            
            if response_text.strip():
                vault_path.mkdir(parents=True, exist_ok=True)
                output_file.write_text(response_text.strip(), encoding="utf-8")
                print(f"[Dream] Successfully wrote day log to {output_file}")
                self.send_push(f"🌙 Dream Cycle abgeschlossen: {today}.md erstellt.", "Jarvis Memory")
            else:
                print("[Dream] LLM returned empty response.")
        except Exception as e:
            print(f"[Dream] Failed: {e}")

    # -- Tick -----------------------------------------------------------------

    async def _tick(self, *, reason: str, extra_prompt: str | None = None) -> dict:
        t0 = datetime.now()
        
        # Pre-flight Diagnostic: Check all LLM providers health
        from llm_client import check_all_providers_health
        health = await check_all_providers_health()
        self._last_health_status = health
        
        status_context = await self._build_status_context()
        
        # Add health status to status_context
        health_summary = "\n".join([f"  • {n}: {'✅ OK' if v['ok'] else '❌ ERROR (' + str(v['error']) + ')'}" for n, v in health.items()])
        status_context += f"\n\n--- LLM PROVIDER HEALTH ---\n{health_summary}"

        if extra_prompt:
            tick_message = (
                f"[Heartbeat · {reason} · {t0.strftime('%H:%M')}]\n\n"
                f"{status_context}\n\n"
                f"--- CRON-AUFTRAG ---\n{extra_prompt}"
            )
        else:
            tick_message = (
                f"[Heartbeat · {reason} · {t0.strftime('%H:%M')}]\n\n"
                f"{status_context}\n\n"
                "Prüfe den Zustand. Gibt es etwas zu tun?"
            )

        # Heartbeat-Ticks landen in der eigenen jarvis-heartbeat-Session, damit
        # Robin in jarvis-main mit Jarvis quatschen kann ohne dass die periodischen
        # Ticks die Konversation verschmutzen. Beide teilen sich die Identity.
        session = self.sessions.get_or_create(HEARTBEAT_SESSION_ID)
        session.provider = self.provider()
        session.model = self.model()
        if not session.custom_title:
            session.custom_title = "Jarvis · Heartbeat"
        if not session.topic:
            session.topic = "orchestrator"
            session.topic_color = "#a78bfa"
        # jarvis-main ist die interaktive Schwester — sicherstellen dass sie
        # existiert (Sidebar zeigt sie pinned, Robin kann sofort reinschreiben).
        main_sess = self.sessions.get_or_create(MAIN_SESSION_ID)
        if not main_sess.custom_title:
            main_sess.custom_title = "Jarvis · Main"
        if not main_sess.topic:
            main_sess.topic = "orchestrator"
            main_sess.topic_color = "#f59e0b"

        # System-Prompt aus Identity-Template + MC-Master-Prompt kombinieren
        identity = _IDENTITY_TEMPLATE.format(
            interval=self.config.get("interval_minutes", 30),
            autonomy=self.autonomy(),
        )
        try:
            mc_prompt = self.build_system()
        except Exception:
            mc_prompt = ""
        full_system = identity + "\n\n--- MC-IDENTITY ---\n" + mc_prompt

        # LLM-Call (non-streaming)
        try:
            answer, usage, err = await self.invoke_llm(
                provider=self.provider(),
                model=self.model(),
                user_message=tick_message,
                system=full_system,
            )
        except Exception as e:
            answer = ""
            usage = {}
            err = f"{type(e).__name__}: {e}"

        # In Session-History persistieren (damit im Chat-UI sichtbar)
        session.history.append({
            "role": "user",
            "content": f"[{reason} · {t0.strftime('%H:%M')}]",
            "_heartbeat": True,
        })
        session.history.append({
            "role": "assistant",
            "content": answer or f"[Fehler: {err}]",
            "_heartbeat": True,
        })
        session.message_count += 2
        session.last_message = datetime.now().isoformat()
        try:
            self.sessions.persist()
        except Exception:
            pass

        # Push wenn der Agent es explizit markiert und autonomy das erlaubt.
        # Einfache Heuristik: Antwort beginnt/enthält "PUSH:" → Rest ist Push-Message.
        if (
            self.autonomy() in ("notify", "high")
            and self.send_push
            and bool(self.config.get("push_enabled", True))
            and answer and "PUSH:" in answer
        ):
            try:
                push_line = answer.split("PUSH:", 1)[1].strip().split("\n", 1)[0]
                self.send_push(
                    title="Jarvis-Heartbeat",
                    message=push_line[:200],
                    priority=3,
                    tags=["brain"],
                )
            except Exception as e:
                print(f"[Heartbeat] push failed: {e}")

        # Tick-History pflegen
        entry = {
            "ts": t0.isoformat(),
            "reason": reason,
            "answer": (answer or "")[:800],
            "error": err,
            "duration_ms": int((datetime.now() - t0).total_seconds() * 1000),
            "usage": usage or {},
        }
        self.tick_history.append(entry)
        if len(self.tick_history) > self.max_history():
            self.tick_history = self.tick_history[-self.max_history():]
        self.last_tick = t0
        self._save_state()

        # Broadcast an UI
        try:
            await self.broadcast({
                "type": "heartbeat.tick",
                "ts": entry["ts"],
                "reason": reason,
                "preview": entry["answer"][:200],
                "error": err,
            })
        except Exception:
            pass

        print(f"[Heartbeat] tick done ({reason}, {entry['duration_ms']}ms)"
              + (f" — ERROR {err[:80]}" if err else ""))
        return entry

    # -- Status-Context -------------------------------------------------------

    async def _build_status_context(self) -> str:
        """Sammelt alles was der Main-Agent wissen muss um sinnvoll zu handeln."""
        parts: list[str] = []
        now = datetime.now()
        parts.append(f"TIME: {now.strftime('%Y-%m-%d %H:%M:%S')} ({now.strftime('%A')})")

        # MC-Sessions
        try:
            session_count = len(self.sessions.sessions)
            active_streams = sum(
                1 for s in self.sessions.sessions.values()
                if getattr(s, "_stream_active", False)
            )
            parts.append(f"MC: {session_count} sessions, {active_streams} active streams")
        except Exception:
            pass

        # TODOs aus projects.md / todos.md
        try:
            memory_dir = Path(__file__).parent / "data" / "memory"
            for fname in ("todos.md", "projects.md"):
                p = memory_dir / fname
                if p.exists():
                    text = p.read_text(encoding="utf-8", errors="replace")
                    # Nur open/TODO-Zeilen extrahieren
                    todos = [
                        ln.strip() for ln in text.splitlines()
                        if ln.strip().startswith(("- [ ]", "* [ ]", "TODO:", "- TODO"))
                    ]
                    if todos:
                        parts.append(f"OPEN ({fname}):")
                        for t in todos[:8]:
                            parts.append(f"  {t[:160]}")
        except Exception:
            pass

        # Letzte User-Messages aus aktiven Sessions (leichtes Signal was Robin beschäftigt)
        try:
            recent_user_msgs: list[str] = []
            for sid, s in list(self.sessions.sessions.items())[-5:]:
                if sid in (MAIN_SESSION_ID, HEARTBEAT_SESSION_ID):
                    continue
                if not s.history:
                    continue
                for h in reversed(s.history[-3:]):
                    if h.get("role") == "user" and h.get("content"):
                        recent_user_msgs.append(
                            f"  [{sid[:8]}] {str(h['content'])[:120]}"
                        )
                        break
            if recent_user_msgs:
                parts.append("RECENT USER MESSAGES:")
                parts.extend(recent_user_msgs[:5])
        except Exception:
            pass

        # Letzter Heartbeat
        if self.last_tick:
            delta_min = int((now - self.last_tick).total_seconds() / 60)
            parts.append(f"LAST HEARTBEAT: {delta_min} min ago")

        return "\n".join(parts)

    # -- Introspection --------------------------------------------------------

    def status_dict(self) -> dict:
        """Für UI/REST: aktueller Status zum Anzeigen."""
        return {
            "enabled": self.is_enabled(),
            "interval_minutes": int(self.config.get("interval_minutes", 30)),
            "autonomy": self.autonomy(),
            "provider": self.provider(),
            "model": self.model(),
            "last_tick": self.last_tick.isoformat() if self.last_tick else None,
            "next_tick_eta": self.next_tick_eta.isoformat() if self.next_tick_eta else None,
            "running": bool(self._task and not self._task.done()),
            "cron_jobs": self.cron_jobs(),
            "tick_history": list(self.tick_history[-10:]),
            "push_enabled": bool(self.config.get("push_enabled", True)),
        }
