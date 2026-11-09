"""Model calls: Haiku 5.5 decides whether to speak, Opus 5.5 writes what to say.

The decision comes back as schema-checked JSON (structured outputs), so none of the
Telegram bot's fence-stripping and brace-matching is needed. Writing a reply can search
the public notebook, call the read-only MCP servers listed in settings, and search the
web, then answers SKIP when there is nothing worth adding.
"""
from __future__ import annotations

import contextlib
import json
import logging
import time

import anthropic
import httpx

from .participation import AXES, INTENTS, Classification, Decision, Msg, format_context  # noqa: F401 (re-exported)
from .prompts import CLASSIFIER, COMPOSE

log = logging.getLogger(__name__)

CLASSIFIER_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {"type": "object", "properties": {a: {"type": "number"} for a in AXES},
                   "required": list(AXES), "additionalProperties": False},
        "speak": {"type": "boolean"},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
        "intent": {"type": "string", "enum": list(INTENTS)},
        "trigger_message_index": {"type": "integer"},
        "search_query": {"type": "string"},
    },
    "required": ["scores", "speak", "confidence", "reason", "intent", "trigger_message_index", "search_query"],
    "additionalProperties": False,
}

SEARCH_TOOL = {
    "name": "search_notebook",
    "description": "Search the public Router notebook. Returns matching entries with author, date, link and text.",
    "input_schema": {"type": "object", "properties": {"query": {"type": "string", "description": "Keywords"}},
                     "required": ["query"], "additionalProperties": False},
}
WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 3}
MAX_TOOL_RESULT_CHARS = 15000
MAX_ROUNDS = 8


class Brain:
    def __init__(self, settings: dict, client: anthropic.AsyncAnthropic | None = None, http: httpx.AsyncClient | None = None,
                 mcp_connect=None):
        self.s = settings
        self.client = client or anthropic.AsyncAnthropic()
        self.http = http or httpx.AsyncClient(timeout=20)
        self.mcp_connect = mcp_connect or connect_mcp
        self.note = settings.get("channel_note", "").strip()

    async def classify(self, context: str) -> tuple[Classification | None, dict]:
        try:
            resp = await self.client.messages.create(
                model=self.s.get("classifier_model", "claude-haiku-5-5"),
                max_tokens=2000,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": CLASSIFIER_SCHEMA}},
                system=CLASSIFIER.format(channel_note=self.note),
                messages=[{"role": "user", "content": f"Recent channel messages:\n\n{context}"}],
            )
        except anthropic.APIStatusError as exc:
            log.warning("Participation check failed: HTTP %s", exc.status_code)
            return None, {"error": f"http {exc.status_code}"}
        except anthropic.APIConnectionError:
            log.warning("Participation check failed: connection error")
            return None, {"error": "connection"}
        usage = {"in": resp.usage.input_tokens, "out": resp.usage.output_tokens}
        if resp.stop_reason != "end_turn":
            return None, {**usage, "error": f"stopped: {resp.stop_reason}"}
        text = next((b.text for b in resp.content if b.type == "text"), "")
        return Classification.from_json(json.loads(text)), usage

    async def compose(self, context: str, decision: Decision, trigger: Msg, cap: int) -> tuple[str | None, dict]:
        system = COMPOSE.format(channel_note=self.note, intent=decision.intent, reason=decision.reason,
                                trigger_index=decision.trigger_index, trigger_author=trigger.author, word_cap=cap)
        messages: list[dict] = [{"role": "user", "content": f"Recent channel messages:\n\n{context}"}]
        usage = {"in": 0, "out": 0, "rounds": 0, "tools": []}
        async with self.mcp_connect(self.s.get("compose_mcp_servers", [])) as (mcp_tools, call_mcp):
            tools = [SEARCH_TOOL, *mcp_tools, WEB_SEARCH]
            for _ in range(MAX_ROUNDS):
                usage["rounds"] += 1
                try:
                    resp = await self.client.beta.messages.create(
                        model=self.s.get("compose_model", "claude-opus-5-5"),
                        max_tokens=4000,
                        betas=["server-side-fallback-2026-07-01"],
                        fallbacks="default",
                        output_config={"effort": "medium"},
                        system=system, tools=tools, messages=messages,
                    )
                except anthropic.APIStatusError as exc:
                    log.warning("Reply drafting failed: HTTP %s", exc.status_code)
                    return None, {**usage, "error": f"http {exc.status_code}"}
                except anthropic.APIConnectionError:
                    log.warning("Reply drafting failed: connection error")
                    return None, {**usage, "error": "connection"}
                usage["in"] += resp.usage.input_tokens
                usage["out"] += resp.usage.output_tokens
                if resp.stop_reason == "refusal":
                    return None, {**usage, "error": "refusal"}
                if resp.stop_reason == "pause_turn":
                    messages.append({"role": "assistant", "content": resp.content})
                    continue
                if resp.stop_reason == "tool_use":
                    messages.append({"role": "assistant", "content": resp.content})
                    results = []
                    for block in resp.content:
                        if block.type == "tool_use":
                            usage["tools"].append(block.name)
                            results.append(await self._run_tool(block, call_mcp))
                    messages.append({"role": "user", "content": results})
                    continue
                if resp.stop_reason not in ("end_turn", "stop_sequence"):
                    return None, {**usage, "error": f"stopped: {resp.stop_reason}"}
                text = "".join(b.text for b in resp.content if b.type == "text").strip()
                if not text or text.upper().rstrip(".") == "SKIP":
                    return None, {**usage, "skipped": True}
                return text[:1900], usage
        return None, {**usage, "error": "too many rounds"}

    async def _run_tool(self, block, call_mcp) -> dict:
        try:
            if block.name == "search_notebook":
                content = json.dumps(await self.search_notebook(str(block.input.get("query", ""))), ensure_ascii=False)
            else:
                content = await call_mcp(block.name, dict(block.input))
            return {"type": "tool_result", "tool_use_id": block.id, "content": content[:MAX_TOOL_RESULT_CHARS]}
        except Exception as exc:  # a failed lookup is reported to the model, not raised
            return {"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                    "content": f"The {block.name} lookup failed ({type(exc).__name__})."}

    async def search_notebook(self, query: str, limit: int = 6) -> list[dict]:
        base = self.s.get("router_base_url", "https://router.teleport.computer").rstrip("/")
        r = await self.http.get(f"{base}/api/search", params={"q": query, "limit": limit})
        r.raise_for_status()
        out = []
        for e in r.json().get("results", []):
            if e.get("to"):  # never use an addressed entry, even if the server returned one
                continue
            out.append({"author": f"@{e['handle']}" if e.get("handle") else e.get("pseudonym", ""),
                        "date": time.strftime("%Y-%m-%d", time.gmtime((e.get("timestamp") or 0) / 1000)),
                        "url": f"{base}/e/{e['id']}", "text": (e.get("content") or "")[:1200]})
        return out


@contextlib.asynccontextmanager
async def connect_mcp(servers: list[dict]):
    """Open the read-only stdio MCP servers named in settings for one reply; close them after."""
    if not servers:
        async def unavailable(name, args):
            raise LookupError(name)
        yield [], unavailable
        return
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    async with contextlib.AsyncExitStack() as stack:
        sessions, tools = {}, []
        for server in servers:
            params = StdioServerParameters(command=server["command"], args=server.get("args", []), env=server.get("env"))
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            for t in (await session.list_tools()).tools:
                sessions[t.name] = session
                tools.append({"name": t.name, "description": t.description or "", "input_schema": t.input_schema})

        async def call(name: str, args: dict) -> str:
            result = await sessions[name].call_tool(name, args)
            text = "\n".join(getattr(c, "text", "") for c in result.content)
            if getattr(result, "is_error", False):
                raise RuntimeError(text[:200])
            return text

        yield tools, call
