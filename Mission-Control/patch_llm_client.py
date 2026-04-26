import sys
import re

path = r'C:\Users\Robin\Jarvis\Mission-Control\llm_client.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update mapping
old_mapping = r'\"auto-gemini-3\": \"Gemini 3 Flash \(Auto\)\"'
new_mapping = r'\"auto-gemini-3\": \"Gemini 3 Flash (Auto)\",\n        \"openclaw\": \"OpenClaw Agent (Primary)\",'
content = content.replace(old_mapping, new_mapping)

# 2. Add OpenClawProvider before ClaudeCLIProvider
insertion = r'''# ============================================================================
# 4b. OpenClaw-Provider (Wrapper um OpenClaw Agent CLI / Gateway)
# ============================================================================

def _resolve_openclaw_exe() -> str:
    import shutil
    resolved = shutil.which("openclaw")
    if resolved:
        return resolved
    if os.name == "nt":
        candidate = os.path.expandvars(r"%APPDATA%\npm\openclaw.cmd")
        if os.path.exists(candidate):
            return candidate
    return "openclaw"


class OpenClawProvider(LLMProvider):
    """Wrapper um openclaw agent --json CLI.
    
    Das ermöglicht MC den Zugriff auf den vollen OpenClaw-Agent-Stack (Skills,
    Memory, Multi-Channel-Routing). Da ein Agent-Turn eine autonome Schleife
    ist, liefert dieser Provider das Ergebnis typischerweise als einen
    großen Text-Block am Ende (ähnlich codex-cli), statt token-weise.

    provider_kwargs:
      - profile: str (default "clean") -> --profile <name>
      - agent_id: str (default "main") -> --agent <id>
      - session_id: str -> --session-id <id>
      - thinking: str -> --thinking off|minimal|low|medium|high|xhigh
      - cwd: str (default Jarvis-Root)
    """

    name = "openclaw"
    requires_model = False
    supports_resume = True
    supports_native_tools = True
    streams_incremental_text = False
    supports_images = True

    async def stream(
        self,
        *,
        model: str,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolDefinition] | None = None,
        max_tokens: int = 4096,
        temperature: float | None = None,
        **provider_kwargs: Any,
    ) -> AsyncIterator[StreamEvent]:
        profile: str = provider_kwargs.get("profile", "clean")
        agent_id: str = provider_kwargs.get("agent_id", "main")
        session_id: str | None = provider_kwargs.get("session_id")
        thinking: str | None = provider_kwargs.get("thinking")
        cwd: str = provider_kwargs.get("cwd", r"C:\Users\Robin\Jarvis")

        prompt_text = ""
        if messages:
            last = messages[-1]
            blocks = last.content_as_blocks()
            prompt_text = " ".join(b.text for b in blocks if isinstance(b, TextBlock))

        exe = _resolve_openclaw_exe()
        cmd = [exe, "--profile", profile, "agent", "--json"]
        if agent_id:
            cmd.extend(["--agent", agent_id])
        if session_id:
            cmd.extend(["--session-id", session_id])
        if thinking:
            cmd.extend(["--thinking", thinking])
        if prompt_text:
            cmd.extend(["--message", prompt_text])

        subprocess_flags = 0
        if os.name == "nt":
            subprocess_flags = 0x08000000

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                limit=10 * 1024 * 1024,
                creationflags=subprocess_flags,
            )
        except Exception as e:
            yield ErrorEvent(message=f"OpenClaw spawn failed: {e}", code="spawn_failed")
            return

        stdout, stderr = await proc.communicate()
        
        if proc.returncode != 0:
            err_text = stderr.decode("utf-8", errors="replace").strip()
            yield ErrorEvent(message=f"OpenClaw failed (exit {proc.returncode}): {err_text}", code="agent_failed")
            return

        try:
            output = stdout.decode("utf-8", errors="replace").strip()
            start_idx = output.find('{')
            if start_idx != -1:
                output = output[start_idx:]
            
            res = json.loads(output)
            payloads = res.get("payloads", [])
            full_text = ""
            for p in payloads:
                if p.get("text"):
                    full_text += p["text"] + "\n"
            
            if full_text:
                yield TextDelta(text=full_text.strip())
            
            meta = res.get("meta", {})
            agent_meta = meta.get("agentMeta", {})
            usage = agent_meta.get("lastCallUsage", {})
            
            yield UsageEvent(
                input_tokens=usage.get("input", 0),
                output_tokens=usage.get("output", 0),
                cache_read_tokens=usage.get("cacheRead", 0),
                cache_creation_tokens=usage.get("cacheWrite", 0),
            )
            
            model_used = agent_meta.get("model", "openclaw")
            yield MetadataEvent(model=_humanize_model_name("openclaw", model_used))
            
        except Exception as e:
            yield ErrorEvent(message=f"OpenClaw parse failed: {e}", code="parse_failed")

        yield MessageStop(stop_reason="end_turn")


'''

content = content.replace('class ClaudeCLIProvider', insertion + 'class ClaudeCLIProvider')

# 3. Update PROVIDER_NAMES
content = content.replace('PROVIDER_NAMES = (', 'PROVIDER_NAMES = ("openclaw", ')

# 4. Update _get_provider
registry_insertion = r'''        if name == "openclaw":
            _PROVIDERS[name] = OpenClawProvider()
        elif name == "claude-api":'''
content = content.replace('if name == "claude-api":', registry_insertion)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied successfully")
