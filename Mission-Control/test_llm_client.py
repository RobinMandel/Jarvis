"""Smoke-Tests für llm_client.py — provider-agnostische LLM-Abstraktion.

Läuft ohne Cloud-Calls wo möglich. CLI-Provider werden mit echtem Subprocess
getestet (brauchen funktionierendes claude.exe / codex / gemini im PATH und
Login); API-Provider werden gegen Konfigurationsfehler getestet.

Ausführung:
  python -m pytest test_llm_client.py -v
  python test_llm_client.py   (standalone, kein pytest nötig)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import asdict

# Windows-Konsole auf UTF-8 damit Arrow/Unicode-Chars aus Error-Messages
# (z.B. "Provider gewechselt: → …") nicht mit cp1252-Encode-Error crashen.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from llm_client import (
    Message,
    TextBlock,
    TextDelta,
    ToolUseStart,
    ToolUseEnd,
    ToolResultEvent,
    ToolDefinition,
    UsageEvent,
    MessageStop,
    ErrorEvent,
    PROVIDER_NAMES,
    get_provider_info,
    list_providers,
    invoke_llm,
    event_to_dict,
    AnthropicSDKProvider,
    ClaudeCLIProvider,
    CodexCLIProvider,
    GeminiCLIProvider,
    OpenAIProvider,
)


# --- Test-Infrastruktur --------------------------------------------------------

_results: list[tuple[str, bool, str]] = []


def test(name: str):
    """Decorator that runs an async test and records pass/fail."""
    def deco(fn):
        async def run():
            t0 = time.time()
            try:
                await fn()
                dt = int((time.time() - t0) * 1000)
                _results.append((name, True, f"{dt}ms"))
                print(f"  [OK]   {name} ({dt}ms)")
            except AssertionError as e:
                _results.append((name, False, str(e)))
                print(f"  [FAIL] {name}: {e}")
            except Exception as e:
                _results.append((name, False, f"{type(e).__name__}: {e}"))
                print(f"  [ERR]  {name}: {type(e).__name__}: {e}")
        return run
    return deco


# --- Tests --------------------------------------------------------------------

@test("PROVIDER_NAMES ist vollständig und deterministisch")
async def t_provider_names():
    assert len(PROVIDER_NAMES) == 6, f"erwartet 5 Provider, ist {len(PROVIDER_NAMES)}"
    expected = {"claude-cli", "claude-api", "codex-cli", "gemini-cli", "openai", "openclaw"}
    assert set(PROVIDER_NAMES) == expected, f"missing/extra: {set(PROVIDER_NAMES) ^ expected}"


@test("list_providers() gibt Capability-Flags pro Provider")
async def t_list_providers():
    infos = list_providers()
    assert len(infos) == 6
    # Jeder hat alle erforderlichen Felder
    keys = {"name", "requires_model", "supports_resume", "supports_native_tools",
            "streams_incremental_text", "supports_images"}
    for info in infos:
        assert keys.issubset(info.keys()), f"missing keys in {info['name']}: {keys - info.keys()}"
    # Konkrete Erwartungen
    by_name = {i["name"]: i for i in infos}
    assert by_name["claude-cli"]["requires_model"] is False
    assert by_name["claude-api"]["requires_model"] is True
    assert by_name["codex-cli"]["streams_incremental_text"] is False  # blockweise
    assert by_name["gemini-cli"]["streams_incremental_text"] is True
    assert by_name["openai"]["requires_model"] is True


@test("invoke_llm liefert ErrorEvent wenn API-Provider ohne Model aufgerufen wird")
async def t_model_required_api():
    events = []
    async for ev in invoke_llm(provider="claude-api", model="",
                                messages=[Message(role="user", content="hi")]):
        events.append(ev)
    assert len(events) == 1, f"expected 1 ErrorEvent, got {len(events)}"
    assert isinstance(events[0], ErrorEvent)
    assert events[0].code == "model_required"


@test("invoke_llm lässt CLI-Provider ohne Model durch (kein early-reject)")
async def t_model_optional_cli():
    # Wir rufen nur ab bis zum ersten Event mit Timeout damit der Test
    # keinen echten CLI-Roundtrip macht falls der Provider offline ist.
    events: list = []
    async def consume():
        async for ev in invoke_llm(provider="claude-cli", model="",
                                    messages=[Message(role="user", content="ping")]):
            events.append(ev)
            if len(events) >= 1:
                return

    try:
        await asyncio.wait_for(consume(), timeout=2.0)
    except asyncio.TimeoutError:
        pass  # OK — kein early-reject heißt Stream geht los

    # Wichtig: KEIN ErrorEvent(model_required) — das würde der Hard-Check werfen
    if events:
        first = events[0]
        if isinstance(first, ErrorEvent):
            assert first.code != "model_required", \
                "claude-cli sollte ohne Model NICHT als model_required failen"


@test("OpenAIProvider wirft ErrorEvent(not_configured) wenn Key fehlt")
async def t_openai_missing_key():
    # Env-Var explizit entfernen für diesen Test
    saved_key = os.environ.pop("OPENAI_API_KEY", None)
    try:
        events = []
        async for ev in invoke_llm(provider="openai", model="gpt-4o",
                                    messages=[Message(role="user", content="hi")]):
            events.append(ev)
        # Erstes Event sollte ErrorEvent mit not_configured sein
        assert events, "expected at least one event"
        err_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert err_events, f"expected ErrorEvent, got only {[type(e).__name__ for e in events]}"
        # Code ist entweder "not_configured" (key fehlt) oder openai-SDK-Fehler
        assert err_events[0].code in ("not_configured", "ImportError", "AuthenticationError"), \
            f"unexpected error code: {err_events[0].code}"
    finally:
        if saved_key:
            os.environ["OPENAI_API_KEY"] = saved_key


@test("Message normalisiert str und ContentBlock-Liste identisch")
async def t_message_normalisation():
    m1 = Message(role="user", content="hello")
    m2 = Message(role="user", content=[TextBlock(text="hello")])
    blocks1 = m1.content_as_blocks()
    blocks2 = m2.content_as_blocks()
    assert len(blocks1) == 1 and len(blocks2) == 1
    assert blocks1[0].text == blocks2[0].text == "hello"


@test("event_to_dict serialisiert alle Event-Typen ohne Exception")
async def t_event_to_dict():
    samples = [
        TextDelta(text="hi"),
        ToolUseStart(id="t1", name="Read"),
        ToolUseEnd(id="t1", name="Read", input={"path": "/tmp"}),
        ToolResultEvent(tool_use_id="t1", tool_name="Read", content="ok", is_error=False),
        MessageStop(stop_reason="end_turn"),
        UsageEvent(input_tokens=10, output_tokens=20),
        ErrorEvent(message="boom", code="test"),
    ]
    for ev in samples:
        d = event_to_dict(ev)
        assert isinstance(d, dict)
        assert d.get("type"), f"no type key in {d}"
        # Muss JSON-serialisierbar sein für WebSocket-Broadcast
        json.dumps(d)


@test("ClaudeCLIProvider._flatten_messages_to_stdin baut History-Block")
async def t_claude_flatten_history():
    p = ClaudeCLIProvider()
    msgs = [
        Message(role="user", content="frage 1"),
        Message(role="assistant", content="antwort 1"),
        Message(role="user", content="frage 2"),
    ]
    text = p._flatten_messages_to_stdin(msgs, system=None)
    assert "conversation_history" in text
    assert "Robin: frage 1" in text
    assert "Jarvis: antwort 1" in text
    assert text.endswith("frage 2")


@test("ClaudeCLIProvider: Single-User-Message → Klartext (kein History-Block)")
async def t_claude_flatten_single():
    p = ClaudeCLIProvider()
    text = p._flatten_messages_to_stdin([Message(role="user", content="hallo")], None)
    assert text == "hallo"
    assert "conversation_history" not in text


@test("Unknown Provider → ValueError aus _get_provider")
async def t_unknown_provider():
    try:
        get_provider_info("nonsense-provider")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "Unbekannter Provider" in str(e) or "unknown" in str(e).lower()


# --- Optional: echte Smoke-Tests gegen CLI-Provider (wenn login da) -----------

@test("claude-cli End-to-End Ping (benötigt claude.exe Login)")
async def t_claude_cli_smoke():
    events = []
    got_text = ""
    try:
        async for ev in invoke_llm(
            provider="claude-cli", model="haiku",
            messages=[Message(role="user", content="Antworte nur: pong")],
            system="Antworte exakt ein Wort auf Deutsch.",
            max_turns=1,
        ):
            events.append(ev)
            if isinstance(ev, TextDelta):
                got_text += ev.text
            if isinstance(ev, ErrorEvent):
                # Kein Login oder Rate-Limit → Test soft-skippt
                raise AssertionError(f"skip: {ev.code}: {ev.message[:100]}")
    except AssertionError as e:
        if "skip:" in str(e):
            print(f"     (skipped: {e})")
            return  # OK skip
        raise
    assert got_text, "expected some text"
    assert any(isinstance(e, MessageStop) for e in events)



@test("openclaw End-to-End Ping (benötigt OpenClaw Gateway oder CLI)")
async def t_openclaw_smoke():
    events = []
    got_text = ""
    try:
        async for ev in invoke_llm(
            provider="openclaw", model="",
            messages=[Message(role="user", content="Antworte nur: pong")],
            system="Antworte exakt ein Wort.",
            profile="clean",
        ):
            events.append(ev)
            if isinstance(ev, TextDelta):
                got_text += ev.text
    except Exception as e:
        print(f"     (openclaw error: {e})")
        return
    
    # Da OpenClaw ggf. offline ist oder Auth-Fehler hat, lassen wir den Test
    # weich durchgehen wenn ein ErrorEvent kommt.
    if any(isinstance(e, ErrorEvent) for e in events):
        err = [e for e in events if isinstance(e, ErrorEvent)][0]
        print(f"     (openclaw reported error: {err.code}: {err.message[:100]})")
        return

    assert got_text or any(isinstance(e, MessageStop) for e in events), "expected text or stop"


# --- Runner -------------------------------------------------------------------


async def main():
    print("=" * 60)
    print("llm_client smoke tests")
    print("=" * 60)

    tests = [
        t_provider_names,
        t_list_providers,
        t_model_required_api,
        t_model_optional_cli,
        t_openai_missing_key,
        t_message_normalisation,
        t_event_to_dict,
        t_claude_flatten_history,
        t_claude_flatten_single,
        t_unknown_provider,
        t_claude_cli_smoke,
        t_openclaw_smoke,
    ]

    for t in tests:
        await t()

    print("=" * 60)
    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"Ergebnis: {passed}/{total} bestanden")
    if passed < total:
        print("\nFehlgeschlagen:")
        for name, ok, msg in _results:
            if not ok:
                print(f"  - {name}: {msg}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
