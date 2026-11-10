"""Watch one channel and decide, after each burst of messages, whether to speak.

Modes: "off" records messages only; "shadow" decides and drafts but never posts, so a
person can review what the bot would have said (the side-by-side run the Hermes
migration plan called for and skipped); "live" posts. Every decision is logged with
its scores and reasons, so the thresholds can be tuned on evidence.
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import time
from typing import TYPE_CHECKING, Awaitable, Callable

from .participation import (DAY_S, AdaptiveCooldown, Decision, Msg, RateLimiter, analyze_flow, decide, format_context,
                            looks_like_question, speech_acts, word_cap)
from .store import Store

if TYPE_CHECKING:  # the SDK loads after the plugin does; see __init__.py
    from .models import Brain

log = logging.getLogger(__name__)
Poster = Callable[[int, str, int], Awaitable[int]]

DEFAULTS = {
    "mode": "shadow",
    "shadow_compose": True,
    "evaluation_delay_seconds": 20,
    "max_wait_seconds": 60,
    # Measured Nov 7: Haiku 5.5 waited at 3 and 5 minutes and spoke in 8 of 8 runs at 8 minutes.
    "unanswered_recheck_seconds": [480, 1200],
    "context_messages": 15,
    "compose_context_messages": 30,
    "max_per_hour": 6,
    "max_per_day": 30,
    "cooldown_seconds": 300,
    "dyadic_backoff": 0.3,
    "max_checks_per_day": 400,
    "max_drafts_per_day": 40,
}


class Controller:
    def __init__(self, settings: dict, store: Store, brain: "Brain | None", poster: Poster | None = None,
                 now: Callable[[], float] = time.time):
        self.s = {**DEFAULTS, **settings}
        self.store, self.brain, self.poster, self.now = store, brain, poster, now
        t = now()
        self.limiter = RateLimiter(self.s["max_per_hour"], self.s["max_per_day"], self.s["cooldown_seconds"],
                                   store.unprompted_post_times(t - DAY_S))
        self.cooldowns: dict[int, AdaptiveCooldown] = {}
        self.timers: dict[int, asyncio.Task] = {}
        self.first_pending: dict[int, float] = {}
        self.locks: dict[int, asyncio.Lock] = {}
        self.turn_factory = None
        self.access_notices: dict[int, float] = {}

    def mentioned(self, channel_id: int, m: Msg) -> None:
        """Private channels own mentions as well as ambient replies; Hermes never sees them."""
        old = self.timers.get(channel_id)
        if old and not old.done():
            old.cancel()
        self.first_pending.pop(channel_id, None)
        asyncio.ensure_future(self.evaluate(channel_id, "direct mention", m.id))

    # Inputs ---------------------------------------------------------------------
    def record(self, channel_id: int, m: Msg) -> None:
        """Every message in the watched channel, the bot's own included."""
        self.store.add_message(channel_id, m)
        if m.is_self:
            cd = self.cooldown(channel_id)
            if cd.since_last(m.ts) > 60:  # a multi-message post is one speech act
                cd.record(m.ts)

    def human_message(self, channel_id: int, m: Msg) -> None:
        """A message from a person that Hermes won't answer (no @-mention): maybe speak."""
        if self.s["mode"] == "off":
            return
        now = self.now()
        first = self.first_pending.setdefault(channel_id, now)
        wait = max(0.0, min(self.s["evaluation_delay_seconds"], first + self.s["max_wait_seconds"] - now))
        old = self.timers.get(channel_id)
        if old and not old.done():
            old.cancel()
        self.timers[channel_id] = asyncio.ensure_future(self._after(channel_id, wait))
        if looks_like_question(m.text):
            asyncio.ensure_future(self._recheck_question(channel_id, m.id))

    async def _after(self, channel_id: int, wait: float) -> None:
        try:
            await asyncio.sleep(wait)
        except asyncio.CancelledError:
            return
        self.first_pending.pop(channel_id, None)
        await self.evaluate(channel_id, "burst ended")

    async def _recheck_question(self, channel_id: int, message_id: int) -> None:
        """PR #13's unstick case needs time to pass: look again while a question waits.
        Chatter after it ("brb coffee") doesn't count as an answer; see analyze_flow."""
        delays = self.s["unanswered_recheck_seconds"]
        waited = 0.0
        for delay in delays if isinstance(delays, list) else [delays]:
            await asyncio.sleep(delay - waited)
            waited = delay
            now = self.now()
            question = self.store.get_message(message_id)
            recent = self.store.recent(channel_id, limit=60, since=now - 3600)
            if question is None or not recent or any(m.is_self and m.ts > question.ts for m in recent):
                return  # gone, or the bot (or Hermes) has already spoken since
            if analyze_flow(recent, now).unanswered_question:
                await self.evaluate(channel_id, "question unanswered")

    # Decision -------------------------------------------------------------------
    def cooldown(self, channel_id: int) -> AdaptiveCooldown:
        if channel_id not in self.cooldowns:
            t = self.now()
            own = [Msg(0, 0, "", "", ts, True) for ts in self.store.bot_post_times(channel_id, t - DAY_S)]
            self.cooldowns[channel_id] = AdaptiveCooldown([a.start for a in speech_acts(own, burst_window_s=60)])
        return self.cooldowns[channel_id]

    async def evaluate(self, channel_id: int, why: str, mentioned_id: int | None = None) -> dict | None:
        lock = self.locks.setdefault(channel_id, asyncio.Lock())
        async with lock:
            if self.turn_factory:
                try:
                    return await asyncio.wait_for(self._evaluate_private(channel_id, why, mentioned_id), timeout=120)
                except Exception as exc:
                    log.warning("Private reply stopped (%s); no conversation details logged", type(exc).__name__)
                    return {"outcome": "failed"}
            return await self._evaluate(channel_id, why)

    async def _evaluate_private(self, channel_id: int, why: str, mentioned_id: int | None) -> dict | None:
        now, mode = self.now(), self.s["mode"]
        msgs = self.store.recent(channel_id, limit=self.s["compose_context_messages"])
        latest = self.store.get_message(mentioned_id) if mentioned_id else (msgs[-1] if msgs else None)
        if not latest or latest.is_self or mode == "off":
            return None

        def record(outcome, reason="", d=None):
            return self.store.log_decision(channel_id, now, latest.id, mode, bool(d and d.speak),
                d.intent if d else "none", d.confidence if d else 0, d.threshold if d else 0,
                reason or (d.reason if d else outcome), {"why": why}, outcome)

        async def unavailable():
            record("access-unavailable")
            # One explanatory notice per five minutes, or on a direct question. No note text.
            if mode == "live" and self.poster and (mentioned_id or now - self.access_notices.get(channel_id, 0) > 300):
                self.access_notices[channel_id] = now
                try:
                    await self.poster(channel_id, "I can't use group notes here while access is unavailable. "
                        "Everyone in this Discord server must join the Router group and connect with /router-link. "
                        "You can still use /router-recall for a private answer.", latest.id)
                except Exception:
                    pass
            return {"outcome": "access-unavailable"}

        if not mentioned_id and (self.store.paused_until(channel_id) > now or not self.limiter.can_post(now)):
            record("paused-or-limited")
            return {"outcome": "paused-or-limited"}
        if self.store.count_checks(now - DAY_S) >= self.s["max_checks_per_day"] or self.brain is None:
            record("check-unavailable")
            return {"outcome": "check-unavailable"}
        try:
            turn = await self.turn_factory(channel_id, latest)
        except Exception:
            return await unavailable()
        if mentioned_id:
            d = Decision(True, "A person directly asked Router", 1.0, "answer", 0, 0)
        else:
            context_msgs = msgs[-self.s["context_messages"]:]
            c, usage = await turn.classify(format_context(context_msgs, now))
            if c is None:
                record("check-failed")
                return {"outcome": "check-failed"}
            flow = analyze_flow(self.store.recent(channel_id, limit=60, since=now - 3600), now)
            d = decide(c, flow, self.cooldown(channel_id), now, self.s["dyadic_backoff"])
            idx = len(context_msgs) - 1 - d.trigger_index
            if 0 <= idx < len(context_msgs) and not context_msgs[idx].is_self:
                latest = context_msgs[idx]
        decision_id = record("drafting" if d.speak else "silent", d=d)
        if not d.speak or (mode == "shadow" and not self.s["shadow_compose"]):
            return {"outcome": "silent", "decision": d}
        if self.store.count_decisions(now - DAY_S, "posted") + self.store.count_decisions(now - DAY_S, "shadow-drafted") >= self.s["max_drafts_per_day"]:
            self.store.set_outcome(decision_id, "draft-budget")
            return {"outcome": "draft-budget"}
        try:
            # The triggering question is explicit even if newer messages arrived while queued.
            context = format_context(msgs, now) + f"\nCurrent message to answer: {latest.author}: {latest.text}"
            text, usage = await turn.compose(context, d, latest, 220 if mentioned_id else word_cap(msgs, now))
            if not text:
                self.store.set_outcome(decision_id, "skipped" if usage.get("skipped") else "draft-failed")
                return {"outcome": "skipped" if usage.get("skipped") else "draft-failed"}
            if mode == "shadow" or not self.poster:
                # Stats survive for this process; private drafts do not enter the decision log.
                self.store.set_outcome(decision_id, "shadow-drafted")
                return {"outcome": "shadow-drafted"}
            if not self.store.get_message(latest.id):
                self.store.set_outcome(decision_id, "superseded")
                return {"outcome": "superseded"}
            await turn.before_send()
        except Exception:
            self.store.set_outcome(decision_id, "access-or-draft-failed")
            return await unavailable()
        try:
            posted_id = await self.poster(channel_id, text, latest.id)
        except Exception:
            self.store.set_outcome(decision_id, "post-failed")
            return {"outcome": "post-failed"}
        if not mentioned_id:
            self.limiter.record(self.now())
        self.store.set_outcome(decision_id, "posted", posted_id=posted_id)
        return {"outcome": "posted", "posted_id": posted_id}

    async def _evaluate(self, channel_id: int, why: str) -> dict | None:
        now, mode = self.now(), self.s["mode"]
        msgs = self.store.recent(channel_id, limit=self.s["context_messages"])
        if not msgs or msgs[-1].is_self:
            return None
        latest = msgs[-1]

        def skip(outcome: str, reason: str) -> dict:
            self.store.log_decision(channel_id, now, latest.id, mode, False, "none", 0.0, 0.0, reason, {"why": why}, outcome)
            return {"outcome": outcome}

        if self.store.paused_until(channel_id) > now:
            return skip("paused", "someone asked the bot to stay quiet here")
        if not self.limiter.can_post(now):
            return skip("rate-limited", "unprompted-post limit reached")
        if self.store.count_checks(now - DAY_S) >= self.s["max_checks_per_day"]:
            return skip("budget", "daily check budget reached")
        if self.brain is None:
            return skip("check-failed", "the model client hasn't loaded yet")

        c, usage = await self.brain.classify(format_context(msgs, now))
        if c is None:
            return skip("check-failed", usage.get("error", "no result"))
        flow = analyze_flow(self.store.recent(channel_id, limit=60, since=now - 3600), now)
        d = decide(c, flow, self.cooldown(channel_id), now, self.s["dyadic_backoff"])
        idx = len(msgs) - 1 - d.trigger_index
        trigger = msgs[idx] if 0 <= idx < len(msgs) and not msgs[idx].is_self else latest
        detail = {"why": why, "scores": c.scores, "llm_speak": c.speak, "llm_confidence": c.confidence,
                  "search_query": c.search_query, "flow": dataclasses.asdict(flow), "adjustments": d.adjustments,
                  "check_usage": usage}
        outcome = "silent" if not d.speak else ("shadow" if mode == "shadow" else "drafting")
        decision_id = self.store.log_decision(channel_id, now, trigger.id, mode, d.speak, d.intent, d.confidence,
                                              d.threshold, d.reason, detail, outcome)
        result = {"outcome": outcome, "decision": d, "decision_id": decision_id}
        if not d.speak or (mode == "shadow" and not self.s["shadow_compose"]):
            return result
        if self.store.count_decisions(now - DAY_S, "shadow-drafted") + self.store.count_decisions(now - DAY_S, "posted") \
                >= self.s["max_drafts_per_day"]:
            self.store.set_outcome(decision_id, "draft-budget")
            return {**result, "outcome": "draft-budget"}

        history = self.store.recent(channel_id, limit=self.s["compose_context_messages"])
        text, compose_usage = await self.brain.compose(format_context(history, now), d, trigger, word_cap(history, now))
        if text is None:
            outcome = ("shadow-" if mode == "shadow" else "") + ("skipped" if compose_usage.get("skipped") else "draft-failed")
            self.store.set_outcome(decision_id, outcome)
            return {**result, "outcome": outcome, "compose_usage": compose_usage}
        if mode == "shadow" or self.poster is None:
            self.store.set_outcome(decision_id, "shadow-drafted", draft=text)
            return {**result, "outcome": "shadow-drafted", "draft": text}
        newest = self.store.recent(channel_id, limit=1)
        if newest and newest[-1].is_self:  # Hermes answered someone meanwhile; don't pile on
            self.store.set_outcome(decision_id, "superseded", draft=text)
            return {**result, "outcome": "superseded"}
        try:
            posted_id = await self.poster(channel_id, text, trigger.id)
        except Exception as exc:
            log.warning("Posting an unprompted reply failed (%s)", type(exc).__name__)
            self.store.set_outcome(decision_id, "post-failed", draft=text)
            return {**result, "outcome": "post-failed"}
        self.limiter.record(self.now())
        self.store.set_outcome(decision_id, "posted", posted_id=posted_id, draft=text)
        log.info("Spoke unprompted in channel %s (decision %s, %s)", channel_id, decision_id, d.intent)
        return {**result, "outcome": "posted", "posted_id": posted_id}
