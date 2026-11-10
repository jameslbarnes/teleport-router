"""Router takes part in its Discord channel without being @-mentioned.

Hermes still answers @-mentions; this plugin only watches everything else and, when a
cheap check says there is something worth adding, writes and posts one reply (see
participation.py for the rules and controller.py for the modes). Members can pause it
with /router-quiet, see its reasoning with /router-why, and see what drew replies with
/router-stats. Message text never goes to the logs.
"""
import asyncio
import json
import logging
import os
import time
from pathlib import Path

from .controller import Controller
from .participation import Msg
from .store import Store

log = logging.getLogger(__name__)


def load_settings(root: Path) -> dict:
    settings = json.loads((root / "settings.json").read_text(encoding="utf-8"))
    local = root / "settings.local.json"  # per-deployment note and MCP servers; kept out of the repository
    if local.exists():
        settings.update(json.loads(local.read_text(encoding="utf-8")))
    return settings


def register(ctx):
    root = Path(__file__).parent
    settings = load_settings(root)
    private_conversation = settings.get("private_conversation") is True
    store = Store(":memory:" if private_conversation else Path(os.environ["HERMES_HOME"]) / "plugin-data" / "router-participation" / "participation.db",
                  settings.get("retention_days", 30))
    if settings.get("mode", "shadow") != "off" and not os.environ.get("ANTHROPIC_API_KEY"):
        log.warning("router-participation has no model key; it will record messages only")
        settings["mode"] = "off"
    controller = Controller(settings, store, None)

    async def load_models():
        # Not in register(): Hermes gives a plugin 10 seconds to load, and on a cold start the
        # SDK import alone took most of that. Until it's loaded, checks are skipped and logged.
        def build():
            from .models import Brain
            return Brain(settings)
        try:
            controller.brain = await asyncio.to_thread(build)
        except Exception as exc:
            log.warning("router-participation couldn't load its model client (%s)", type(exc).__name__)

    def install(native, adapter):
        import discord
        from discord import app_commands

        channel_id = int(settings["channel_id"])
        guild = discord.Object(id=int(settings["guild_id"]))
        test_webhooks = {int(w) for w in settings.get("test_webhook_ids", [])}
        if private_conversation:
            from .group_memory import GroupTurn
            async def make_turn(key, trigger):
                router = getattr(adapter, "router_private", None)
                if router is None or controller.brain is None:
                    raise RuntimeError("Private Router connection unavailable")
                return await GroupTurn(controller.brain, router, guild.id, key, trigger).start()
            controller.turn_factory = make_turn

        def watched(channel_or_id, parent_id=None):
            cid = getattr(channel_or_id, "id", channel_or_id)
            parent = getattr(channel_or_id, "parent_id", parent_id)
            return cid if cid == channel_id or (not private_conversation and parent == channel_id) else None

        def to_msg(message) -> Msg:
            ref = message.reference.message_id if message.reference else None
            own = bool(native.user and message.author.id == native.user.id)
            text = "[Earlier bot reply omitted; read current Router sources.]" if private_conversation and own else message.content or ""
            return Msg(message.id, message.author.id, message.author.display_name, text,
                       message.created_at.timestamp(), bool(native.user and message.author.id == native.user.id), ref)

        async def on_message(message):
            key = watched(message.channel)
            if key is None or message.type not in (discord.MessageType.default, discord.MessageType.reply):
                return
            if private_conversation and getattr(getattr(message, "guild", None), "id", None) != guild.id:
                return
            m = to_msg(message)
            controller.record(key, m)
            if m.is_self:
                return
            person = not message.author.bot or (not private_conversation and message.webhook_id is not None and message.webhook_id in test_webhooks)
            summoned = native.user is not None and native.user in message.mentions  # Hermes answers these
            if person and not m.text.startswith("/"):
                if private_conversation and summoned:
                    controller.mentioned(key, m)
                elif not summoned:
                    controller.human_message(key, m)

        async def on_raw_message_edit(payload):
            if watched(payload.channel_id, getattr(payload, "parent_id", None)) and "content" in payload.data:
                old = store.get_message(payload.message_id)
                if private_conversation and old and old.is_self:
                    return
                store.edit_message(payload.message_id, payload.data["content"])

        async def on_raw_message_delete(payload):
            store.delete_message(payload.message_id)

        async def on_raw_reaction_add(payload):
            if native.user and payload.user_id != native.user.id and store.get_message(payload.message_id):
                store.add_reaction(payload.message_id, payload.user_id, str(payload.emoji))

        async def on_raw_reaction_remove(payload):
            store.remove_reaction(payload.message_id, payload.user_id, str(payload.emoji))

        async def post(key: int, text: str, trigger_id: int) -> int:
            channel = native.get_channel(key) or await native.fetch_channel(key)
            reference = discord.MessageReference(message_id=trigger_id, channel_id=key, fail_if_not_exists=False)
            sent = await channel.send(text, reference=reference, allowed_mentions=discord.AllowedMentions.none(),
                                      suppress_embeds=True)
            return sent.id

        controller.poster = post
        for name, fn in (("on_message", on_message), ("on_raw_message_edit", on_raw_message_edit),
                         ("on_raw_message_delete", on_raw_message_delete), ("on_raw_reaction_add", on_raw_reaction_add),
                         ("on_raw_reaction_remove", on_raw_reaction_remove)):
            native.add_listener(fn, name)

        async def reply(interaction, text: str):
            for start in range(0, len(text), 1800):
                await interaction.followup.send(text[start:start + 1800], ephemeral=True,
                                                allowed_mentions=discord.AllowedMentions.none(), suppress_embeds=True)

        async def guarded(interaction) -> int | None:
            parent = getattr(getattr(interaction, "channel", None), "parent_id", None)
            key = watched(interaction.channel_id, parent) if interaction.guild_id == guild.id else None
            if key is None or interaction.user.bot:
                await interaction.response.send_message("This command works in the Router test channel only.", ephemeral=True)
                return None
            await interaction.response.defer(ephemeral=True, thinking=True)
            return key

        @app_commands.command(name="router-quiet", description="Stop Router from speaking unprompted here for a while")
        @app_commands.describe(hours="Hours to stay quiet; 0 lets it speak unprompted again")
        async def quiet(interaction, hours: app_commands.Range[int, 0, 72] = 4):
            key = await guarded(interaction)
            if key is None:
                return
            store.pause(key, time.time() + hours * 3600, interaction.user.id)
            await reply(interaction, f"Router won't speak here unprompted for {hours} hours. It still answers @-mentions."
                        if hours else "Router may speak here unprompted again.")

        @app_commands.command(name="router-why", description="Why Router spoke or stayed quiet recently")
        async def why(interaction):
            key = await guarded(interaction)
            if key is None:
                return
            await reply(interaction, describe_decisions(store.decisions(key, limit=5), discord.utils.escape_markdown))

        @app_commands.command(name="router-stats", description="Replies and reactions to Router's posts here")
        @app_commands.describe(days="How many days back to count")
        async def stats(interaction, days: app_commands.Range[int, 1, 30] = 7):
            key = await guarded(interaction)
            if key is None:
                return
            since = time.time() - days * 86400
            await reply(interaction, describe_stats(store.engagement(key, since), store, since, days))

        for command in (quiet, why, stats):
            native.tree.add_command(command, guild=guild, override=True)

        async def sync():
            try:
                await asyncio.wait_for(native.tree.sync(guild=guild), timeout=30)
            except Exception:
                log.warning("router-participation command registration failed; no request details logged.")

        async def purge_daily():
            while True:
                store.purge()
                await asyncio.sleep(6 * 3600)

        async def catch_up(limit: int = 100):
            """Record what was said while the plugin wasn't running, without checking any of it,
            so a restart keeps the context and the stats cover earlier posts (the Telegram bot
            lost its buffer on every restart)."""
            try:
                await native.wait_until_ready()
                channel = native.get_channel(channel_id) or await native.fetch_channel(channel_id)
                async for message in channel.history(limit=limit):
                    if message.type not in (discord.MessageType.default, discord.MessageType.reply):
                        continue
                    m = to_msg(message)
                    store.add_message(channel_id, m)
                    if m.is_self:
                        for reaction in message.reactions:
                            async for user in reaction.users():
                                if user.id != native.user.id:
                                    store.add_reaction(m.id, user.id, str(reaction.emoji), m.ts)
                controller.cooldowns.clear()  # rebuilt from the store, with the bot's earlier posts
            except Exception as exc:
                log.warning("router-participation couldn't read recent channel history (%s)", type(exc).__name__)

        asyncio.ensure_future(sync())
        asyncio.ensure_future(purge_daily())
        asyncio.ensure_future(catch_up())
        if controller.s["mode"] != "off":
            asyncio.ensure_future(load_models())
        log.info("router-participation watching channel %s in %s mode", channel_id, settings.get("mode", "shadow"))

    ctx.register_platform_handler("discord", install)


OUTCOMES = {
    "silent": "stayed silent", "shadow": "would speak (shadow, no draft)", "shadow-drafted": "would speak (shadow)",
    "shadow-skipped": "would speak, then found nothing worth adding", "skipped": "drafted, then found nothing worth adding",
    "posted": "spoke", "superseded": "drafted, but someone else's question got an answer first",
    "rate-limited": "stayed silent (unprompted-post limit)", "paused": "stayed silent (/router-quiet)",
    "budget": "stayed silent (daily budget)", "draft-budget": "would speak, but the daily draft budget was used",
    "check-failed": "couldn't run the check", "draft-failed": "couldn't draft a reply",
    "shadow-draft-failed": "would speak, but couldn't draft a reply", "post-failed": "couldn't post its reply",
}


def describe_decisions(decisions: list[dict], escape=lambda s: s) -> str:
    if not decisions:
        return "No decisions recorded here yet."
    lines = ["Most recent first (times UTC):"]
    for d in decisions:
        stamp = time.strftime("%H:%M", time.gmtime(d["ts"]))
        line = f"- {stamp}: {OUTCOMES.get(d['outcome'], d['outcome'])}"
        scores = d["detail"].get("scores")
        if scores:
            line += f". Confidence {d['confidence']:.2f}, bar {d['threshold']:.2f}"
            top = sorted(((v, k) for k, v in scores.items() if v >= 0.5), reverse=True)[:3]
            if top:
                line += " (" + ", ".join(f"{k.removeprefix('is_')} {v:.1f}" for v, k in top) + ")"
        line += f". {escape(d['reason'] or '')}"
        if d.get("draft"):
            line += f"\n  Draft: {escape(d['draft'][:500])}"
        lines.append(line)
    return "\n".join(lines)


def describe_stats(engagement: dict, store: Store, since: float, days: int) -> str:
    labels = {"unprompted": "Unprompted replies", "reply": "Answers to @-mentions", "post": "Other posts (digests, issues)"}
    lines = [f"Router's posts here in the last {days} days:"]
    for kind in ("unprompted", "reply", "post"):
        s = engagement.get(kind)
        if s:
            lines.append(f"- {labels[kind]}: {s['posts']}, of which {s['engaged']} drew a reply or reaction "
                         f"({s['replies']} replies, {s['reactions']} reactions, {s['people']} people)")
    if len(lines) == 1:
        lines.append("- none")
    checks = store.count_checks(since)
    spoke = store.count_decisions(since, "posted")
    shadow = store.count_decisions(since, "shadow")
    lines.append(f"Checks run: {checks}; spoke unprompted {spoke} times; would have spoken in shadow mode {shadow} times.")
    return "\n".join(lines)
