"""When the Router bot speaks in a Discord channel without being @-mentioned.

A port of the Telegram bot's group-chat rules. From PR #13: silence by default,
conversation-flow checks, and an adaptive cooldown that raises the bar each time the
bot speaks. From PR #17: speech acts, the two-person backoff and a reply length that
matches the conversation. From the March bot: the rate limiter and conversation heat.
Pure functions, no Discord, network or model calls, so every rule is unit-tested.
"""
from __future__ import annotations

import math
import re
import statistics
import time
from dataclasses import dataclass, field

AXES = ("is_question", "is_wrong", "is_stuck", "is_relevant", "is_directed", "is_social")
INTENTS = ("answer", "correct", "unstick", "add-context", "notebook-surface", "none")

HALF_LIFE_S = 30 * 60
BASE_THRESHOLD = 0.30
CHATTINESS_WEIGHT = 0.25
MAX_THRESHOLD = 0.90
DIRECTED_BYPASS = 0.80
HIGH_CONFIDENCE_OVERRIDE = 0.85
DAY_S = 24 * 60 * 60
NOT_SPOKEN = 10_000  # messages since the bot spoke, when it hasn't spoken in the window
QUESTION_START = re.compile(
    r"^(how|what|why|when|where|who|which|does|do|is|are|can|could|would|should|has|have|did)\b", re.I)


@dataclass(frozen=True)
class Msg:
    id: int
    author_id: int
    author: str
    text: str
    ts: float  # epoch seconds
    is_self: bool = False  # the bot's own account: its replies, unprompted posts and scheduled posts
    reply_to: int | None = None


@dataclass
class SpeechAct:
    author_id: int
    author: str
    messages: list[Msg] = field(default_factory=list)
    interrupted: bool = False

    @property
    def is_self(self) -> bool:
        return self.messages[0].is_self

    @property
    def start(self) -> float:
        return self.messages[0].ts

    @property
    def end(self) -> float:
        return self.messages[-1].ts


def speech_acts(messages: list[Msg], burst_window_s: float = 30.0) -> list[SpeechAct]:
    """Group each author's rapid consecutive messages into one act (PR #17), so
    "hey / you know what / I think we should do X" counts once. An author who is
    interrupted and continues within the window keeps the same act."""
    open_acts: dict[int, SpeechAct] = {}
    interrupted: dict[int, bool] = {}
    done: list[SpeechAct] = []
    for m in sorted(messages, key=lambda m: m.ts):
        act = open_acts.get(m.author_id)
        if act and m.ts - act.end <= burst_window_s:
            act.interrupted = act.interrupted or interrupted.get(m.author_id, False)
            act.messages.append(m)
        else:
            if act:
                done.append(act)
            open_acts[m.author_id] = SpeechAct(m.author_id, m.author, [m])
        interrupted[m.author_id] = False
        for other in open_acts:
            if other != m.author_id:
                interrupted[other] = True
    done.extend(open_acts.values())
    return sorted(done, key=lambda a: a.start)


class AdaptiveCooldown:
    """How chatty the bot has been, with exponential decay (PR #13).

    chattiness(t) = sum of e^(-lambda * (t - t_i)) over the times it spoke, half-life 30 min.
    threshold = min(0.30 + 0.25 * chattiness, 0.90): just spoke once, about 0.55; three times
    in ten minutes, 0.90; silent for an hour or more, back to about 0.30.
    """

    def __init__(self, timestamps: list[float] | None = None):
        self._ts: list[float] = []
        self.restore(timestamps or [])

    def record(self, now: float) -> None:
        self._ts.append(now)
        self._prune(now)

    def chattiness(self, now: float) -> float:
        self._prune(now)
        lam = math.log(2) / HALF_LIFE_S
        return sum(math.exp(-lam * (now - t)) for t in self._ts)

    def threshold(self, now: float) -> float:
        return min(BASE_THRESHOLD + CHATTINESS_WEIGHT * self.chattiness(now), MAX_THRESHOLD)

    def since_last(self, now: float) -> float:
        return now - self._ts[-1] if self._ts else math.inf

    def timestamps(self) -> list[float]:
        return list(self._ts)

    def restore(self, timestamps: list[float], now: float | None = None) -> None:
        latest = now if now is not None else max(timestamps, default=0)
        self._ts = sorted(t for t in timestamps if latest - t < DAY_S)

    def _prune(self, now: float) -> None:
        self._ts = [t for t in self._ts if now - t < DAY_S]


class RateLimiter:
    """Unprompted posts only: at most 6 an hour and 30 a day, 5 minutes apart (the March bot)."""

    def __init__(self, max_per_hour: int = 6, max_per_day: int = 30, cooldown_s: float = 300,
                 timestamps: list[float] | None = None):
        self.max_per_hour, self.max_per_day, self.cooldown_s = max_per_hour, max_per_day, cooldown_s
        self._ts = sorted(timestamps or [])

    def can_post(self, now: float) -> bool:
        self._ts = [t for t in self._ts if now - t < DAY_S]
        if self._ts and now - self._ts[-1] < self.cooldown_s:
            return False
        if sum(1 for t in self._ts if now - t < 3600) >= self.max_per_hour:
            return False
        return len(self._ts) < self.max_per_day

    def record(self, now: float) -> None:
        self._ts.append(now)


@dataclass
class Flow:
    messages_since_bot: int
    rapid_exchange: tuple[str, str] | None
    unanswered_question: bool
    question_answered: bool
    dyadic: bool
    active_people: int
    human_acts_since_bot: int


def looks_like_question(text: str) -> bool:
    t = text.strip()
    return t.endswith("?") or bool(QUESTION_START.match(t))


def analyze_flow(messages: list[Msg], now: float, window_s: float = 600) -> Flow:
    """Conversation shape (PR #13, plus PR #17's participant geometry).

    - Two people trading messages under 30 s apart, three or more times in the last six
      messages, are in flow: don't interrupt.
    - The latest question is unanswered after two minutes with no reply from anyone else;
      it is answered once someone other than the asker replies.
    - Exactly two people active in the last ten minutes is a two-person conversation.
    """
    msgs = sorted(messages, key=lambda m: m.ts)
    # PR #13 used the window size when the bot hadn't spoken, so a quiet channel with two
    # messages looked like the bot "spoke very recently". Not having spoken is far away.
    since_bot = NOT_SPOKEN
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].is_self:
            since_bot = len(msgs) - 1 - i
            break

    rapid = None
    recent = msgs[-6:]
    if len(recent) >= 4:
        people = []
        for m in recent:
            if not m.is_self and m.author not in people:
                people.append(m.author)
        if len(people) == 2:
            pairs = sum(1 for a, b in zip(recent, recent[1:]) if b.ts - a.ts < 30 and b.author_id != a.author_id)
            if pairs >= 3:
                rapid = (people[0], people[1])

    unanswered = answered = False
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if m.is_self or not looks_like_question(m.text):
            continue
        if now - m.ts < 120:
            break  # too recent to have been answered
        # PR #13 counted any later message from someone else, so "brb coffee" answered it.
        # A reply to the question, or a message of five or more words, counts.
        if any(r.author_id != m.author_id and (r.reply_to == m.id or len(r.text.split()) >= 5) for r in msgs[i + 1:]):
            answered = True
        else:
            unanswered = True
        break

    active = {m.author_id for m in msgs if not m.is_self and now - m.ts <= window_s}
    acts = speech_acts(msgs)
    human_acts = 0
    for act in reversed(acts):
        if act.is_self:
            break
        human_acts += 1
    return Flow(since_bot, rapid, unanswered, answered, len(active) == 2, len(active), human_acts)


@dataclass
class Classification:
    scores: dict[str, float]
    speak: bool
    confidence: float
    reason: str
    intent: str
    trigger_index: int
    search_query: str = ""

    @classmethod
    def from_json(cls, data: dict) -> "Classification":
        clamp = lambda v: max(0.0, min(1.0, float(v or 0)))
        scores = {axis: clamp((data.get("scores") or {}).get(axis)) for axis in AXES}
        intent = data.get("intent") if data.get("intent") in INTENTS else "none"
        return cls(scores, data.get("speak") is True, clamp(data.get("confidence")),
                   str(data.get("reason") or "no reason given")[:300], intent,
                   max(0, int(data.get("trigger_message_index") or 0)), str(data.get("search_query") or "")[:200])


@dataclass
class Decision:
    speak: bool
    reason: str
    confidence: float
    intent: str
    threshold: float
    trigger_index: int
    adjustments: list[str] = field(default_factory=list)


def decide(c: Classification, flow: Flow, cooldown: AdaptiveCooldown, now: float,
           dyadic_backoff: float = 0.3) -> Decision:
    """PR #13's final gate, unchanged except for PR #17's two-person backoff."""
    def silent(reason: str, confidence: float, adjustments: list[str] | None = None, threshold: float = 0.0):
        return Decision(False, reason, confidence, "none", threshold, c.trigger_index, adjustments or [])

    directed = c.scores["is_directed"]
    if not c.speak and c.confidence >= 0.7:
        return silent(c.reason, c.confidence)
    if flow.rapid_exchange and directed < DIRECTED_BYPASS:
        a, b = flow.rapid_exchange
        return silent(f"{a} and {b} are in rapid exchange, staying silent", 0.9)
    if flow.question_answered and c.intent == "answer":
        return silent("question already answered by someone else", 0.8)

    conf, notes = c.confidence, []

    def adjust(delta: float, note: str) -> None:
        nonlocal conf
        conf = max(0.0, min(1.0, conf + delta))
        notes.append(f"{delta:+.2f} {note}")

    if flow.unanswered_question and c.intent in ("answer", "unstick"):
        adjust(0.15, "unanswered question")
    if directed >= DIRECTED_BYPASS:
        adjust(0.20, "directed at the bot")
    if c.scores["is_social"] > 0.6:
        adjust(-0.30, "social or phatic")
    if flow.messages_since_bot <= 2 and directed < 0.5:
        adjust(-0.20, "the bot spoke very recently")
    if cooldown.since_last(now) > 3600:
        adjust(0.10, "silent for an hour or more")
    if c.scores["is_wrong"] > 0.7:
        adjust(0.10, "factual correction")
    # Two people talking is left alone, unless a question waits or a claim that matters is wrong.
    if flow.dyadic and directed < DIRECTED_BYPASS and not flow.unanswered_question and c.scores["is_wrong"] <= 0.7:
        conf *= dyadic_backoff
        notes.append(f"x{dyadic_backoff:.2f} two-person conversation")

    threshold = BASE_THRESHOLD if directed >= DIRECTED_BYPASS else cooldown.threshold(now)
    speak = conf >= threshold and (c.speak or conf >= HIGH_CONFIDENCE_OVERRIDE)
    if speak:
        reason = c.reason
    elif conf < threshold:
        reason = f"below the bar ({conf:.2f} < {threshold:.2f}): {c.reason}"
    else:
        reason = f"the check said not to speak ({conf:.2f}): {c.reason}"
    return Decision(speak, reason, conf, c.intent if speak else "none", threshold, c.trigger_index, notes)


def word_cap(messages: list[Msg], now: float, window_s: float = 1800, floor: int = 20, ceiling: int = 120) -> int:
    """Match the conversation's rhythm (PR #17): trimmed mean plus 1.5 standard deviations
    of the people's recent message lengths, in words, kept between 20 and 120."""
    counts = sorted(len(m.text.split()) for m in messages if not m.is_self and now - m.ts <= window_s)
    if not counts:
        return ceiling
    k = int(len(counts) * 0.1)
    trimmed = counts[k:len(counts) - k] or counts
    spread = statistics.pstdev(trimmed) if len(trimmed) > 1 else 0.0
    return int(max(floor, min(ceiling, round(statistics.mean(trimmed) + 1.5 * spread))))


def heat(messages: list[Msg], now: float, window_s: float = 900) -> dict:
    """A substantive conversation (the March bot): 3+ people, 8+ messages, over 40 characters
    on average, inside the window."""
    recent = [m for m in messages if not m.is_self and now - m.ts <= window_s]
    if not recent:
        return {"messages": 0, "people": 0, "avg_chars": 0, "hot": False}
    people = len({m.author_id for m in recent})
    avg = sum(len(m.text) for m in recent) / len(recent)
    return {"messages": len(recent), "people": people, "avg_chars": round(avg),
            "hot": people >= 3 and len(recent) >= 8 and avg > 40}


def format_context(messages: list[Msg], now: float | None = None, bot_label: str = "Router (you)") -> str:
    """Oldest first, each line indexed from the end (#0 = most recent), as the prompts expect.
    With `now`, each line also says how long ago it was posted, so the model can tell when a
    question has gone unanswered."""
    index = {m.id: len(messages) - 1 - i for i, m in enumerate(messages)}
    lines = [f"It is {time.strftime('%H:%M', time.gmtime(now))} UTC now."] if now else []
    for i, m in enumerate(messages):
        who = bot_label if m.is_self else m.author
        reply = f" (replying to #{index[m.reply_to]})" if m.reply_to in index else ""
        text = " ".join(m.text.split())[:1500]
        stamp = time.strftime('%H:%M', time.gmtime(m.ts)) + " UTC"
        if now:
            stamp += f", {ago(now - m.ts)}"
        lines.append(f"#{len(messages) - 1 - i} [{stamp}] {who}{reply}: {text}")
    return "\n".join(lines)


def ago(seconds: float) -> str:
    if seconds < 90:
        return "just now"
    if seconds < 5400:
        return f"{round(seconds / 60)} min ago"
    return f"{round(seconds / 3600)} h ago"
