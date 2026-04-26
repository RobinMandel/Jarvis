"""llm_client.py — Provider-agnostische LLM-Abstraktion für Mission Control.

Ziel: Ein einziger Entry-Point `invoke_llm()` für alle LLM-Calls in MC.
Der Rest von MC weiß nicht mehr ob Claude-CLI, Claude-SDK, OpenAI oder Gemini
antwortet — er konsumiert einen einheitlichen `StreamEvent`-Strom.

Architektur (siehe Jarvis-Architektur-Diskussion 2026-04-23):
  invoke_llm() → Provider.stream() → AsyncIterator[StreamEvent]

Format-Vorbild ist der Anthropic-SDK-Shape (expressiv mit typed ContentBlocks),
weil Downgrades zu OpenAI einfacher sind als umgekehrt. Tool-Use wird über
strukturierte ToolUseBlock/ToolResultBlock abgebildet — beide Provider
(Anthropic native, OpenAI über function-calling-Mapping) werden intern auf
diese Form normalisiert.

Provider-Registry (Stand 2026-04-23):
  - "claude-api"  → Anthropic-SDK (direkt, Text + Tools, ohne Subprocess)
  - "claude-cli"  → claude.exe-Subprocess (vollständig agentisch, MCP-Tools,
                    --resume, --permission-mode — für Chat/Arena-Execution)
  - "codex-cli"   → codex-Subprocess mit `exec --json`. Auth via ChatGPT-Account
                    (OAuth, kein API-Key). Liefert agent_message als ein Item
                    statt Chunk-Streaming, daher ein großer TextDelta pro Turn.
  - "gemini-cli"  → gemini-Subprocess mit `-o stream-json`. Auth via Google-
                    Account-OAuth (kein API-Key nötig auf Free-Tier). Liefert
                    Text chunk-weise mit delta:true, eigene Tools + MCP-Support.
  - "openai"      → OpenAI-SDK (braucht OPENAI_API_KEY; separate Rechnung zum
                    ChatGPT-Plus-Abo — Plus liefert keinen API-Key)
"""

from __future__ import annotations

import abc
import asyncio
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Union


# ============================================================================
# 1. Content-Blocks — neutrale Message-Bausteine (Anthropic-Shape-kompatibel)
# ============================================================================

@dataclass
class TextBlock:
    """Reiner Text-Inhalt."""
    text: str
    type: str = "text"


@dataclass
class ImageBlock:
    """Bild als base64 oder URL. media_type z.B. 'image/png'."""
    source: dict  # {type: "base64"|"url", data?: str, url?: str, media_type: str}
    type: str = "image"


@dataclass
class ToolUseBlock:
    """Assistant will ein Tool aufrufen. id wird später in ToolResultBlock referenziert."""
    id: str
    name: str
    input: dict
    type: str = "tool_use"


@dataclass
class ToolResultBlock:
    """Resultat eines Tool-Calls. tool_use_id referenziert den ToolUseBlock."""
    tool_use_id: str
    content: Union[str, list]  # str oder list[TextBlock|ImageBlock]
    is_error: bool = False
    type: str = "tool_result"


ContentBlock = Union[TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock]


@dataclass
class Message:
    """Eine Message im Dialog. content kann str (Convenience) oder list[ContentBlock] sein.

    role:    "user" oder "assistant". System-Prompt ist separater Arg zu invoke_llm().
    content: Plain-String (wird als TextBlock interpretiert) oder strukturierte Liste
             (für Tool-Use/Images). Anthropic-SDK-Convention.
    """
    role: Literal["user", "assistant"]
    content: Union[str, list[ContentBlock]]

    def content_as_blocks(self) -> list[ContentBlock]:
        """Normalisiert content auf list[ContentBlock]."""
        if isinstance(self.content, str):
            return [TextBlock(text=self.content)]
        return list(self.content)


# ============================================================================
# 2. Tool-Definition — neutrale Form, adapter-spezifisch übersetzt
# ============================================================================

@dataclass
class ToolDefinition:
    """Tool-Schema für Function-Calling / Tool-Use.

    input_schema ist JSON-Schema. Anthropic nimmt es direkt, OpenAI wrapt es in
    {type:"function", function:{name, description, parameters}}.
    """
    name: str
    description: str
    input_schema: dict  # JSON Schema


# ============================================================================
# 3. Stream-Events — einheitliches Output-Format quer über Provider
# ============================================================================

@dataclass
class TextDelta:
    """Neues Text-Fragment vom Modell. Wird pro Token/Chunk emittiert."""
    text: str
    type: str = "text_delta"


@dataclass
class ToolUseStart:
    """Modell beginnt einen Tool-Call. input ist noch leer/partial."""
    id: str
    name: str
    type: str = "tool_use_start"


@dataclass
class ToolUseDelta:
    """Incremental JSON-Input für laufenden Tool-Call."""
    id: str
    partial_json: str
    type: str = "tool_use_delta"


@dataclass
class ToolUseEnd:
    """Tool-Call komplett. Finales input ist parsed dict."""
    id: str
    name: str
    input: dict
    type: str = "tool_use_end"


@dataclass
class ToolResultEvent:
    """Result eines Tool-Calls (von Provider zu uns zurück, während Stream läuft).

    Bei claude-cli kommt das als "user"-event mit tool_result-block. Bei codex-cli
    typischerweise nicht separat — Codex nutzt seine Tools intern (shell, read_file)
    und fasst das Ergebnis direkt in den nächsten agent_message ein.

    content ist der raw String-Output des Tools (oder dict wenn strukturiert),
    is_error signalisiert ob das Tool einen Fehler gemeldet hat.
    """
    tool_use_id: str
    tool_name: str
    content: Any
    is_error: bool = False
    type: str = "tool_result"


@dataclass
class MessageStop:
    """Modell ist fertig mit dieser Response.

    stop_reason: "end_turn" (normal), "tool_use" (wartet auf Tool-Result),
                 "max_tokens", "stop_sequence".
    """
    stop_reason: str
    type: str = "message_stop"


@dataclass
class UsageEvent:
    """Token-Verbrauch (wenn Provider ihn liefert)."""
    input_tokens: int
    output_tokens: int
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0
    type: str = "usage"


@dataclass
class MetadataEvent:
    """Metadaten zum aktuellen Stream (z.B. echtes Modell)."""
    model: str
    type: str = "metadata"


@dataclass
class ErrorEvent:
    """Fehler während des Streams. message ist menschenlesbar, code optional."""
    message: str
    code: str = ""
    type: str = "error"


@dataclass
class ProviderRawEvent:
    """Fallback für Provider-spezifische Events die noch nicht übersetzt sind.
    Nicht im Hot-Path verwenden — nur Debug/Logging.
    """
    provider: str
    data: dict
    type: str = "provider_raw"


StreamEvent = Union[
    TextDelta, ToolUseStart, ToolUseDelta, ToolUseEnd, ToolResultEvent,
    MessageStop, UsageEvent, MetadataEvent, ErrorEvent, ProviderRawEvent,
]


def event_to_dict(event: StreamEvent) -> dict:
    """Serialisiert ein StreamEvent für WebSocket/JSON-Log."""
    # dataclasses.asdict wäre bequemer, aber ContentBlocks in ToolResult ist
    # nicht trivial. Wir machen explizit und kontrolliert.
    if isinstance(event, TextDelta):
        return {"type": "text_delta", "text": event.text}
    if isinstance(event, ToolUseStart):
        return {"type": "tool_use_start", "id": event.id, "name": event.name}
    if isinstance(event, ToolUseDelta):
        return {"type": "tool_use_delta", "id": event.id, "partial_json": event.partial_json}
    if isinstance(event, ToolUseEnd):
        return {"type": "tool_use_end", "id": event.id, "name": event.name, "input": event.input}
    if isinstance(event, ToolResultEvent):
        return {
            "type": "tool_result",
            "tool_use_id": event.tool_use_id,
            "tool_name": event.tool_name,
            "content": event.content,
            "is_error": event.is_error,
        }
    if isinstance(event, MessageStop):
        return {"type": "message_stop", "stop_reason": event.stop_reason}
    if isinstance(event, UsageEvent):
        return {
            "type": "usage",
            "input_tokens": event.input_tokens,
            "output_tokens": event.output_tokens,
            "cache_creation_tokens": event.cache_creation_tokens,
            "cache_read_tokens": event.cache_read_tokens,
        }
    if isinstance(event, MetadataEvent):
        return {"type": "metadata", "model": event.model}
    if isinstance(event, ErrorEvent):
        return {"type": "error", "message": event.message, "code": event.code}
    if isinstance(event, ProviderRawEvent):
        return {"type": "provider_raw", "provider": event.provider, "data": event.data}
    return {"type": "unknown"}


# ============================================================================
# 4. Helpers & Base
# ============================================================================

class ProviderNotConfigured(RuntimeError):
    """Provider ist installiert, aber nicht nutzbar (z.B. fehlender API-Key)."""
    pass


def _humanize_model_name(provider: str, model: str) -> str:
    """Mappt technische Modellnamen oder 'default' auf sprechende Namen."""
    m_lower = (model or "default").lower()
    
    if m_lower == "default" or not model:
        if provider == "claude-cli":
            return "Claude 3.5 Sonnet (Def)"
        if provider == "codex-cli":
            return "GPT-4o (Def)"
        if provider == "gemini-cli":
            return "Gemini 2.0 Flash (Def)"
        return "Auto (Default)"
    
    # Bekannte IDs schöner machen
    mapping = {
        "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
        "claude-3-5-sonnet-latest": "Claude 3.5 Sonnet",
        "claude-opus-4-7[1m]": "Claude Opus 4.7",
        "gpt-4o": "GPT-4o",
        "gpt-4o-mini": "GPT-4o Mini",
        "gemini-2.0-flash-exp": "Gemini 2.0 Flash",
        "auto-gemini-3": "Gemini 1.5 Flash (Auto)",
        "gemini-1.5-flash": "Gemini 1.5 Flash",
        "gemini-1.5-pro": "Gemini 1.5 Pro",
        "gemini-2.0-flash": "Gemini 2.0 Flash",
        "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
        "gemini-2.5-flash": "Gemini 2.5 Flash",
        "gemini-2.5-pro": "Gemini 2.5 Pro"
    }
    return mapping.get(m_lower, model)


class LLMProvider(abc.ABC):
    """Abstract Base. Konkrete Provider implementieren `stream()` als async generator."""

    name: str = "base"

    # --- Capabilities ---------------------------------------------------------
    # Diese Flags deklarieren, was der Provider kann. Frontend/Session soll die
    # UI-Logik an diesen Flags aufhängen, nicht an provider-Namen oder Event-Shapes.

    #: Braucht einen expliziten Model-String. API-Provider ja, CLI-Provider nehmen
    #: sonst ihren eigenen Account-Default.
    requires_model: bool = True

    #: Kann Sessions fortsetzen (`--resume <id>` / thread_id / ähnliches).
    #: API-Provider kennen kein Resume — Multi-Turn läuft über messages-Liste.
    supports_resume: bool = False

    #: Kann eigene Tools/Function-Calls ausführen. claude-api/openai via
    #: `tools=[ToolDefinition(...)]`, claude-cli via MCP + Built-ins. codex-cli
    #: nutzt interne Tools, aber nicht vom Aufrufer konfigurierbar → False.
    supports_native_tools: bool = False

    #: Liefert Text token-/chunk-weise (TextDelta-Stream ist fließend). Wenn
    #: False: Text kommt als ein großer Block pro Turn (z.B. codex-cli).
    streams_incremental_text: bool = True

    #: Kann ImageBlocks in Messages verarbeiten (Vision).
    supports_images: bool = False

    @abc.abstractmethod
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
        """Streamt eine Response. Yielded StreamEvent-Instanzen.

        provider_kwargs sind provider-spezifische Extras (z.B. cli_session_id,
        mcp_config, allowed_tools für Claude-CLI). Übliche Calls nutzen das nicht.
        """
        raise NotImplementedError
        yield  # pragma: no cover — macht die Methode zu einem async generator type

    async def ping(self) -> tuple[bool, str]:
        """Checkt die Erreichbarkeit des Providers (minimaler Turn).
        Returns: (success, error_message)
        """
        try:
            async for ev in self.stream(
                model="",  # Provider-Default
                messages=[Message(role="user", content="ping")],
                max_tokens=1,
            ):
                if isinstance(ev, ErrorEvent):
                    return False, ev.message
                if isinstance(ev, MessageStop):
                    return True, ""
            return True, ""
        except Exception as e:
            return False, str(e)


# ============================================================================
# 5. Anthropic-SDK-Provider (direkte API, text + tool-use, kein Subprocess)
# ============================================================================

class AnthropicSDKProvider(LLMProvider):
    """Ruft die Anthropic API direkt via `anthropic.AsyncAnthropic()` auf.

    Nutzt ANTHROPIC_API_KEY aus env. Für Text-Generation + Tool-Use ohne
    Subprocess-Overhead. Keine MCP-Tools — die gibt es nur über Claude-CLI.
    """

    name = "claude-api"
    requires_model = True               # Anthropic API erwartet expliziten Model-String
    supports_resume = False             # Multi-Turn läuft über messages-Liste
    supports_native_tools = True        # tools=[...] wird direkt durchgereicht
    streams_incremental_text = True     # SDK streamt TextDeltas
    supports_images = True              # Vision-fähig auf allen aktuellen Modellen

    def __init__(self):
        self._client = None
        self._client_lock = asyncio.Lock()

    async def _get_client(self):
        if self._client is not None:
            return self._client
        async with self._client_lock:
            if self._client is not None:
                return self._client
            try:
                import anthropic  # type: ignore
            except ImportError as e:
                raise ProviderNotConfigured("anthropic SDK nicht installiert (pip install anthropic)") from e
            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise ProviderNotConfigured("ANTHROPIC_API_KEY nicht gesetzt")
            self._client = anthropic.AsyncAnthropic()
        return self._client

    async def ping(self) -> tuple[bool, str]:
        try:
            client = await self._get_client()
            await client.messages.create(
                model="claude-3-haiku-20240307",
                max_tokens=1,
                messages=[{"role": "user", "content": "p"}],
            )
            return True, ""
        except Exception as e:
            return False, str(e)

    def _messages_to_sdk(self, messages: list[Message]) -> list[dict]:
        """Wandelt neutrale Messages in Anthropic-SDK-Form (trivial 1:1 da Shape gleich)."""
        out = []
        for m in messages:
            blocks = m.content_as_blocks()
            if len(blocks) == 1 and isinstance(blocks[0], TextBlock):
                out.append({"role": m.role, "content": blocks[0].text})
            else:
                sdk_content = []
                for b in blocks:
                    if isinstance(b, TextBlock):
                        sdk_content.append({"type": "text", "text": b.text})
                    elif isinstance(b, ImageBlock):
                        sdk_content.append({"type": "image", "source": b.source})
                    elif isinstance(b, ToolUseBlock):
                        sdk_content.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
                    elif isinstance(b, ToolResultBlock):
                        sdk_content.append({
                            "type": "tool_result",
                            "tool_use_id": b.tool_use_id,
                            "content": b.content,
                            "is_error": b.is_error,
                        })
                out.append({"role": m.role, "content": sdk_content})
        return out

    def _tools_to_sdk(self, tools: list[ToolDefinition] | None) -> list[dict] | None:
        if not tools:
            return None
        return [
            {"name": t.name, "description": t.description, "input_schema": t.input_schema}
            for t in tools
        ]

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
        client = await self._get_client()
        params: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": self._messages_to_sdk(messages),
        }
        if system:
            params["system"] = system
        tools_sdk = self._tools_to_sdk(tools)
        if tools_sdk:
            params["tools"] = tools_sdk
        if temperature is not None:
            params["temperature"] = temperature
        
        yield MetadataEvent(model=_humanize_model_name("claude-api", model))

        try:
            async with client.messages.stream(**params) as stream:
                active_tool_id: str | None = None
                active_tool_name: str | None = None
                active_tool_partial: str = ""
                async for raw in stream:
                    et = getattr(raw, "type", None)
                    if et == "content_block_start":
                        block = getattr(raw, "content_block", None)
                        if block is not None and getattr(block, "type", "") == "tool_use":
                            active_tool_id = block.id
                            active_tool_name = block.name
                            active_tool_partial = ""
                            yield ToolUseStart(id=active_tool_id, name=active_tool_name)
                    elif et == "content_block_delta":
                        delta = getattr(raw, "delta", None)
                        dt = getattr(delta, "type", "")
                        if dt == "text_delta":
                            yield TextDelta(text=getattr(delta, "text", ""))
                        elif dt == "input_json_delta" and active_tool_id:
                            partial = getattr(delta, "partial_json", "")
                            active_tool_partial += partial
                            yield ToolUseDelta(id=active_tool_id, partial_json=partial)
                    elif et == "content_block_stop":
                        if active_tool_id:
                            try:
                                final_input = json.loads(active_tool_partial or "{}")
                            except json.JSONDecodeError:
                                final_input = {}
                            yield ToolUseEnd(
                                id=active_tool_id,
                                name=active_tool_name or "",
                                input=final_input,
                            )
                            active_tool_id = None
                            active_tool_name = None
                            active_tool_partial = ""
                    elif et == "message_stop":
                        msg = getattr(stream, "current_message_snapshot", None) or getattr(raw, "message", None)
                        stop_reason = getattr(msg, "stop_reason", "end_turn") if msg else "end_turn"
                        usage = getattr(msg, "usage", None) if msg else None
                        if usage is not None:
                            yield UsageEvent(
                                input_tokens=getattr(usage, "input_tokens", 0) or 0,
                                output_tokens=getattr(usage, "output_tokens", 0) or 0,
                                cache_creation_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
                                cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                            )
                        yield MessageStop(stop_reason=stop_reason or "end_turn")
        except Exception as e:
            yield ErrorEvent(message=str(e), code=type(e).__name__)


# ============================================================================
# 6. Claude-CLI-Provider (subprocess, stream-json, full agentic mit MCP)
# ============================================================================

_CLAUDE_EXE = "claude"
_DEFAULT_CLI_CWD = "C:/Users/Robin/Jarvis"

class ClaudeCLIProvider(LLMProvider):
    name = "claude-cli"
    requires_model = False
    supports_resume = True
    supports_native_tools = True
    streams_incremental_text = True
    supports_images = True

    def _flatten_messages_to_stdin(self, messages: list[Message], system: str | None) -> str:
        if not messages:
            return ""
        if len(messages) == 1 and messages[0].role == "user":
            blocks = messages[0].content_as_blocks()
            if len(blocks) == 1 and isinstance(blocks[0], TextBlock):
                return blocks[0].text
        lines = []
        for m in messages[:-1]:
            role_label = "Robin" if m.role == "user" else "Jarvis"
            blocks = m.content_as_blocks()
            text = " ".join(b.text for b in blocks if isinstance(b, TextBlock))
            if text:
                if len(text) > 2000: text = text[:2000] + "...[gekürzt]"
                lines.append(f"{role_label}: {text}")
        last = messages[-1]
        last_text = " ".join(b.text for b in last.content_as_blocks() if isinstance(b, TextBlock))
        history_block = "\n\n".join(lines)
        if history_block:
            return f"<conversation_history>\n{history_block}\n</conversation_history>\n\nRobin: {last_text}"
        return last_text

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
        import tempfile
        cli_session_id = provider_kwargs.get("cli_session_id")
        mcp_config = provider_kwargs.get("mcp_config")
        max_turns = int(provider_kwargs.get("max_turns", 40))
        disallowed_tools = provider_kwargs.get("disallowed_tools", "")
        allowed_tools = provider_kwargs.get("allowed_tools", "")
        permission_mode = provider_kwargs.get("permission_mode", "")
        dangerous_skip = bool(provider_kwargs.get("dangerous_skip_permissions", True))
        cwd = provider_kwargs.get("cwd", _DEFAULT_CLI_CWD)
        on_cli_sid = provider_kwargs.get("on_cli_session_id")

        system_file = None
        if system:
            tmp_dir = Path(tempfile.gettempdir())
            system_file = tmp_dir / f"jarvis-sys-{os.getpid()}-{id(messages) & 0xffff:x}.txt"
            system_file.write_text(system, encoding="utf-8")

        # system_replace=True → --system-prompt-file (REPLACE Default Claude Code Identity).
        # Default ist append (ergaenzt die Claude-Code-Default-System-Prompt). REPLACE
        # brauchst du wenn du das Modell komplett umrolln willst (z.B. Image-Prompt-Enhancer
        # als reiner Prompt-Rewriter ohne Claude-Code-Persoenlichkeit).
        system_replace = bool(provider_kwargs.get("system_replace", False))
        sys_prompt_flag = "--system-prompt-file" if system_replace else "--append-system-prompt-file"

        cmd = [_CLAUDE_EXE, "-p", "--output-format", "stream-json", "--verbose", "--max-turns", str(max_turns)]
        if dangerous_skip: cmd.append("--dangerously-skip-permissions")
        if disallowed_tools: cmd.extend(["--disallowedTools", disallowed_tools])
        if allowed_tools: cmd.extend(["--allowedTools", allowed_tools])
        if permission_mode: cmd.extend(["--permission-mode", permission_mode])
        if system_file: cmd.extend([sys_prompt_flag, str(system_file)])
        if mcp_config: cmd.extend(["--mcp-config", str(mcp_config)])
        if cli_session_id: cmd.extend(["--resume", cli_session_id])
        if model: cmd.extend(["--model", model])

        stdin_text = self._flatten_messages_to_stdin(messages, system)
        subprocess_flags = 0x08000000 if os.name == "nt" else 0

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                stdin=asyncio.subprocess.PIPE,
                cwd=cwd,
                limit=1024 * 1024,
                creationflags=subprocess_flags,
            )
        except FileNotFoundError:
            yield ErrorEvent(message="claude.exe nicht gefunden (PATH prüfen)", code="cli_not_found")
            return
        except Exception as e:
            yield ErrorEvent(message=f"subprocess spawn failed: {e}", code="spawn_failed")
            return

        try:
            proc.stdin.write(stdin_text.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()
        except Exception as e:
            yield ErrorEvent(message=f"stdin write failed: {e}", code="stdin_failed")
            proc.kill()
            await proc.wait()
            return

        active_tool_name = ""
        stop_reason = "end_turn"
        text_chars_written = 0
        try:
            while True:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=300)
                if not line: break
                line_str = line.decode("utf-8", errors="replace").strip()
                if not line_str: continue
                try: raw_event = json.loads(line_str)
                except json.JSONDecodeError: continue
                et = raw_event.get("type", "")
                if et not in ("assistant", "user"):
                    print(f"[CLI-evt] type={et!r} keys={list(raw_event.keys())[:8]}")
                if et == "system":
                    if raw_event.get("subtype") == "init":
                        cli_sid = raw_event.get("session_id")
                        if (model_picked := raw_event.get("model")):
                            yield MetadataEvent(model=_humanize_model_name("claude-cli", model_picked))
                        if cli_sid and callable(on_cli_sid): on_cli_sid(cli_sid)
                elif et == "assistant":
                    msg = raw_event.get("message", {})
                    for block in msg.get("content", []):
                        bt = block.get("type", "")
                        if bt == "text":
                            if (txt := block.get("text", "")):
                                text_chars_written += len(txt)
                                yield TextDelta(text=txt)
                        elif bt == "tool_use":
                            active_tool_name = block.get("name", "")
                            yield ToolUseStart(id=block.get("id", ""), name=active_tool_name)
                            yield ToolUseEnd(id=block.get("id", ""), name=active_tool_name, input=block.get("input", {}))
                    # Per-turn usage damit Context-% live aktualisiert wird,
                    # statt erst am result-Event ganz am Ende. Bei Multi-Turn-
                    # Sessions (Tool-Loops) entsteht das Gefuehl: "Jarvis denkt 2min,
                    # Context bleibt 0% — bis zur Endantwort". Mit Per-Turn-Usage
                    # waechst der Balken sichtbar.
                    u = msg.get("usage")
                    if isinstance(u, dict):
                        yield UsageEvent(
                            input_tokens=int(u.get("input_tokens", 0)),
                            output_tokens=int(u.get("output_tokens", 0)),
                            cache_creation_tokens=int(u.get("cache_creation_input_tokens", 0)),
                            cache_read_tokens=int(u.get("cache_read_input_tokens", 0)),
                        )
                elif et == "user":
                    for block in raw_event.get("message", {}).get("content", []):
                        if block.get("type", "") == "tool_result":
                            yield ToolResultEvent(tool_use_id=block.get("tool_use_id", ""), tool_name=active_tool_name,
                                                   content=block.get("content", ""), is_error=bool(block.get("is_error", False)))
                elif et == "result":
                    raw_stop = raw_event.get("stop_reason") or "end_turn"
                    stop_reason = raw_stop  # "end_turn", "max_turns", "stop_sequence" etc.
                    usage = raw_event.get("usage") or {}
                    print(f"[CLI-result] usage={usage} keys={list(raw_event.keys())}")
                    in_tok = int(usage.get("input_tokens", 0))
                    out_tok = int(usage.get("output_tokens", 0))
                    cache_c = int(usage.get("cache_creation_input_tokens", 0))
                    cache_r = int(usage.get("cache_read_input_tokens", 0))
                    # Fallback: estimate from chars_written if CLI reports 0
                    if in_tok == 0 and out_tok == 0:
                        in_tok = max(1000, len(stdin_text) // 4)
                        out_tok = max(100, text_chars_written // 4)
                        print(f"[CLI-result] tokens were 0, estimated: in={in_tok} out={out_tok}")
                    yield UsageEvent(input_tokens=in_tok, output_tokens=out_tok,
                                     cache_creation_tokens=cache_c, cache_read_tokens=cache_r)
        except asyncio.TimeoutError: yield ErrorEvent(message="CLI timeout", code="timeout")
        finally:
            if proc.returncode is None:
                try: await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError: proc.kill(); await proc.wait()
            if system_file and system_file.exists(): system_file.unlink()
        yield MessageStop(stop_reason=stop_reason)

    async def ping(self) -> tuple[bool, str]:
        import shutil
        return (bool(shutil.which(_CLAUDE_EXE)), "" if shutil.which(_CLAUDE_EXE) else "claude.exe not found")


# ============================================================================
# 7. Codex-CLI-Provider
# ============================================================================

def _resolve_codex_exe() -> str:
    import shutil
    resolved = shutil.which("codex")
    if resolved: return resolved
    if os.name == "nt":
        for c in [os.path.expandvars(r"%APPDATA%\npm\codex.cmd"), os.path.expandvars(r"%APPDATA%\npm\codex")]:
            if os.path.exists(c): return c
    return "codex"

def _codex_is_logged_in() -> bool:
    codex_home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    auth = Path(codex_home) / "auth.json"
    return auth.exists() and auth.stat().st_size > 10

_CODEX_EXE: str | None = None

class CodexCLIProvider(LLMProvider):
    name = "codex-cli"
    requires_model = False
    supports_resume = True
    supports_native_tools = False
    streams_incremental_text = False
    supports_images = True

    def _flatten_messages_to_prompt(self, messages: list[Message]) -> str:
        if not messages: return ""
        lines = []
        for m in messages[:-1]:
            text = " ".join(b.text for b in m.content_as_blocks() if isinstance(b, TextBlock))
            lines.append(f"{'User' if m.role == 'user' else 'Assistant'}: {text[:2000]}")
        last_text = " ".join(b.text for b in messages[-1].content_as_blocks() if isinstance(b, TextBlock))
        return f"<conversation_history>\n{chr(10).join(lines)}\n</conversation_history>\n\nUser: {last_text}"

    async def stream(self, *, model: str, messages: list[Message], system: str | None = None, **kwargs) -> AsyncIterator[StreamEvent]:
        prompt_text = self._flatten_messages_to_prompt(messages)
        if system: prompt_text = f"<system>\n{system}\n</system>\n\n{prompt_text}"
        global _CODEX_EXE
        if _CODEX_EXE is None: _CODEX_EXE = _resolve_codex_exe()
        if not _codex_is_logged_in(): yield ErrorEvent(message="codex not logged in", code="not_logged_in"); return
        yield MetadataEvent(model=_humanize_model_name("codex-cli", model))
        cmd = [_CODEX_EXE, "exec", "--json", "--skip-git-repo-check", "-"]
        if model: cmd.extend(["-m", model])
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.PIPE, creationflags=0x08000000 if os.name == "nt" else 0)
        proc.stdin.write(prompt_text.encode("utf-8")); await proc.stdin.drain(); proc.stdin.close()
        got_text = False
        api_error: str | None = None
        try:
            while True:
                line = await proc.stdout.readline()
                if not line: break
                try: evt = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError: continue
                et = evt.get("type", "")
                if et == "item.completed":
                    item = evt.get("item", {})
                    if item.get("type") == "agent_message":
                        got_text = True
                        yield TextDelta(text=item.get("text", ""))
                elif et == "turn.completed":
                    u = evt.get("usage", {})
                    yield UsageEvent(input_tokens=int(u.get("input_tokens", 0)), output_tokens=int(u.get("output_tokens", 0)), cache_read_tokens=int(u.get("cached_input_tokens", 0)))
                elif et in ("error", "turn.failed"):
                    raw = evt.get("message") if et == "error" else (evt.get("error") or {}).get("message")
                    msg = str(raw) if raw else "codex-cli error"
                    # Wrapped JSON auspacken: {"type":"error","status":400,"error":{"message":"..."}}
                    try:
                        inner = json.loads(msg)
                        if isinstance(inner, dict):
                            inner_err = inner.get("error") or {}
                            if isinstance(inner_err, dict) and inner_err.get("message"):
                                msg = inner_err["message"]
                    except (json.JSONDecodeError, TypeError):
                        pass
                    api_error = msg[:300]
        finally:
            if proc.returncode is None: proc.kill(); await proc.wait()
        if api_error:
            yield ErrorEvent(message=api_error, code="codex_api_error")
        elif not got_text:
            yield ErrorEvent(message="codex-cli lieferte keinen Text (Modell evtl. nicht unterstuetzt)", code="empty_response")
        yield MessageStop(stop_reason="end_turn")

    async def ping(self) -> tuple[bool, str]:
        return (_codex_is_logged_in(), "" if _codex_is_logged_in() else "codex not logged in")


# ============================================================================
# 7b. Gemini-CLI-Provider
# ============================================================================

def _resolve_gemini_exe() -> str:
    import shutil
    resolved = shutil.which("gemini")
    if resolved: return resolved
    if os.name == "nt":
        for c in [os.path.expandvars(r"%APPDATA%\npm\gemini.cmd"), os.path.expandvars(r"%APPDATA%\npm\gemini")]:
            if os.path.exists(c): return c
    return "gemini"

def _gemini_is_logged_in() -> bool:
    gemini_home = os.environ.get("GEMINI_HOME") or os.path.expanduser("~/.gemini")
    return Path(gemini_home).exists()

_GEMINI_EXE: str | None = None

class GeminiCLIProvider(LLMProvider):
    name = "gemini-cli"
    requires_model = False
    supports_resume = True
    supports_native_tools = True
    streams_incremental_text = True
    supports_images = True

    async def stream(self, *, model: str, messages: list[Message], system: str | None = None, **kwargs) -> AsyncIterator[StreamEvent]:
        global _GEMINI_EXE
        if _GEMINI_EXE is None: _GEMINI_EXE = _resolve_gemini_exe()
        if not _gemini_is_logged_in() and not os.environ.get("GEMINI_API_KEY"):
            yield ErrorEvent(message="gemini not logged in", code="not_logged_in"); return
        cmd = [_GEMINI_EXE, "-p", "", "-o", "stream-json", "--skip-trust"]
        if model: cmd.extend(["-m", model])
        prompt = messages[-1].content if isinstance(messages[-1].content, str) else "ping"
        # stderr capture damit API-Errors (429 capacity, auth, quota) sichtbar werden
        # statt dass die Session still stirbt
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        proc.stdin.write(prompt.encode("utf-8")); await proc.stdin.drain(); proc.stdin.close()
        timeout_s = float(kwargs.get("timeout", 120.0))
        import time as _time
        t_start = _time.time()
        timed_out = False
        got_text = False
        try:
            while True:
                remaining = timeout_s - (_time.time() - t_start)
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
                except asyncio.TimeoutError:
                    timed_out = True
                    break
                if not line: break
                try: evt = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError: continue
                if evt.get("type") == "message" and evt.get("role") == "assistant":
                    if (c := evt.get("content")):
                        got_text = True
                        yield TextDelta(text=c if isinstance(c, str) else str(c))
                elif evt.get("type") == "result":
                    s = evt.get("stats", {})
                    yield UsageEvent(input_tokens=int(s.get("input_tokens", 0)), output_tokens=int(s.get("output_tokens", 0)))
        finally:
            if proc.returncode is None:
                try: proc.kill()
                except Exception: pass
                try: await proc.wait()
                except Exception: pass
        if timed_out:
            yield ErrorEvent(message=f"gemini-cli timeout after {int(timeout_s)}s", code="timeout")
        elif not got_text:
            # stderr nach API-Fehlern scannen (429 capacity, 401 auth, quota)
            err_msg = "gemini lieferte keinen Text"
            err_code = "empty_response"
            try:
                stderr_bytes = b""
                if proc.stderr:
                    try:
                        stderr_bytes = await asyncio.wait_for(proc.stderr.read(), timeout=2.0)
                    except asyncio.TimeoutError:
                        pass
                stderr_txt = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
                low = stderr_txt.lower()
                if "429" in stderr_txt or "capacity" in low or "rate" in low or "resource_exhausted" in low:
                    # Modellname aus Fehler extrahieren falls vorhanden
                    import re as _re
                    mm = _re.search(r'"model":\s*"([^"]+)"', stderr_txt)
                    which = mm.group(1) if mm else (model or "default")
                    err_msg = f"Gemini API 429 / Capacity exhausted für Modell {which!r}. Anderes Model wählen (z.B. gemini-2.5-pro)."
                    err_code = "rate_limit"
                elif "401" in stderr_txt or "unauthorized" in low or "not logged in" in low:
                    err_msg = "Gemini auth fehlgeschlagen — bitte gemini einloggen"
                    err_code = "auth"
                elif "quota" in low:
                    err_msg = "Gemini Quota überschritten"
                    err_code = "quota"
                elif stderr_txt.strip():
                    err_msg = f"Gemini Fehler: {stderr_txt.strip().splitlines()[-1][:200]}"
                    err_code = "cli_error"
            except Exception:
                pass
            yield ErrorEvent(message=err_msg, code=err_code)
        yield MessageStop(stop_reason="end_turn")

    async def ping(self) -> tuple[bool, str]:
        return (bool(_gemini_is_logged_in() or os.environ.get("GEMINI_API_KEY")), "" if (_gemini_is_logged_in() or os.environ.get("GEMINI_API_KEY")) else "gemini not logged in")


# ============================================================================
# 8. OpenAI-Provider
# ============================================================================

class OpenAIProvider(LLMProvider):
    name = "openai"
    requires_model = True
    supports_native_tools = True
    streams_incremental_text = True
    supports_images = True

    def __init__(self): self._client = None
    async def _get_client(self):
        import openai
        if not (key := os.environ.get("OPENAI_API_KEY")): raise ProviderNotConfigured("OPENAI_API_KEY missing")
        if not self._client: self._client = openai.AsyncOpenAI(api_key=key)
        return self._client

    async def ping(self) -> tuple[bool, str]:
        try:
            c = await self._get_client()
            await c.chat.completions.create(model="gpt-4o-mini", max_tokens=1, messages=[{"role":"user","content":"p"}])
            return True, ""
        except Exception as e: return False, str(e)

    async def stream(self, *, model: str, messages: list[Message], system: str | None = None, **kwargs) -> AsyncIterator[StreamEvent]:
        try: client = await self._get_client()
        except Exception as e: yield ErrorEvent(message=str(e)); return
        sdk_msgs = [{"role":"user","content":str(m.content)} for m in messages]
        if system: sdk_msgs.insert(0, {"role":"system","content":system})
        try:
            stream = await client.chat.completions.create(model=model, messages=sdk_msgs, stream=True)
            async for chunk in stream:
                if chunk.choices and (c := chunk.choices[0].delta.content): yield TextDelta(text=c)
        except Exception as e: yield ErrorEvent(message=str(e))
        yield MessageStop(stop_reason="end_turn")


# ============================================================================
# 4b. OpenClaw-Provider
# ============================================================================

class OpenClawProvider(LLMProvider):
    name = "openclaw"
    async def stream(self, **kwargs) -> AsyncIterator[StreamEvent]:
        yield TextDelta(text="OpenClaw placeholder")
        yield MessageStop(stop_reason="end_turn")
    async def ping(self) -> tuple[bool, str]: return True, ""


# ============================================================================
# Registry & Factory
# ============================================================================

_PROVIDERS: dict[str, LLMProvider] = {}
PROVIDER_NAMES = ("openclaw", "claude-cli", "claude-api", "codex-cli", "gemini-cli", "openai")

def _get_provider(name: str) -> LLMProvider:
    if name not in _PROVIDERS:
        if name == "openclaw": _PROVIDERS[name] = OpenClawProvider()
        elif name == "claude-api": _PROVIDERS[name] = AnthropicSDKProvider()
        elif name == "claude-cli": _PROVIDERS[name] = ClaudeCLIProvider()
        elif name == "codex-cli": _PROVIDERS[name] = CodexCLIProvider()
        elif name == "gemini-cli": _PROVIDERS[name] = GeminiCLIProvider()
        elif name == "openai": _PROVIDERS[name] = OpenAIProvider()
        else: raise ValueError(f"Unknown provider: {name}")
    return _PROVIDERS[name]

async def check_all_providers_health() -> dict[str, dict]:
    res = {}
    for n in PROVIDER_NAMES:
        try: ok, err = await _get_provider(n).ping(); res[n] = {"ok": ok, "error": err}
        except Exception as e: res[n] = {"ok": False, "error": str(e)}
    return res

async def invoke_llm(provider: str, model: str = "", messages: list[Message] = None, system: str = None, **kwargs) -> AsyncIterator[StreamEvent]:
    prov = _get_provider(provider)
    async for ev in prov.stream(model=model, messages=messages, system=system, **kwargs): yield ev

def get_provider_info(name: str) -> dict:
    prov = _get_provider(name)
    return {
        "name": getattr(prov, "name", name),
        "requires_model": getattr(prov, "requires_model", True),
        "supports_resume": getattr(prov, "supports_resume", False),
        "supports_native_tools": getattr(prov, "supports_native_tools", False),
        "streams_incremental_text": getattr(prov, "streams_incremental_text", True),
        "supports_images": getattr(prov, "supports_images", False),
    }

if __name__ == "__main__":
    async def smoke():
        print(await check_all_providers_health())
    asyncio.run(smoke())

def list_providers():
    """Liste aller registrierten Provider mit Capability-Flags. Wird vom
    /api/llm/providers Endpoint serviert; das Frontend befuellt damit den
    Provider-Dropdown."""
    out = []
    for n in PROVIDER_NAMES:
        if n == "openclaw":
            continue  # deprecated, nur als Legacy-Eintrag in der Registry
        try:
            out.append(get_provider_info(n))
        except Exception:
            continue
    return out
