"""Store and controller with a fake model: modes, limits, budgets and measurement."""
import asyncio
import importlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("router_participation_tested", root / "__init__.py", submodule_search_locations=[str(root)])
if spec.name not in sys.modules:
    sys.modules[spec.name] = importlib.util.module_from_spec(spec)
p = importlib.import_module(spec.name + ".participation")
store_mod = importlib.import_module(spec.name + ".store")
controller_mod = importlib.import_module(spec.name + ".controller")

CH, ADA, BEN, BOT = 500, 1, 2, 99
T0 = 1_800_000_000.0


class FakeBrain:
    def __init__(self, speak=True, confidence=0.8, draft="Two notebook entries disagree on this: https://example.test/e/1"):
        self.speak, self.confidence, self.draft = speak, confidence, draft
        self.checks, self.drafts = 0, 0

    async def classify(self, context):
        self.checks += 1
        scores = {a: 0.0 for a in p.AXES}
        scores["is_question"] = 0.9
        return p.Classification(scores, self.speak, self.confidence, "an unanswered question the notebook covers",
                                "answer", 0, "query"), {"in": 100, "out": 20}

    async def compose(self, context, decision, trigger, cap):
        self.drafts += 1
        return (self.draft, {"in": 1000, "out": 50}) if self.draft else (None, {"skipped": True})


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


class ControllerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = store_mod.Store(Path(self.temp.name) / "p.db")
        self.clock = Clock(T0)
        self.posted = []

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def make(self, brain, **settings):
        async def poster(channel, text, trigger_id):
            self.posted.append((channel, text, trigger_id))
            return 9000 + len(self.posted)
        return controller_mod.Controller({"evaluation_delay_seconds": 0.01, "max_wait_seconds": 0.05,
                                          "unanswered_recheck_seconds": 0.05, **settings},
                                         self.store, brain, poster, now=self.clock)

    def say(self, c, i, author, text, dt=0.0, is_self=False, reply_to=None):
        self.clock.t += dt
        m = p.Msg(i, author, {ADA: "Ada", BEN: "Ben", BOT: "Router"}[author], text, self.clock.t, is_self, reply_to)
        c.record(CH, m)
        return m

    async def test_shadow_mode_drafts_but_never_posts(self):
        brain = FakeBrain()
        c = self.make(brain, mode="shadow")
        m = self.say(c, 1, ADA, "Does anyone know whether the attestation paper has a newer version?")
        result = await c.evaluate(CH, "test")
        self.assertEqual(result["outcome"], "shadow-drafted")
        self.assertEqual(self.posted, [])
        logged = self.store.decisions(CH)[0]
        self.assertEqual((logged["outcome"], logged["trigger_id"]), ("shadow-drafted", m.id))
        self.assertIn("notebook entries disagree", logged["draft"])
        self.assertEqual(logged["detail"]["scores"]["is_question"], 0.9)

    async def test_live_mode_replies_to_the_trigger_and_counts_against_limits(self):
        c = self.make(FakeBrain(), mode="live", cooldown_seconds=300)
        m = self.say(c, 1, ADA, "Does anyone know whether the attestation paper has a newer version?")
        self.assertEqual((await c.evaluate(CH, "test"))["outcome"], "posted")
        self.assertEqual(self.posted[0][2], m.id)
        self.say(c, 2, BEN, "What about the follow-up paper?", dt=60)
        self.assertEqual((await c.evaluate(CH, "test"))["outcome"], "rate-limited")
        self.assertEqual(len(self.posted), 1)

    async def test_skip_paused_and_superseded(self):
        brain = FakeBrain(draft=None)
        c = self.make(brain, mode="live")
        self.say(c, 1, ADA, "Anyone know a good survey on this?")
        self.assertEqual((await c.evaluate(CH, "t"))["outcome"], "skipped")
        self.store.pause(CH, T0 + 3600, ADA)
        self.say(c, 2, ADA, "Anyone?", dt=10)
        checks = brain.checks
        self.assertEqual((await c.evaluate(CH, "t"))["outcome"], "paused")
        self.assertEqual(brain.checks, checks)  # paused: no model call

    async def test_no_check_when_the_bot_spoke_last_and_budget_holds(self):
        brain = FakeBrain()
        c = self.make(brain, mode="shadow", max_checks_per_day=1)
        self.say(c, 1, ADA, "question one?")
        self.say(c, 2, BOT, "an answer", dt=5, is_self=True)
        self.assertIsNone(await c.evaluate(CH, "t"))
        self.say(c, 3, BEN, "question two?", dt=400)
        await c.evaluate(CH, "t")
        self.say(c, 4, ADA, "question three?", dt=400)
        self.assertEqual((await c.evaluate(CH, "t"))["outcome"], "budget")
        self.assertEqual(brain.checks, 1)

    async def test_skips_and_logs_until_the_model_client_has_loaded(self):
        c = self.make(None, mode="shadow")
        self.say(c, 1, ADA, "Anyone know a good survey on this?")
        self.assertEqual((await c.evaluate(CH, "t"))["outcome"], "check-failed")
        self.assertIn("hasn't loaded", self.store.decisions(CH)[0]["reason"])

    async def test_a_burst_of_messages_is_checked_once(self):
        brain = FakeBrain(speak=False, confidence=0.9)
        c = self.make(brain, mode="shadow")
        for i, text in enumerate(["hey", "so I was reading", "and one more thing"]):
            c.human_message(CH, self.say(c, i + 1, ADA, text))
        await asyncio.sleep(0.2)
        self.assertEqual(brain.checks, 1)

    async def test_a_waiting_question_is_checked_again_after_chatter(self):
        brain = FakeBrain(speak=False, confidence=0.9)
        c = self.make(brain, mode="shadow", unanswered_recheck_seconds=[0.05, 0.1])
        q = self.say(c, 1, ADA, "Has anyone found a way to verify what a TEE is running?")
        c.human_message(CH, q)
        c.human_message(CH, self.say(c, 2, BEN, "brb coffee", dt=5))
        self.clock.t += 300  # by the recheck, the question has waited five minutes
        await asyncio.sleep(0.2)
        whys = [d["detail"].get("why") for d in self.store.decisions(CH, limit=5)]
        self.assertIn("question unanswered", whys)

    async def test_bot_posts_raise_the_cooldown_once_per_burst(self):
        c = self.make(FakeBrain(), mode="shadow")
        for i in range(6):  # a six-message issue posted in one go
            self.say(c, 100 + i, BOT, f"part {i}", dt=2, is_self=True)
        self.assertAlmostEqual(c.cooldown(CH).chattiness(self.clock.t), 1.0, places=1)

    def test_engagement_by_kind(self):
        s = self.store
        human = lambda i, t, reply=None: s.add_message(CH, p.Msg(i, ADA, "Ada", "hi", t, False, reply))
        bot = lambda i, t, reply=None: s.add_message(CH, p.Msg(i, BOT, "Router", "x", t, True, reply))
        human(1, T0)
        bot(2, T0 + 1, reply=1)        # answered a mention
        bot(3, T0 + 2)                  # a scheduled post
        bot(4, T0 + 3, reply=1)        # unprompted reply
        did = s.log_decision(CH, T0, 1, "live", True, "answer", 0.8, 0.3, "r", {}, "drafting")
        s.set_outcome(did, "posted", posted_id=4)
        human(5, T0 + 4, reply=4)
        s.add_reaction(3, BEN, "👍", T0 + 5)
        s.add_reaction(4, ADA, "🎯", T0 + 6)
        e = s.engagement(CH, T0 - 1)
        self.assertEqual(e["unprompted"], {"posts": 1, "engaged": 1, "replies": 1, "reactions": 1, "people": 1})
        self.assertEqual(e["post"]["reactions"], 1)
        self.assertEqual(e["reply"]["engaged"], 0)

    def test_store_works_from_another_thread(self):
        # Found on the first live start: Hermes loads plugins on one thread and runs events on another.
        import threading
        errors = []

        def use():
            try:
                self.store.add_message(CH, p.Msg(1, ADA, "Ada", "hello", T0))
                self.store.purge(now=T0)
            except Exception as exc:
                errors.append(exc)
        t = threading.Thread(target=use)
        t.start()
        t.join()
        self.assertEqual(errors, [])

    def test_deleting_keeps_the_row_but_drops_the_text_and_purge_forgets(self):
        s = self.store
        s.add_message(CH, p.Msg(1, ADA, "Ada", "private thought", T0))
        s.delete_message(1)
        self.assertEqual(s.recent(CH), [])
        s.add_message(CH, p.Msg(2, ADA, "Ada", "recent", T0 + 40 * 86400))
        s.purge(now=T0 + 40 * 86400)
        self.assertIsNone(s.get_message(1))
        self.assertEqual([m.id for m in s.recent(CH)], [2])


if __name__ == "__main__":
    unittest.main()
