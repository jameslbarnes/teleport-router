import asyncio
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("router_private_tested", Path(__file__).with_name("router_private.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateCommandsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = {"base_url": "https://router.example", "guild_id": "100000000000000001", "channel_id": "100000000000000002"}
        self.actor = SimpleNamespace(guild_id=100000000000000001, channel_id=100000000000000002,
            user=SimpleNamespace(id=100000000000000003, bot=False), id=100000000000000010)
        self.calls = []
        self.entry = {"id": "entry-1", "handle": "alice", "pseudonym": "Alice", "content": "Selected note", "timestamp": 1,
            "url": "https://router.example/e/entry-1"}
        async def request(path, payload):
            self.calls.append((path, payload))
            if path == "link/complete":
                return {"grant": "rdg1.synthetic", "handle": "alice", "groupId": "private-test", "expiresAt": 999999}
            if payload["action"] == "search":
                return {"entries": [dict(self.entry)]}
            if payload["action"] == "read":
                return {"entry": dict(self.entry)}
            return {"saved": True, "entry": dict(self.entry)}
        self.router = module.PrivateRouter(self.settings, self.temp.name, "private-bot-test-key", request)

    def tearDown(self):
        self.temp.cleanup()

    async def link(self):
        return await self.router.link(self.actor, "RD-LINK-" + "x" * 32)

    async def test_wrong_channel_dm_and_bot_never_call_router(self):
        for change in ({"channel_id": 100000000000000099}, {"guild_id": None}, {"user": SimpleNamespace(id=100000000000000003, bot=True)}):
            actor = SimpleNamespace(**{**vars(self.actor), **change})
            with self.assertRaises(module.PrivateError):
                await self.router.link(actor, "RD-LINK-" + "x" * 32)
        self.assertEqual(self.calls, [])

    async def test_guild_scope_uses_the_actual_channel_and_still_rejects_other_servers(self):
        settings = {"base_url": "https://router.example", "guild_id": self.settings["guild_id"],
                    "scope": "guild", "group_id": "private-test"}
        self.router = module.PrivateRouter(settings, self.temp.name, "private-bot-test-key", self.router.request)
        await self.link()
        other = SimpleNamespace(**{**vars(self.actor), "channel_id": 100000000000000020})
        await self.router.save(other, "A note from another topic")
        self.assertEqual(self.calls[-1][1]["channelId"], "100000000000000020")
        self.assertEqual(self.calls[-1][1]["guildId"], self.settings["guild_id"])
        before = len(self.calls)
        for change in ({"guild_id": None}, {"guild_id": 100000000000000099}, {"channel_id": None},
                       {"user": SimpleNamespace(id=100000000000000003, bot=True)}):
            actor = SimpleNamespace(**{**vars(self.actor), **change})
            with self.assertRaises(module.PrivateError):
                await self.router.save(actor, "Must not leave this test")
        self.assertEqual(len(self.calls), before)

    async def test_group_change_does_not_reuse_a_link_to_another_group(self):
        await self.link()
        self.settings["group_id"] = "different-group"
        before = len(self.calls)
        with self.assertRaises(module.PrivateError):
            await self.router.save(self.actor, "Would be sent to the old group")
        self.assertEqual(len(self.calls), before)
        with self.assertRaises(module.PrivateError):
            await self.link()
        self.assertEqual(self.router._load()[str(self.actor.user.id)]["groupId"], "private-test")

    async def test_invalid_scope_never_widens_channel_access(self):
        for changes in ({"scope": "all"}, {"scope": "guild"}, {"channel_id": None}, {"guild_id": None}):
            with self.assertRaises(ValueError):
                module.PrivateRouter({**self.settings, **changes}, self.temp.name, "test-key", self.router.request)

    async def test_no_link_means_no_private_read(self):
        with self.assertRaises(module.PrivateError):
            await self.router.operate(self.actor, "search")
        self.assertEqual(self.calls, [])

    async def test_link_returns_no_grant_or_code_and_saves_only_scoped_state(self):
        result = await self.link()
        self.assertNotIn("grant", result)
        self.assertNotIn("code", result)
        saved = json.loads((Path(self.temp.name) / "links.json").read_text())
        self.assertEqual(list(saved), ["100000000000000003"])
        self.assertNotIn("RD-LINK-", json.dumps(saved))
        self.assertNotIn("private-bot-test-key", json.dumps(saved))

    async def test_identity_comes_from_discord_interaction_and_save_is_exact(self):
        await self.link()
        await self.router.save(self.actor, "Exact selected note")
        body = self.calls[-1][1]
        self.assertEqual(body["discordUserId"], "100000000000000003")
        self.assertEqual(body["interactionId"], "100000000000000010")
        self.assertEqual(body["content"], "Exact selected note")
        other = SimpleNamespace(**{**vars(self.actor), "user": SimpleNamespace(id=100000000000000099, bot=False)})
        with self.assertRaises(module.PrivateError):
            await self.router.save(other, "Someone else's note")

    async def test_recall_is_stateless_and_rechecks_sources_before_delivery(self):
        await self.link()
        async def summarize(question, notes):
            self.assertEqual(notes, [{"number": 1, "author": "alice", "content": "Selected note"}])
            self.assertEqual(question, "selected")
            return "Alice saved a selected note [1]."
        result = await self.router.recall(self.actor, "selected", summarize)
        self.assertEqual(result["entries"], [self.entry])
        self.assertEqual([call[1].get("action") for call in self.calls[-2:]], ["search", "read"])

    async def test_revocation_during_model_call_prevents_recall_delivery(self):
        await self.link()
        original = self.router.request
        async def revoked(path, payload):
            if payload.get("action") == "read":
                raise module.PrivateError("Note unavailable in this group.")
            return await original(path, payload)
        self.router.request = revoked
        with self.assertRaises(module.PrivateError):
            await self.router.recall(self.actor, "", lambda q, e: asyncio.sleep(0, result="A stale summary"))

    async def test_unlink_removes_local_permission_and_model_cannot_set_source_urls(self):
        await self.link()
        entry = {**self.entry, "url": "https://attacker.invalid/"}
        self.assertEqual(self.router.source_url(entry), "https://router.example/e/entry-1")
        await self.router.operate(self.actor, "unlink")
        self.assertEqual(self.router._load(), {})


if __name__ == "__main__":
    unittest.main()
