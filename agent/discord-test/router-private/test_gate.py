"""The server door, with synthetic members and a synthetic Router. No network, Discord or credentials."""
import datetime
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("router_gate_tested", root / "__init__.py", submodule_search_locations=[str(root)])
sys.modules.setdefault(spec.name, importlib.util.module_from_spec(spec))
gate_module = importlib.import_module(spec.name + ".gate")
private = importlib.import_module(spec.name + ".router_private")

ROLE = "1568051145551650900"
NOW = 1_800_000_000.0


def member(user_id, roles=(), joined_ago=86400, bot=False):
    joined = datetime.datetime.fromtimestamp(NOW - joined_ago, datetime.timezone.utc).isoformat()
    return {"user": {"id": str(user_id), "bot": bot}, "roles": list(roles), "joined_at": joined}


class GateTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = NOW
        self.members = []
        self.links = {}
        self.add, self.remove, self.greet = AsyncMock(), AsyncMock(), AsyncMock()
        async def membership(user_id):
            return self.links.get(user_id, False)
        async def list_members():
            return self.members
        self.membership = AsyncMock(side_effect=membership)
        self.gate = gate_module.Gate(ROLE, self.membership, list_members, self.add, self.remove, self.greet,
                                     now=lambda: self.clock)

    async def test_linked_people_get_the_role_and_everyone_else_loses_it(self):
        self.links = {"11": True, "12": True}
        self.members = [member(11), member(12, [ROLE]), member(13, [ROLE]), member(14)]
        await self.gate.sweep()
        self.add.assert_awaited_once_with("11")
        self.remove.assert_awaited_once_with("13")
        self.greet.assert_not_called()  # 14 joined a day ago; no late welcome after a restart

    async def test_a_new_arrival_is_welcomed_once_and_bots_are_left_alone(self):
        self.members = [member(21, joined_ago=30), member(22, [ROLE], bot=True), member(23, bot=True)]
        await self.gate.sweep()
        await self.gate.sweep()
        self.greet.assert_awaited_once_with("21")
        self.add.assert_not_called(); self.remove.assert_not_called()
        self.assertEqual([c.args[0] for c in self.membership.await_args_list], ["21"])

    async def test_no_answer_from_router_changes_nothing_and_is_asked_again(self):
        self.links = {"31": None, "32": None}
        self.members = [member(31, [ROLE]), member(32)]
        await self.gate.sweep()
        self.add.assert_not_called(); self.remove.assert_not_called(); self.greet.assert_not_called()
        self.links = {"31": True, "32": True}
        await self.gate.sweep()
        self.add.assert_awaited_once_with("32")
        self.remove.assert_not_called()

    async def test_a_removed_member_loses_the_role_at_the_next_recheck(self):
        self.links = {"41": True}
        self.members = [member(41, [ROLE])]
        await self.gate.sweep()
        self.links = {"41": False}
        await self.gate.sweep()           # still inside the five-minute answer
        self.remove.assert_not_called()
        self.clock += 301
        await self.gate.sweep()
        self.remove.assert_awaited_once_with("41")

    async def test_linking_opens_the_door_at_once_and_unlinking_closes_it(self):
        await self.gate.admit(51)
        self.add.assert_awaited_once_with("51")
        self.members = [member(51, [ROLE])]
        await self.gate.sweep()
        self.membership.assert_not_called()   # the link that just completed is the answer
        await self.gate.dismiss(51)
        self.remove.assert_awaited_once_with("51")

    async def test_a_refused_role_change_does_not_stop_the_pass(self):
        self.links = {"61": True, "62": True}
        self.add.side_effect = [RuntimeError("Missing Permissions"), None]
        self.members = [member(61), member(62)]
        await self.gate.sweep()
        self.assertEqual(self.add.await_count, 2)


class MembershipTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.answer = {"handle": "alice", "groupId": "private-test", "expiresAt": 1}
        self.calls = []
        async def request(path, payload):
            self.calls.append((path, payload))
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer
        settings = {"base_url": "https://router.example", "guild_id": "1568051145551650858", "scope": "guild", "group_id": "private-test"}
        self.router = private.PrivateRouter(settings, self.temp.name, "synthetic", request)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_membership_is_yes_no_or_unknown_and_never_reads_notes(self):
        self.assertIs(await self.router.membership("71", "1568051145551650901"), False)
        self.assertEqual(self.calls, [])   # no link held: nothing to ask
        self.router._store({"71": {"grant": "rdg1.synthetic", "handle": "alice", "groupId": "private-test", "expiresAt": 1},
                            "72": {"grant": "rdg1.other", "handle": "bob", "groupId": "another-group", "expiresAt": 1}})
        self.assertIs(await self.router.membership("71", "1568051145551650901"), True)
        path, payload = self.calls[-1]
        self.assertEqual((path, payload["action"], payload["discordUserId"], payload["channelId"]),
                         ("operate", "member", "71", "1568051145551650901"))
        self.assertIs(await self.router.membership("72", "1568051145551650901"), False)   # a link to a different group
        refused = private.PrivateError("This Discord permission is no longer active."); refused.status = 403
        self.answer = refused
        self.assertIs(await self.router.membership("71", "1568051145551650901"), False)
        self.answer = private.PrivateError("Router could not confirm the request.")
        self.assertIsNone(await self.router.membership("71", "1568051145551650901"))
        busy = private.PrivateError("Private group request failed."); busy.status = 503
        self.answer = busy
        self.assertIsNone(await self.router.membership("71", "1568051145551650901"))


if __name__ == "__main__":
    unittest.main()
