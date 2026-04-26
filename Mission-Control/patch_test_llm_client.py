import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\test_llm_client.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update PROVIDER_NAMES check
content = content.replace('assert len(PROVIDER_NAMES) == 5', 'assert len(PROVIDER_NAMES) == 6')
content = content.replace('expected = {"claude-cli", "claude-api", "codex-cli", "gemini-cli", "openai"}', 'expected = {"claude-cli", "claude-api", "codex-cli", "gemini-cli", "openai", "openclaw"}')

# 2. Add OpenClaw smoke test
test_code = r'''
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
'''
content = content.replace('# --- Runner -------------------------------------------------------------------', test_code)

# 3. Add to main list
content = content.replace('t_claude_cli_smoke,', 't_claude_cli_smoke,\n        t_openclaw_smoke,')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Test patch applied successfully")
