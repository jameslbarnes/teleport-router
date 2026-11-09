"""Model layer against a fake Anthropic client and a fake notebook; no network."""
import contextlib
import importlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("router_participation_tested", root / "__init__.py", submodule_search_locations=[str(root)])
if spec.name not in sys.modules:
    sys.modules[spec.name] = importlib.util.module_from_spec(spec)
p = importlib.import_module(spec.name + ".participation")
models = importlib.import_module(spec.name + ".models")

T0 = 1_800_000_000.0


def response(stop, *blocks):
    return NS(stop_reason=stop, content=list(blocks), usage=NS(input_tokens=10, output_tokens=5))


def text(t):
    return NS(type="text", text=t)


class FakeMessages:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def create(self, **kw):
        self.calls.append(kw)
        return self.replies.pop(0)


class FakeHttp:
    def __init__(self):
        self.queries = []

    async def get(self, url, params=None):
        self.queries.append((url, params))
        results = [{"id": "pub-1", "handle": "alice", "timestamp": T0 * 1000, "content": "Public finding", "to": []},
                   {"id": "dm-1", "handle": "bob", "timestamp": T0 * 1000, "content": "Private note", "to": ["@carol"]}]
        return NS(raise_for_status=lambda: None, json=lambda: {"results": results})


@contextlib.asynccontextmanager
async def no_mcp(servers):
    async def call(name, args):
        raise LookupError(name)
    yield [], call


def brain(classify=(), compose=()):
    client = NS(messages=FakeMessages(classify), beta=NS(messages=FakeMessages(compose)))
    b = models.Brain({"channel_note": "A test channel."}, client=client, http=FakeHttp(), mcp_connect=no_mcp)
    return b, client


def decision():
    return p.Decision(True, "unanswered question", 0.8, "answer", 0.3, 0)


TRIGGER = p.Msg(1, 7, "Ada", "Does anyone know?", T0)


class ModelsTest(unittest.IsolatedAsyncioTestCase):
    async def test_classify_uses_structured_output_at_low_effort(self):
        payload = {"scores": {a: 0.1 for a in p.AXES}, "speak": True, "confidence": 0.7, "reason": "r",
                   "intent": "answer", "trigger_message_index": 0, "search_query": "attestation"}
        b, client = brain(classify=[response("end_turn", text(json.dumps(payload)))])
        c, usage = await b.classify("#0 [12:00 UTC] Ada: Does anyone know?")
        self.assertTrue(c.speak)
        self.assertEqual(c.search_query, "attestation")
        call = client.messages.calls[0]
        self.assertEqual(call["model"], "claude-haiku-5-5")
        self.assertEqual(call["output_config"]["effort"], "low")
        self.assertEqual(call["output_config"]["format"]["type"], "json_schema")
        self.assertIn("A test channel.", call["system"])
        self.assertEqual(usage, {"in": 10, "out": 5})

    async def test_classify_refusal_is_no_decision(self):
        b, _ = brain(classify=[response("refusal")])
        c, usage = await b.classify("#0 x")
        self.assertIsNone(c)
        self.assertIn("refusal", usage["error"])

    async def test_compose_searches_then_answers_without_private_entries(self):
        tool_use = NS(type="tool_use", id="t1", name="search_notebook", input={"query": "attestation"})
        b, client = brain(compose=[response("tool_use", tool_use), response("end_turn", text("@alice found this: https://x.test/e/pub-1"))])
        draft, usage = await b.compose("#0 Ada: Does anyone know?", decision(), TRIGGER, 40)
        self.assertEqual(draft, "@alice found this: https://x.test/e/pub-1")
        self.assertEqual(usage["tools"], ["search_notebook"])
        second = client.beta.messages.calls[1]
        result = second["messages"][-1]["content"][0]
        self.assertEqual(result["tool_use_id"], "t1")
        self.assertIn("Public finding", result["content"])
        self.assertNotIn("Private note", result["content"])
        first = client.beta.messages.calls[0]
        self.assertEqual(first["model"], "claude-opus-5-5")
        self.assertEqual(first["fallbacks"], "default")
        self.assertIn({"type": "web_search_20260209", "name": "web_search", "max_uses": 3}, first["tools"])
        self.assertIn("At most 40 words", first["system"])

    async def test_compose_skip_pause_and_refusal(self):
        b, _ = brain(compose=[response("pause_turn", text("")), response("end_turn", text("SKIP"))])
        draft, usage = await b.compose("ctx", decision(), TRIGGER, 40)
        self.assertIsNone(draft)
        self.assertTrue(usage["skipped"])
        self.assertEqual(usage["rounds"], 2)
        b, _ = brain(compose=[response("refusal")])
        self.assertEqual((await b.compose("ctx", decision(), TRIGGER, 40))[1]["error"], "refusal")

    def test_context_labels_the_bot_and_reply_targets(self):
        ms = [p.Msg(1, 7, "Ada", "Is this\nright?", T0), p.Msg(2, 99, "Router", "Yes.", T0 + 60, True, 1)]
        lines = models.format_context(ms).splitlines()
        self.assertTrue(lines[0].startswith("#1 [") and lines[0].endswith("Ada: Is this right?"))
        self.assertIn("Router (you) (replying to #1): Yes.", lines[1])


if __name__ == "__main__":
    unittest.main()
