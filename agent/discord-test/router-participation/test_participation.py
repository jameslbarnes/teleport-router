"""Run with the pinned gateway Python: -m unittest discover -s agent/discord-test/router-participation -p 'test_*.py'"""
import importlib
import importlib.util
import math
import sys
import unittest
from pathlib import Path

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("router_participation_tested", root / "__init__.py", submodule_search_locations=[str(root)])
sys.modules[spec.name] = importlib.util.module_from_spec(spec)
p = importlib.import_module(spec.name + ".participation")

T0 = 1_800_000_000.0
ADA, BEN, CY, BOT = 1, 2, 3, 99


def msg(i, author, text, ts, is_self=False, reply_to=None):
    name = {ADA: "Ada", BEN: "Ben", CY: "Cy", BOT: "Router"}[author]
    return p.Msg(i, author, name, text, ts, is_self, reply_to)


def classification(speak=True, confidence=0.6, intent="answer", **scores):
    full = {a: 0.0 for a in p.AXES}
    full.update(scores)
    return p.Classification(full, speak, confidence, "a reason", intent, 0)


def flow(**kw):
    base = dict(messages_since_bot=10, rapid_exchange=None, unanswered_question=False, question_answered=False,
                dyadic=False, active_people=3, human_acts_since_bot=5)
    base.update(kw)
    return p.Flow(**base)


class AdaptiveCooldownTest(unittest.TestCase):
    """PR #13's tests, in seconds."""

    def test_base_threshold_when_silent(self):
        cd = p.AdaptiveCooldown()
        self.assertAlmostEqual(cd.chattiness(T0), 0.0, places=5)
        self.assertAlmostEqual(cd.threshold(T0), 0.30, places=2)

    def test_threshold_after_one_post_and_after_three(self):
        cd = p.AdaptiveCooldown()
        cd.record(T0)
        self.assertAlmostEqual(cd.threshold(T0), 0.55, places=2)
        cd.record(T0 + 30)
        cd.record(T0 + 60)
        self.assertGreater(cd.chattiness(T0 + 60), 2.5)
        self.assertGreater(cd.threshold(T0 + 60), 0.85)

    def test_half_life_is_thirty_minutes(self):
        cd = p.AdaptiveCooldown([T0])
        self.assertAlmostEqual(cd.chattiness(T0 + 1800), 0.5, places=2)
        self.assertAlmostEqual(cd.chattiness(T0 + 3600), 0.25, places=2)
        self.assertAlmostEqual(cd.threshold(T0 + 7200), 0.30, places=1)

    def test_caps_at_090_and_forgets_after_a_day(self):
        cd = p.AdaptiveCooldown([T0 - i for i in range(10)])
        self.assertEqual(cd.threshold(T0), 0.90)
        cd = p.AdaptiveCooldown([T0 - 25 * 3600, T0 - 1])
        self.assertEqual(len(cd.timestamps()), 1)
        self.assertEqual(p.AdaptiveCooldown().since_last(T0), math.inf)


class RateLimiterTest(unittest.TestCase):
    def test_cooldown_hourly_and_daily_limits(self):
        rl = p.RateLimiter(max_per_hour=2, max_per_day=3, cooldown_s=300)
        self.assertTrue(rl.can_post(T0))
        rl.record(T0)
        self.assertFalse(rl.can_post(T0 + 299))
        self.assertTrue(rl.can_post(T0 + 300))
        rl.record(T0 + 300)
        self.assertFalse(rl.can_post(T0 + 900))  # two in the last hour
        self.assertTrue(rl.can_post(T0 + 3700))
        rl.record(T0 + 3700)
        self.assertFalse(rl.can_post(T0 + 8000))  # three today
        self.assertTrue(rl.can_post(T0 + 86500))


class SpeechActsTest(unittest.TestCase):
    def test_bursts_merge_and_survive_an_interruption(self):
        acts = p.speech_acts([msg(1, ADA, "hey", T0), msg(2, ADA, "you know what", T0 + 5),
                              msg(3, BEN, "?", T0 + 8), msg(4, ADA, "I think we should do X", T0 + 20),
                              msg(5, ADA, "later thought", T0 + 200)])
        self.assertEqual([(a.author, len(a.messages)) for a in acts], [("Ada", 3), ("Ben", 1), ("Ada", 1)])
        self.assertTrue(acts[0].interrupted)


class FlowTest(unittest.TestCase):
    def test_rapid_two_person_exchange(self):
        ms = [msg(i, ADA if i % 2 else BEN, f"point {i}", T0 + i * 10) for i in range(1, 7)]
        self.assertEqual(set(p.analyze_flow(ms, T0 + 70).rapid_exchange), {"Ada", "Ben"})
        slow = [msg(i, ADA if i % 2 else BEN, f"point {i}", T0 + i * 90) for i in range(1, 7)]
        self.assertIsNone(p.analyze_flow(slow, T0 + 600).rapid_exchange)

    def test_unanswered_and_answered_questions(self):
        q = msg(1, ADA, "Does anyone know if the paper has a newer version?", T0)
        self.assertTrue(p.analyze_flow([q], T0 + 150).unanswered_question)
        self.assertFalse(p.analyze_flow([q], T0 + 60).unanswered_question)  # too recent to judge
        answered = p.analyze_flow([q, msg(2, BEN, "yes, v2 came out last week", T0 + 40)], T0 + 150)
        self.assertTrue(answered.question_answered)
        self.assertFalse(answered.unanswered_question)
        # Found by the live evaluation: chatter isn't an answer, a direct reply is.
        chatter = p.analyze_flow([q, msg(2, BEN, "brb coffee", T0 + 10)], T0 + 150)
        self.assertTrue(chatter.unanswered_question)
        short_reply = p.analyze_flow([q, msg(2, BEN, "yes, v2", T0 + 10, reply_to=1)], T0 + 150)
        self.assertTrue(short_reply.question_answered)

    def test_a_bot_that_hasnt_spoken_is_not_recent(self):
        f = p.analyze_flow([msg(1, ADA, "a claim", T0), msg(2, BEN, "hmm ok", T0 + 10)], T0 + 20)
        self.assertEqual(f.messages_since_bot, p.NOT_SPOKEN)
        d = p.decide(classification(confidence=0.45, is_wrong=0.8), f, p.AdaptiveCooldown(), T0 + 20)
        self.assertTrue(d.speak)  # a correction that matters, even between two people
        self.assertNotIn("the bot spoke very recently", " ".join(d.adjustments))

    def test_counts_since_the_bot_and_two_person_geometry(self):
        ms = [msg(1, ADA, "a", T0), msg(2, BOT, "b", T0 + 10, is_self=True), msg(3, BEN, "c", T0 + 20),
              msg(4, ADA, "d", T0 + 60)]
        f = p.analyze_flow(ms, T0 + 70)
        self.assertEqual(f.messages_since_bot, 2)
        self.assertEqual(f.human_acts_since_bot, 2)
        self.assertTrue(f.dyadic)
        self.assertFalse(p.analyze_flow(ms + [msg(5, CY, "e", T0 + 65)], T0 + 70).dyadic)


class DecideTest(unittest.TestCase):
    def setUp(self):
        self.cd = p.AdaptiveCooldown()

    def test_confident_no_is_respected(self):
        d = p.decide(classification(speak=False, confidence=0.8), flow(), self.cd, T0)
        self.assertFalse(d.speak)

    def test_never_interrupts_a_rapid_exchange_unless_addressed(self):
        rapid = flow(rapid_exchange=("Ada", "Ben"))
        self.assertFalse(p.decide(classification(confidence=0.9, is_question=0.9), rapid, self.cd, T0).speak)
        self.assertTrue(p.decide(classification(confidence=0.5, is_directed=0.9), rapid, self.cd, T0).speak)

    def test_does_not_pile_on_an_answered_question(self):
        d = p.decide(classification(confidence=0.9), flow(question_answered=True), self.cd, T0)
        self.assertFalse(d.speak)
        self.assertIn("already answered", d.reason)

    def test_unanswered_question_boost_and_social_penalty(self):
        d = p.decide(classification(confidence=0.2), flow(unanswered_question=True), self.cd, T0)
        self.assertTrue(d.speak)  # 0.2 + 0.15 + 0.10 (silent an hour) clears 0.30
        d = p.decide(classification(confidence=0.4, is_social=0.9), flow(), self.cd, T0)
        self.assertFalse(d.speak)  # 0.4 - 0.30 + 0.10 stays under 0.30

    def test_cooldown_raises_the_bar_after_speaking(self):
        for t in (T0 - 120, T0 - 60, T0 - 30):
            self.cd.record(t)
        d = p.decide(classification(confidence=0.7), flow(), self.cd, T0)
        self.assertFalse(d.speak)
        self.assertGreater(d.threshold, 0.85)
        d = p.decide(classification(confidence=0.5, is_directed=0.9), flow(), self.cd, T0)
        self.assertTrue(d.speak)  # addressed: base bar
        self.assertAlmostEqual(d.threshold, 0.30)

    def test_two_person_conversation_backs_off_unless_a_question_waits(self):
        two = flow(dyadic=True, active_people=2)
        self.assertFalse(p.decide(classification(confidence=0.6), two, self.cd, T0).speak)
        waiting = flow(dyadic=True, active_people=2, unanswered_question=True)
        self.assertTrue(p.decide(classification(confidence=0.6), waiting, self.cd, T0).speak)

    def test_needs_the_model_yes_unless_confidence_is_very_high(self):
        self.assertFalse(p.decide(classification(speak=False, confidence=0.6), flow(), self.cd, T0).speak)
        # Directed (+0.20) and an hour's silence (+0.10) push 0.6 to 0.9, past the 0.85 override.
        self.assertTrue(p.decide(classification(speak=False, confidence=0.6, is_directed=0.9), flow(), self.cd, T0).speak)

    def test_classification_from_json_clamps_and_defaults(self):
        c = p.Classification.from_json({"scores": {"is_question": 4}, "speak": True, "confidence": -1, "intent": "sing"})
        self.assertEqual(c.scores["is_question"], 1.0)
        self.assertEqual(c.scores["is_social"], 0.0)
        self.assertEqual(c.confidence, 0.0)
        self.assertEqual(c.intent, "none")


class ShapeTest(unittest.TestCase):
    def test_word_cap_follows_the_room_within_bounds(self):
        short = [msg(i, ADA, "ok sure", T0 + i) for i in range(10)]
        self.assertEqual(p.word_cap(short, T0 + 20), 20)
        long = [msg(i, ADA, " ".join(["word"] * 80), T0 + i) for i in range(10)]
        self.assertEqual(p.word_cap(long, T0 + 20), 80)
        self.assertEqual(p.word_cap([], T0), 120)

    def test_heat_needs_three_people_eight_messages_and_substance(self):
        text = "a substantive point about the design that runs past forty characters"
        ms = [msg(i, (ADA, BEN, CY)[i % 3], text, T0 + i * 30) for i in range(8)]
        self.assertTrue(p.heat(ms, T0 + 300)["hot"])
        self.assertFalse(p.heat(ms[:7], T0 + 300)["hot"])
        self.assertFalse(p.heat([msg(i, (ADA, BEN, CY)[i % 3], "lol", T0 + i) for i in range(9)], T0 + 20)["hot"])


if __name__ == "__main__":
    unittest.main()
