"""Local SQLite record of the watched channel (PR #16's message capture, for Discord).

Messages are kept only for `retention_days`, never logged, and never leave this machine
except as conversation context sent to the model when the bot decides whether to speak.
Reactions and replies to the bot's own posts are counted, the measurement the Telegram
bot never had.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from .participation import Msg

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, author_id INTEGER NOT NULL, author TEXT NOT NULL,
  text TEXT NOT NULL, ts REAL NOT NULL, is_self INTEGER NOT NULL, reply_to INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages(channel_id, ts);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, ts REAL NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji));
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, ts REAL NOT NULL, trigger_id INTEGER,
  mode TEXT NOT NULL, speak INTEGER NOT NULL, intent TEXT, confidence REAL, threshold REAL, reason TEXT,
  detail TEXT, outcome TEXT NOT NULL, posted_id INTEGER, draft TEXT);
CREATE INDEX IF NOT EXISTS decisions_channel_ts ON decisions(channel_id, ts);
CREATE TABLE IF NOT EXISTS pauses (channel_id INTEGER PRIMARY KEY, until REAL NOT NULL, by_user INTEGER NOT NULL);
"""


class Store:
    def __init__(self, path: Path | str, retention_days: float = 30):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        # Hermes loads plugins on one thread and runs Discord events on its event-loop thread.
        # All use after loading happens on that one loop, so sharing the connection is safe.
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.retention_s = retention_days * 86400

    def close(self) -> None:
        self.db.close()

    # Messages ---------------------------------------------------------------
    def add_message(self, channel_id: int, m: Msg) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO messages (id, channel_id, author_id, author, text, ts, is_self, reply_to) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (m.id, channel_id, m.author_id, m.author, m.text, m.ts, int(m.is_self), m.reply_to))

    def edit_message(self, message_id: int, text: str) -> None:
        with self.db:
            self.db.execute("UPDATE messages SET text = ? WHERE id = ?", (text, message_id))

    def delete_message(self, message_id: int) -> None:
        # Keep the row so reply counts stay right, but drop what was said.
        with self.db:
            self.db.execute("UPDATE messages SET text = '', deleted = 1 WHERE id = ?", (message_id,))

    def recent(self, channel_id: int, limit: int = 40, since: float | None = None) -> list[Msg]:
        rows = self.db.execute(
            "SELECT id, author_id, author, text, ts, is_self, reply_to FROM messages "
            "WHERE channel_id = ? AND deleted = 0 AND ts >= ? ORDER BY ts DESC LIMIT ?",
            (channel_id, since or 0, limit)).fetchall()
        return [Msg(r[0], r[1], r[2], r[3], r[4], bool(r[5]), r[6]) for r in reversed(rows)]

    def get_message(self, message_id: int) -> Msg | None:
        r = self.db.execute("SELECT id, author_id, author, text, ts, is_self, reply_to FROM messages WHERE id = ?",
                            (message_id,)).fetchone()
        return Msg(r[0], r[1], r[2], r[3], r[4], bool(r[5]), r[6]) if r else None

    def bot_post_times(self, channel_id: int, since: float) -> list[float]:
        return [r[0] for r in self.db.execute(
            "SELECT ts FROM messages WHERE channel_id = ? AND is_self = 1 AND ts >= ? ORDER BY ts", (channel_id, since))]

    # Reactions ----------------------------------------------------------------
    def add_reaction(self, message_id: int, user_id: int, emoji: str, ts: float | None = None) -> None:
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO reactions VALUES (?, ?, ?, ?)", (message_id, user_id, emoji, ts or time.time()))

    def remove_reaction(self, message_id: int, user_id: int, emoji: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", (message_id, user_id, emoji))

    # Decisions ----------------------------------------------------------------
    def log_decision(self, channel_id: int, ts: float, trigger_id: int | None, mode: str, speak: bool, intent: str,
                     confidence: float, threshold: float, reason: str, detail: dict, outcome: str) -> int:
        with self.db:
            cur = self.db.execute(
                "INSERT INTO decisions (channel_id, ts, trigger_id, mode, speak, intent, confidence, threshold, reason, detail, outcome) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (channel_id, ts, trigger_id, mode, int(speak), intent, confidence, threshold, reason, json.dumps(detail), outcome))
            return int(cur.lastrowid)

    def set_outcome(self, decision_id: int, outcome: str, posted_id: int | None = None, draft: str | None = None) -> None:
        with self.db:
            self.db.execute("UPDATE decisions SET outcome = ?, posted_id = COALESCE(?, posted_id), draft = COALESCE(?, draft) WHERE id = ?",
                            (outcome, posted_id, draft, decision_id))

    def decisions(self, channel_id: int, limit: int = 5) -> list[dict]:
        cols = ("id", "ts", "trigger_id", "mode", "speak", "intent", "confidence", "threshold", "reason", "detail", "outcome", "posted_id", "draft")
        rows = self.db.execute(f"SELECT {', '.join(cols)} FROM decisions WHERE channel_id = ? ORDER BY ts DESC LIMIT ?",
                               (channel_id, limit)).fetchall()
        return [dict(zip(cols, r), detail=json.loads(r[9] or "{}")) for r in rows]

    def unprompted_post_times(self, since: float) -> list[float]:
        return [r[0] for r in self.db.execute(
            "SELECT ts FROM decisions WHERE outcome = 'posted' AND ts >= ? ORDER BY ts", (since,))]

    def count_decisions(self, since: float, outcome_prefix: str = "") -> int:
        return self.db.execute("SELECT COUNT(*) FROM decisions WHERE ts >= ? AND outcome LIKE ?",
                               (since, outcome_prefix + "%")).fetchone()[0]

    def count_checks(self, since: float) -> int:
        """Decisions that called the model (skips for pauses and limits don't count)."""
        return self.db.execute("SELECT COUNT(*) FROM decisions WHERE ts >= ? AND outcome NOT IN "
                               "('paused', 'rate-limited', 'budget')", (since,)).fetchone()[0]

    # Quiet periods ------------------------------------------------------------
    def pause(self, channel_id: int, until: float, by_user: int) -> None:
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO pauses VALUES (?, ?, ?)", (channel_id, until, by_user))

    def paused_until(self, channel_id: int) -> float:
        r = self.db.execute("SELECT until FROM pauses WHERE channel_id = ?", (channel_id,)).fetchone()
        return r[0] if r else 0.0

    # Measurement --------------------------------------------------------------
    def engagement(self, channel_id: int, since: float) -> dict[str, dict]:
        """Per kind of bot post: how many, how many drew a human reply or reaction,
        total human replies and reactions, and how many different people engaged."""
        unprompted = {r[0] for r in self.db.execute("SELECT posted_id FROM decisions WHERE posted_id IS NOT NULL")}
        posts = self.db.execute("SELECT id, reply_to FROM messages WHERE channel_id = ? AND is_self = 1 AND ts >= ?",
                                (channel_id, since)).fetchall()
        out: dict[str, dict] = {}
        for post_id, reply_to in posts:
            kind = "unprompted" if post_id in unprompted else ("reply" if reply_to else "post")
            replies = self.db.execute("SELECT author_id FROM messages WHERE reply_to = ? AND is_self = 0", (post_id,)).fetchall()
            reacts = self.db.execute("SELECT user_id FROM reactions WHERE message_id = ?", (post_id,)).fetchall()
            s = out.setdefault(kind, {"posts": 0, "engaged": 0, "replies": 0, "reactions": 0, "people": set()})
            s["posts"] += 1
            s["engaged"] += int(bool(replies or reacts))
            s["replies"] += len(replies)
            s["reactions"] += len(reacts)
            s["people"].update(a for (a,) in replies + reacts)
        for s in out.values():
            s["people"] = len(s["people"])
        return out

    def purge(self, now: float | None = None) -> None:
        cutoff = (now or time.time()) - self.retention_s
        with self.db:
            self.db.execute("DELETE FROM messages WHERE ts < ?", (cutoff,))
            self.db.execute("DELETE FROM reactions WHERE ts < ?", (cutoff,))
            self.db.execute("DELETE FROM decisions WHERE ts < ?", (cutoff,))
