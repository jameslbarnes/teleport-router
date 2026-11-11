"""Discord wiring with the pinned gateway Python; no network or live credentials needed."""
import asyncio
import datetime as dt
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, PropertyMock, patch

import discord
from discord.ext import commands

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("router_participation_plugin_tested", root / "__init__.py",
                                              submodule_search_locations=[str(root)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)

GUILD, CHANNEL, OTHER = 1568051145551650858, 1568051571751788644, 1568051146172403816
BOT_USER = NS(id=1568056630380200118)
TEST_HOOK = 1570000000000000001


class PluginRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bot = commands.Bot(command_prefix="!", intents=discord.Intents.none())
        self.bot.tree.sync = AsyncMock(return_value=[])
        self.user_patch = patch.object(commands.Bot, "user", new_callable=PropertyMock, return_value=BOT_USER)
        self.user_patch.start()
        self.factory = None

        def handler(platform, factory):
            self.assertEqual(platform, "discord")
            self.factory = factory

        # Recent history the plugin catches up on at start: a person's message and a bot post with a reaction.
        when = dt.datetime(2026, 11, 8, 11, 0, tzinfo=dt.timezone.utc)

        async def reactors():
            yield NS(id=7)
        earlier = [
            NS(id=11, content="An earlier question?", type=discord.MessageType.default, reference=None, reactions=[],
               author=NS(id=7, display_name="Ada", bot=False), created_at=when),
            NS(id=12, content="Scaling digest", type=discord.MessageType.default, reference=None,
               reactions=[NS(emoji="👍", users=reactors)], author=NS(id=BOT_USER.id, display_name="Router Test", bot=True),
               created_at=when + dt.timedelta(minutes=1)),
        ]

        async def history(limit):
            for m in reversed(earlier):
                yield m
        self.bot.wait_until_ready = AsyncMock()
        self.bot.get_channel = lambda cid: NS(history=history) if cid == CHANNEL else None
        settings = {"guild_id": str(GUILD), "channel_id": str(CHANNEL), "mode": "shadow", "test_webhook_ids": [TEST_HOOK]}
        self.stores, real_store = [], plugin.Store
        self.human_patch = patch.object(plugin.Controller, "human_message")
        self.human = self.human_patch.start()
        with patch.dict(os.environ, {"HERMES_HOME": self.temp.name, "ANTHROPIC_API_KEY": "synthetic"}), \
                patch.object(plugin, "load_settings", return_value=settings), \
                patch.object(plugin, "Store", side_effect=lambda *a, **k: self.stores.append(real_store(*a, **k)) or self.stores[-1]):
            plugin.register(NS(register_platform_handler=handler))
            self.factory(self.bot, NS())
        await asyncio.sleep(0.01)
        self.on_message = self.bot.extra_events["on_message"][0]

    async def asyncTearDown(self):
        self.human_patch.stop()
        self.user_patch.stop()
        await self.bot.close()
        for store in self.stores:
            store.close()
        self.temp.cleanup()

    def message(self, mid, text, author_id=7, bot=False, channel=CHANNEL, mentions=(), webhook_id=None, reply_to=None):
        return NS(id=mid, content=text, type=discord.MessageType.default, channel=NS(id=channel, parent_id=None),
                  author=NS(id=author_id, display_name="Ada", bot=bot), mentions=list(mentions), webhook_id=webhook_id,
                  created_at=dt.datetime(2026, 11, 8, 12, 0, tzinfo=dt.timezone.utc),
                  reference=NS(message_id=reply_to) if reply_to else None)

    async def test_registers_listeners_and_guild_commands(self):
        for name in ("on_message", "on_raw_message_edit", "on_raw_message_delete", "on_raw_reaction_add", "on_raw_reaction_remove"):
            self.assertEqual(len(self.bot.extra_events[name]), 1, name)
        guild = discord.Object(id=GUILD)
        self.assertEqual({c.name for c in self.bot.tree.get_commands(guild=guild)}, {"router-quiet", "router-why", "router-stats"})
        self.assertEqual(self.bot.tree.get_commands(), [])
        self.bot.tree.sync.assert_awaited_once_with(guild=guild)

    async def test_catches_up_on_recent_history_without_checking_it(self):
        store = self.stores[0]
        self.assertEqual([(m.id, m.is_self) for m in store.recent(CHANNEL)], [(11, False), (12, True)])
        self.assertEqual(store.engagement(CHANNEL, 0)["post"]["reactions"], 1)
        self.human.assert_not_called()

    async def test_only_unmentioned_human_messages_reach_the_check(self):
        await self.on_message(self.message(1, "Does anyone know?"))
        self.assertEqual(self.human.call_count, 1)
        await self.on_message(self.message(2, "@Router what do you think?", mentions=[BOT_USER]))  # Hermes answers
        await self.on_message(self.message(3, "my own post", author_id=BOT_USER.id, bot=True))
        await self.on_message(self.message(4, "another bot", author_id=8, bot=True, webhook_id=1234))
        await self.on_message(self.message(5, "elsewhere", channel=OTHER))
        self.assertEqual(self.human.call_count, 1)
        await self.on_message(self.message(6, "simulated participant", author_id=TEST_HOOK, bot=True, webhook_id=TEST_HOOK))
        self.assertEqual(self.human.call_count, 2)

    async def test_commands_answer_privately_and_only_in_the_channel(self):
        def interaction(channel):
            return NS(guild_id=GUILD, channel_id=channel, channel=NS(parent_id=None), user=NS(id=7, bot=False),
                      response=NS(defer=AsyncMock(), send_message=AsyncMock()), followup=NS(send=AsyncMock()))
        quiet = self.bot.tree.get_command("router-quiet", guild=discord.Object(id=GUILD))
        wrong = interaction(OTHER)
        await quiet.callback(wrong, 4)
        self.assertTrue(wrong.response.send_message.call_args.kwargs["ephemeral"])
        wrong.response.defer.assert_not_called()
        right = interaction(CHANNEL)
        await quiet.callback(right, 4)
        right.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        self.assertIn("won't speak here unprompted for 4 hours", right.followup.send.call_args.args[0])
        self.assertTrue(right.followup.send.call_args.kwargs["ephemeral"])
        why = self.bot.tree.get_command("router-why", guild=discord.Object(id=GUILD))
        right = interaction(CHANNEL)
        await why.callback(right)
        self.assertIn("No decisions recorded", right.followup.send.call_args.args[0])

    def test_describe_decisions_reads_plainly(self):
        text = plugin.describe_decisions([{"ts": 1_800_000_000, "outcome": "shadow-drafted", "confidence": 0.71, "threshold": 0.3,
                                           "reason": "unanswered question", "detail": {"scores": {"is_question": 0.9, "is_social": 0.0}},
                                           "draft": "Two entries disagree."}])
        self.assertIn("would speak (shadow). Confidence 0.71, bar 0.30 (question 0.9). unanswered question", text)
        self.assertIn("Draft: Two entries disagree.", text)


class PrivateChannelRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.bot=commands.Bot(command_prefix="!",intents=discord.Intents.none())
        self.bot.tree.sync=AsyncMock(return_value=[])
        self.bot.wait_until_ready=AsyncMock()
        self.bot.get_channel=lambda cid: NS(history=self.history)
        self.user_patch=patch.object(commands.Bot,"user",new_callable=PropertyMock,return_value=BOT_USER)
        self.user_patch.start()
        self.controllers=[]; self.stores=[]
        real_controller,real_store=plugin.Controller,plugin.Store
        def install(platform,factory): factory(self.bot,NS())
        settings={"guild_id":str(GUILD),"channel_id":str(CHANNEL),"mode":"shadow","private_conversation":True}
        with patch.dict(os.environ,{"HERMES_HOME":self.temp.name,"ANTHROPIC_API_KEY":"synthetic"}), \
            patch.object(plugin,"load_settings",return_value=settings), \
            patch.object(plugin,"Controller",side_effect=lambda *a,**k:self.controllers.append(real_controller(*a,**k)) or self.controllers[-1]), \
            patch.object(plugin,"Store",side_effect=lambda *a,**k:self.stores.append(real_store(*a,**k)) or self.stores[-1]):
            plugin.register(NS(register_platform_handler=install))
        await asyncio.sleep(0.01)
        self.controller=self.controllers[0]
        # Listener methods are synchronous scheduling functions, so use a plain Mock.
        from unittest.mock import Mock
        self.controller.mentioned=Mock(); self.controller.human_message=Mock()
        self.listener=self.bot.extra_events["on_message"][0]

    async def history(self,limit):
        if False: yield None

    def message(self,mid,text,bot=False,mentions=(),parent=None,channel=CHANNEL):
        return NS(id=mid,content=text,type=discord.MessageType.default,guild=NS(id=GUILD),
            channel=NS(id=channel,parent_id=parent),author=NS(id=BOT_USER.id if bot else 7,display_name="Ada",bot=bot),
            mentions=list(mentions),webhook_id=None,created_at=dt.datetime.now(dt.timezone.utc),reference=None)

    async def asyncTearDown(self):
        self.user_patch.stop();await self.bot.close()
        for store in self.stores: store.close()
        self.temp.cleanup()

    async def test_private_mentions_route_once_and_threads_stay_out(self):
        await self.listener(self.message(1,"@Router tell me",mentions=[BOT_USER]))
        self.controller.mentioned.assert_called_once()
        self.controller.human_message.assert_not_called()
        await self.listener(self.message(2,"ordinary question"))
        self.controller.human_message.assert_called_once()
        await self.listener(self.message(3,"thread",parent=CHANNEL,channel=OTHER,mentions=[BOT_USER]))
        self.controller.mentioned.assert_called_once()

    async def test_a_mention_in_another_text_channel_is_answered_and_other_talk_there_is_ignored(self):
        def elsewhere(mid,text,mentions=()):
            m=self.message(mid,text,mentions=mentions,channel=OTHER); m.channel.type=discord.ChannelType.text; return m
        await self.listener(elsewhere(20,"not for the bot"))
        self.controller.mentioned.assert_not_called(); self.controller.human_message.assert_not_called()
        self.assertIsNone(self.stores[0].get_message(20))
        await self.listener(elsewhere(21,"@Router what did I write last?",mentions=[BOT_USER]))
        self.controller.mentioned.assert_called_once()
        self.assertEqual(self.controller.mentioned.call_args.args[0],OTHER)
        self.controller.human_message.assert_not_called()

    async def test_private_reply_text_never_enters_store_or_disk_even_on_edit(self):
        await self.listener(self.message(10,"SENSITIVE source from private recall",bot=True))
        self.assertNotIn("SENSITIVE",self.stores[0].get_message(10).text)
        edit=self.bot.extra_events["on_raw_message_edit"][0]
        await edit(NS(channel_id=CHANNEL,message_id=10,data={"content":"SENSITIVE edited source"}))
        self.assertNotIn("SENSITIVE",self.stores[0].get_message(10).text)
        self.assertEqual(list(Path(self.temp.name).rglob("*.db")),[])


if __name__ == "__main__":
    unittest.main()
