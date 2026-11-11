"""Real controller/model/tool wiring, synthetic Router and provider. No network or credentials."""
import contextlib
import importlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("group_memory_tested", root / "__init__.py", submodule_search_locations=[str(root)])
sys.modules.setdefault(spec.name, importlib.util.module_from_spec(spec))
core = importlib.import_module(spec.name + ".participation")
models = importlib.import_module(spec.name + ".models")
memory = importlib.import_module(spec.name + ".group_memory")
controller_module = importlib.import_module(spec.name + ".controller")
Controller = controller_module.Controller
Store = importlib.import_module(spec.name + ".store").Store

NOW = 1_800_000_000.0
TRIGGER = core.Msg(1, 7, "Ada", "What was the telescope decision?", NOW)

def response(stop, **block):
    return NS(stop_reason=stop,content=[NS(**block)],usage=NS(input_tokens=10,output_tokens=5))

class Router:
    def __init__(self):
        self.calls=[]
        self.fail_verify=False
        self.fail_check=False
        self.version="1"*64

    async def conversation(self, actor, action, **fields):
        self.calls.append((action,fields))
        if action == "check":
            if self.fail_check: raise RuntimeError("unlinked member")
            return {"audienceVersion":"v1"}
        if action == "verify":
            if self.fail_verify: raise RuntimeError("source revoked")
            return {"verified":True}
        entry={"id":"note-1","content":"The violet telescope ships Friday.","handle":"alice",
               "url":"https://router.example/e/note-1","version":self.version}
        return {"entries":[entry]} if action == "search" else {"entry":entry}

class Messages:
    def __init__(self): self.calls=[]
    async def create(self, **kw):
        self.calls.append(kw)
        if len(self.calls)==1:
            return response("tool_use",type="tool_use",id="t1",name="search_group",input={"query":"telescope"})
        return response("end_turn",type="text",text="Alice's telescope ships Friday: https://router.example/e/note-1")

@contextlib.asynccontextmanager
async def no_external_tools(servers):
    assert servers == [], "Private context must not enter external MCP calls"
    async def nope(*args): raise AssertionError("external tool")
    yield [], nope

class GroupMemoryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.router=Router(); self.provider=Messages()
        self.brain=models.Brain({"compose_mcp_servers":[{"name":"must-not-open"}]},
            client=NS(beta=NS(messages=self.provider)), http=NS(), mcp_connect=no_external_tools)
        self.store=Store(":memory:"); self.poster=AsyncMock(return_value=99)
        self.controller=Controller({"mode":"live"}, self.store, self.brain, self.poster, now=lambda:NOW)
        async def factory(channel, trigger):
            return await memory.GroupTurn(self.brain,self.router,10,channel,trigger).start()
        self.controller.turn_factory=factory
        self.controller.record(20,TRIGGER)

    def tearDown(self): self.store.close()

    async def test_mention_reads_sources_rechecks_then_posts_once_without_persisting_draft(self):
        result=await self.controller.evaluate(20,"direct mention",TRIGGER.id)
        self.assertEqual(result["outcome"],"posted")
        self.assertEqual([c[0] for c in self.router.calls],["check","search","verify"])
        self.assertEqual(self.router.calls[-1][1]["sources"],[{"id":"note-1","version":"1"*64}])
        self.poster.assert_awaited_once()
        self.assertIn("ships Friday",self.poster.call_args.args[1])
        tool_names=[t["name"] for t in self.provider.calls[0]["tools"]]
        self.assertEqual(tool_names,["search_notebook","search_group","read_group_note"])
        self.assertFalse(any(row.get("draft") for row in self.store.decisions(20)))

    async def test_revoked_source_or_changed_membership_never_sends_the_draft(self):
        self.router.fail_verify=True
        self.assertEqual((await self.controller.evaluate(20,"direct mention",1))["outcome"],"access-unavailable")
        self.assertNotIn("Friday",self.poster.call_args.args[1])
        self.assertIn("/router-recall",self.poster.call_args.args[1])

    async def test_unlinked_arrival_blocks_before_any_model_call(self):
        self.router.fail_check=True
        self.assertEqual((await self.controller.evaluate(20,"direct mention",1))["outcome"],"access-unavailable")
        self.assertEqual(self.provider.calls,[])

    async def test_a_mention_is_told_routers_reason_and_ambient_chat_is_not(self):
        async def refused(channel, trigger):
            raise controller_module.Refused("I cannot use group notes here until everyone who can see this channel has linked their account.")
        self.controller.turn_factory=refused
        self.assertEqual((await self.controller.evaluate(20,"direct mention",1))["outcome"],"access-unavailable")
        self.assertIn("everyone who can see this channel",self.poster.call_args.args[1])
        self.poster.reset_mock()
        self.assertEqual((await self.controller.evaluate(20,"burst ended"))["outcome"],"access-unavailable")
        self.poster.assert_not_called()

    async def test_unavailable_ambient_access_does_not_interrupt_chat(self):
        self.router.fail_check=True
        self.assertEqual((await self.controller.evaluate(20,"burst ended"))["outcome"],"access-unavailable")
        self.assertEqual(self.provider.calls,[])
        self.poster.assert_not_called()
        self.assertEqual(self.store.count_checks(NOW-86400),0)

    async def test_shadow_does_not_post_or_keep_a_private_draft(self):
        self.controller.s["mode"]="shadow"
        self.assertEqual((await self.controller.evaluate(20,"direct mention",1))["outcome"],"shadow-drafted")
        self.poster.assert_not_called()
        self.assertFalse(any(row.get("draft") for row in self.store.decisions(20)))

    async def test_no_long_lived_source_or_model_history(self):
        turn=await memory.GroupTurn(self.brain,self.router,10,20,TRIGGER).start()
        await turn.call("search_group",{"query":"telescope"})
        self.assertEqual(turn.sources,{"note-1":{"id":"note-1","version":"1"*64}})
        self.assertNotIn("Friday",json.dumps(turn.sources))

    async def test_ambient_rules_can_speak_but_quiet_stops_model_and_source_reads(self):
        self.brain.classify=AsyncMock(return_value=(core.Classification.from_json({
            "scores":{"is_question":1,"is_directed":1},"speak":True,"confidence":0.99,
            "reason":"A question","intent":"answer"}),{}))
        result=await self.controller.evaluate(20,"burst ended")
        self.assertEqual(result["outcome"],"posted")
        self.assertEqual([c[0] for c in self.router.calls],["check","search","verify"])
        self.store.pause(20,NOW+3600,7)
        self.router.calls.clear();self.provider.calls.clear()
        self.assertEqual((await self.controller.evaluate(20,"burst ended"))["outcome"],"paused-or-limited")
        self.assertEqual(self.router.calls,[]);self.assertEqual(self.provider.calls,[])

    async def test_reread_cannot_replace_a_version_already_seen_by_the_model(self):
        turn=await memory.GroupTurn(self.brain,self.router,10,20,TRIGGER).start()
        await turn.call("search_group",{"query":"telescope"})
        self.router.version="2"*64
        with self.assertRaisesRegex(ValueError,"source changed"):
            await turn.call("read_group_note",{"id":"note-1"})
        self.assertEqual(turn.sources["note-1"]["version"],"1"*64)

if __name__ == "__main__": unittest.main()
