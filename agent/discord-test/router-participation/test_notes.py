"""The note rules with a synthetic Router, model and Discord. No network, credentials or real messages."""
import asyncio
import importlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("notes_tested", root / "__init__.py", submodule_search_locations=[str(root)])
sys.modules.setdefault(spec.name, importlib.util.module_from_spec(spec))
core = importlib.import_module(spec.name + ".participation")
notes = importlib.import_module(spec.name + ".notes")

CHANNEL, GUILD = 55, 77
ADA, BEN, CY = 1, 2, 3
NOW = 1_800_000_000.0


class PrivateError(Exception):
    pass


class Router:
    """Ada posts automatically here, Ben is asked first, Cy posts only on request. Dee is not linked."""
    def __init__(self):
        self.modes = {ADA: "automatic", BEN: "review", CY: "manual"}
        self.open, self.saved, self.deleted, self.own, self.own_deleted, self.fail_save = True, [], [], [], [], False

    async def conversation(self, actor, action, **fields):
        if not self.open:
            raise PrivateError("Someone who can see this channel still has to link.")
        return {"audienceVersion": "v1"}

    async def operate(self, actor, action, **fields):
        user = actor.user.id
        if user not in self.modes:
            raise PrivateError("Link your Router account first.")
        if action == "rules":
            return {"handle": f"user{user}", "groupId": "g", "mode": self.modes[user], "rules": {"share": "findings"}}
        if action == "save":
            if self.fail_save:
                raise PrivateError("Your TinyCloud storage is unavailable. Nothing was saved.")
            self.saved.append((user, fields["content"], fields["interactionId"], actor.channel_id))
            return {"entry": {"id": f"discord-{len(self.saved)}", "handle": f"user{user}"}}
        if action == "delete":
            self.deleted.append((user, fields["entryId"]))
            return {"deleted": True}
        raise AssertionError(action)

    async def own_note(self, text):
        self.own.append(text)
        return {"id": f"own-{len(self.own)}"}

    async def delete_own(self, entry_id):
        self.own_deleted.append(entry_id)


class Brain:
    def __init__(self, answer):
        self.answer, self.payloads = answer, []

    async def take_notes(self, payload, discussion):
        data = json.loads(payload)
        self.payloads.append((data, discussion))
        found = self.answer(data) if callable(self.answer) else self.answer
        return found if discussion else {**found, "discussion": {"worth_noting": False, "text": "", "people": []}}


class UI:
    def __init__(self):
        self.shown, self.updates, self.marks, self.unmarks, self.blocked, self.announced, self.states, self.closed = [], [], [], [], [], [], [], set()

    async def show_draft(self, draft):
        if draft.user_id in self.closed:
            return None
        self.shown.append((draft.user_id, draft.state, draft.text))
        return object()

    async def update_draft(self, draft, note):
        self.updates.append((draft.user_id, draft.state, note))

    async def mark(self, channel_id, message_id):
        self.marks.append(message_id)

    async def unmark(self, channel_id, message_id):
        self.unmarks.append(message_id)

    async def cannot_message(self, channel_id, user_id):
        self.blocked.append(user_id)

    async def announce(self, note):
        self.announced.append((note.text, dict(note.people)))
        return object()

    async def update_announcement(self, note, state):
        self.states.append((state, note.text))


def msg(mid, author, text, name=None):
    return core.Msg(mid, author, name or {ADA: "Ada", BEN: "Ben", CY: "Cy"}.get(author, "Dee"), text, NOW + mid)


NOTHING = {"personal": [], "discussion": {"worth_noting": False, "text": "", "people": []}}


class NotesTest(unittest.IsolatedAsyncioTestCase):
    def taker(self, answer, **settings):
        self.router, self.ui, self.brain = Router(), UI(), Brain(answer)
        self.clock = NOW
        return notes.NoteTaker({"notes": "live", "notes_delay_seconds": 0.05, "notes_pause_seconds": 0, **settings}, GUILD,
                               self.ui, lambda: self.brain, lambda: self.router, now=lambda: self.clock)

    async def test_an_automatic_note_is_shown_first_and_posted_after_the_wait(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 2, "text": "Key grants on the compose hash."}],
                            "discussion": NOTHING["discussion"]}, notes_discussion=False)
        burst = [msg(10, ADA, "the fix is the compose hash"), msg(11, ADA, "digest changes each rebuild"), msg(12, ADA, "so that's it")]
        await taker.read_burst(CHANNEL, burst)
        self.assertEqual(self.ui.shown, [(ADA, "waiting", "Key grants on the compose hash.")])
        self.assertEqual(self.ui.marks, [10])
        self.assertEqual(self.router.saved, [])  # the person sees it before the group does
        await asyncio.sleep(0.15)
        self.assertEqual(self.router.saved, [(ADA, "Key grants on the compose hash.", "10", CHANNEL)])
        self.assertEqual(self.ui.updates[-1][:2], (ADA, "posted"))
        data, _ = self.brain.payloads[0]
        self.assertEqual([p["name"] for p in data["people_who_may_get_a_personal_note"]], ["Ada"])
        self.assertEqual(data["people_who_may_get_a_personal_note"][0]["their_posting_rules"], {"share": "findings"})

    async def test_delete_before_the_wait_ends_posts_nothing_and_after_it_removes_the_note(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "A finding."}], "discussion": NOTHING["discussion"]},
                           notes_delay_seconds=30)
        await taker.read_burst(CHANNEL, [msg(1, ADA, "a"), msg(2, ADA, "b"), msg(3, ADA, "c")])
        draft = next(iter(taker.drafts.values()))
        self.assertFalse(await taker.discard(draft.id, BEN))  # only its owner
        self.assertTrue(await taker.edit(draft.id, ADA, "  A better finding.  "))
        self.assertTrue(await taker.post_now(draft.id, ADA))
        self.assertEqual(self.router.saved[0][:2], (ADA, "A better finding."))
        self.assertTrue(await taker.discard(draft.id, ADA))
        self.assertEqual(self.router.deleted, [(ADA, "discord-1")])
        self.assertEqual(self.ui.unmarks, [3])

        await taker.read_burst(CHANNEL, [msg(4, ADA, "a"), msg(5, ADA, "b"), msg(6, ADA, "c")])
        second = [d for d in taker.drafts.values() if d.state == "waiting"][0]
        self.assertTrue(await taker.discard(second.id, ADA))
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.router.saved), 1)
        self.assertFalse(await taker.post_now(second.id, ADA))

    async def test_ask_first_rules_post_only_on_yes_and_an_unanswered_draft_lapses(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "Ada's."}, {"person": 2, "message_index": 1, "text": "Ben's."}],
                            "discussion": NOTHING["discussion"]}, notes_delay_seconds=0.05, notes_discussion=False)
        await taker.read_burst(CHANNEL, [msg(1, ADA, "x"), msg(2, BEN, "an idea"), msg(3, ADA, "y")])
        self.assertIn((BEN, "asking", "Ben's."), self.ui.shown)
        await asyncio.sleep(0.2)
        self.assertEqual([s[0] for s in self.router.saved], [ADA])  # Ben never answered
        self.assertIn((BEN, "dropped", "You didn't answer, so this note was not posted."), self.ui.updates)

        self.router.saved.clear()
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "Ben's."}], "discussion": NOTHING["discussion"]},
                           notes_delay_seconds=30, notes_discussion=False)
        await taker.read_burst(CHANNEL, [msg(1, BEN, "an idea"), msg(2, BEN, "more"), msg(3, BEN, "and more")])
        draft = next(iter(taker.drafts.values()))
        self.assertEqual(self.router.saved, [])
        self.assertTrue(await taker.post_now(draft.id, BEN))
        self.assertEqual(self.router.saved[0][:3], (BEN, "Ben's.", "3"))

    async def test_manual_rules_and_unlinked_people_get_no_note_until_they_ask(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "Should not exist."}], "discussion": NOTHING["discussion"]},
                           notes_discussion=False)
        await taker.read_burst(CHANNEL, [msg(1, CY, "a"), msg(2, 9, "b"), msg(3, CY, "c")])
        self.assertEqual(self.brain.payloads, [])  # nobody eligible, so the conversation is not sent to a model
        self.assertEqual(self.ui.shown, [])
        await taker.requested(CHANNEL, msg(3, CY, "keep this"), BEN)  # someone else's memo means nothing
        self.assertEqual(self.ui.shown, [])
        self.brain.answer = {"personal": [{"person": 1, "message_index": 0, "text": "Cy's note."}], "discussion": NOTHING["discussion"]}
        await taker.requested(CHANNEL, msg(3, CY, "keep this"), CY)
        self.assertEqual(self.router.saved, [(CY, "Cy's note.", "3", CHANNEL)])
        self.assertEqual(self.ui.marks, [])  # they put the memo there themselves
        await taker.requested(CHANNEL, msg(3, CY, "keep this"), CY)
        self.assertEqual(len(self.router.saved), 1)
        await taker.requested(CHANNEL, msg(4, 9, "me too"), 9)  # not linked
        self.assertEqual(len(self.router.saved), 1)

    async def test_nobody_is_posted_for_without_seeing_the_note(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "A finding."}], "discussion": NOTHING["discussion"]},
                           notes_discussion=False)
        self.ui.closed.add(ADA)
        for start in (1, 11):
            await taker.read_burst(CHANNEL, [msg(start, ADA, "a"), msg(start + 1, ADA, "b"), msg(start + 2, ADA, "c")])
        await asyncio.sleep(0.15)
        self.assertEqual(self.router.saved, [])
        self.assertEqual(self.ui.blocked, [ADA])  # told once
        self.assertEqual(len(self.brain.payloads), 1)  # and not drafted for again

    async def test_a_note_under_a_name_rests_on_that_persons_own_message(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 1, "text": "Ada's."}, {"person": 7, "message_index": 0, "text": "Nobody's."},
                                         {"person": 1, "message_index": 0, "text": "A second one."}],
                            "discussion": NOTHING["discussion"]}, notes_delay_seconds=30, notes_discussion=False)
        await taker.read_burst(CHANNEL, [msg(1, ADA, "mine"), msg(2, CY, "not Ada's"), msg(3, CY, "also not")])
        self.assertEqual([(d.user_id, d.source_id, d.text) for d in taker.drafts.values()], [(ADA, 1, "Ada's.")])

    async def test_nothing_is_read_when_router_cannot_confirm_the_channels_audience(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "A finding."}],
                            "discussion": {"worth_noting": True, "text": "They agreed.", "people": [1, 2]}})
        self.router.open = False
        await taker.read_burst(CHANNEL, [msg(1, ADA, "a"), msg(2, BEN, "b"), msg(3, ADA, "c")])
        self.assertEqual((self.brain.payloads, self.ui.shown, self.router.own), ([], [], []))

    async def test_shadow_mode_decides_and_touches_nothing(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "A finding."}],
                            "discussion": {"worth_noting": True, "text": "They agreed.", "people": [1, 2]}}, notes="shadow")
        await taker.read_burst(CHANNEL, [msg(1, ADA, "a"), msg(2, BEN, "b"), msg(3, ADA, "c")])
        self.assertEqual(len(self.brain.payloads), 1)
        self.assertEqual((self.ui.shown, self.ui.announced, self.router.own, self.router.saved), ([], [], [], []))

    async def test_a_failed_save_says_so_and_takes_the_memo_back(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "A finding."}], "discussion": NOTHING["discussion"]},
                           notes_delay_seconds=30, notes_discussion=False)
        await taker.read_burst(CHANNEL, [msg(1, ADA, "a"), msg(2, ADA, "b"), msg(3, ADA, "c")])
        self.router.fail_save = True
        draft = next(iter(taker.drafts.values()))
        self.assertFalse(await taker.post_now(draft.id, ADA))
        self.assertEqual(self.ui.updates[-1], (ADA, "dropped", "This note was not posted. Your TinyCloud storage is unavailable. Nothing was saved."))
        self.assertEqual(self.ui.unmarks, [3])

    async def test_each_person_has_a_daily_limit(self):
        taker = self.taker({"personal": [{"person": 1, "message_index": 0, "text": "A finding."}], "discussion": NOTHING["discussion"]},
                           notes_delay_seconds=30, notes_per_person_per_day=2, notes_discussion=False)
        for start in (1, 11, 21):
            await taker.read_burst(CHANNEL, [msg(start, ADA, "a"), msg(start + 1, ADA, "b"), msg(start + 2, ADA, "c")])
        self.assertEqual(len(self.ui.shown), 2)
        self.clock += 86401
        await taker.read_burst(CHANNEL, [msg(31, ADA, "a"), msg(32, ADA, "b"), msg(33, ADA, "c")])
        self.assertEqual(len(self.ui.shown), 3)

    async def test_the_bots_own_note_and_leaving_a_part_out(self):
        def answer(data):
            names = [p["name"] for p in data["everyone_in_the_conversation"]]
            return {"personal": [], "discussion": {"worth_noting": True, "text": "By " + " and ".join(names) + ".",
                                                   "people": list(range(1, len(names) + 1))}}
        taker = self.taker(answer, notes_delay_seconds=30)
        burst = [msg(1, ADA, "a"), msg(2, BEN, "b"), msg(3, CY, "c"), msg(4, ADA, "d"), msg(5, CY, "e")]
        await taker.read_burst(CHANNEL, burst)
        self.assertEqual(self.router.own, ["By Ada and Ben and Cy."])
        self.assertEqual(self.ui.announced, [("By Ada and Ben and Cy.", {ADA: "Ada", BEN: "Ben", CY: "Cy"})])
        self.assertTrue(self.brain.payloads[0][1])
        note = next(iter(taker.own.values()))
        self.assertIn("doesn't draw on anything you said", await taker.leave_out(note.id, 9))
        self.assertIn("rewritten without what you said", await taker.leave_out(note.id, BEN))
        self.assertEqual(self.router.own_deleted, ["own-1"])
        self.assertEqual(self.router.own[-1], "By Ada and Cy.")
        self.assertNotIn("Ben", self.brain.payloads[-1][0]["messages_newest_is_0"])
        self.assertEqual(self.ui.states[-1], (None, "By Ada and Cy."))
        self.assertIn("already left out", await taker.leave_out(note.id, BEN))
        self.assertIn("withdrawn", await taker.leave_out(note.id, CY))  # one person left is not a discussion
        self.assertEqual(self.router.own_deleted, ["own-1", "own-2"])
        self.assertEqual(self.ui.states[-1][0], "withdrawn")
        self.assertEqual((taker.own, note.messages), ({}, []))

    async def test_one_persons_monologue_gets_no_discussion_note_and_bursts_wait_for_a_pause(self):
        taker = self.taker({"personal": [], "discussion": {"worth_noting": True, "text": "Just Cy.", "people": [1]}},
                           notes_pause_seconds=0.05)
        for i in range(1, 4):
            taker.observe(CHANNEL, msg(i, ADA, f"m{i}"))
            await asyncio.sleep(0.02)  # still talking: the timer restarts
        self.assertEqual(self.brain.payloads, [])
        await asyncio.sleep(0.15)
        self.assertEqual(len(self.brain.payloads), 1)
        self.assertFalse(self.brain.payloads[0][1])
        self.assertEqual(self.router.own, [])
        taker.observe(CHANNEL, msg(9, ADA, "one line"))
        taker.forget(9)
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.brain.payloads), 1)  # a deleted message is not kept for later, and two lines are not a burst


if __name__ == "__main__":
    unittest.main()
