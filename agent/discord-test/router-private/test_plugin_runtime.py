"""Run with the pinned gateway Python; no network or live credentials needed."""
import asyncio
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import discord
from discord.ext import commands

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("router_private_plugin_tested", root / "__init__.py", submodule_search_locations=[str(root)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)


class NativeCommandsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bot = commands.Bot(command_prefix="!", intents=discord.Intents.none())
        self.bot.tree.sync = AsyncMock(return_value=[])
        self.factory = None
        def handler(platform, factory):
            self.assertEqual(platform, "discord")
            self.factory = factory
        self.ctx = SimpleNamespace(register_platform_handler=handler,
            llm=SimpleNamespace(acomplete=AsyncMock(return_value=SimpleNamespace(text="Selected note [1]."))))
        with patch.dict(os.environ, {"HERMES_HOME": self.temp.name, "ROUTER_PRIVATE_SECRET_KEY": "synthetic"}):
            plugin.register(self.ctx)
            self.factory(self.bot, SimpleNamespace())
        await asyncio.sleep(0.01)
        self.guild = discord.Object(id=1568051145551650858)
        self.interaction = SimpleNamespace(guild_id=self.guild.id, channel_id=1568051571751788644,
            user=SimpleNamespace(id=1568048209002111017, bot=False), id=1568051571751788666,
            response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            followup=SimpleNamespace(send=AsyncMock()))

    async def asyncTearDown(self):
        await self.bot.close()
        self.temp.cleanup()

    async def test_native_registration_is_guild_specific_and_valid(self):
        expected={"router-link", "router-save", "router-recall", "router-read", "router-status", "router-unlink"}
        self.assertEqual({c.name for c in self.bot.tree.get_commands(guild=self.guild)}, expected)
        self.assertEqual(self.bot.tree.get_commands(), [])
        self.bot.tree.sync.assert_awaited_once_with(guild=self.guild)
        for command in self.bot.tree.get_commands(guild=self.guild):
            self.assertEqual(command.to_dict(self.bot.tree)["name"], command.name)

    async def test_missing_link_is_ephemeral_and_never_reaches_model(self):
        command=self.bot.tree.get_command("router-recall", guild=self.guild)
        await command.callback(self.interaction, "selected")
        self.interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        response=self.interaction.followup.send.call_args
        self.assertIn("/router-link", response.args[0])
        self.assertTrue(response.kwargs["ephemeral"])
        self.ctx.llm.acomplete.assert_not_called()

    async def test_browser_link_uses_private_replies_without_a_model_or_secret_key(self):
        started = {"pairing": "RD-PAIR-" + "x" * 32, "url": "https://router.example/group-setup?group=test#discord-pair=synthetic"}
        finished = {"handle": "alice", "groupId": "test", "expiresAt": 999999}
        with patch.object(plugin.PrivateRouter, "begin_pair", AsyncMock(return_value=started)), \
                patch.object(plugin.PrivateRouter, "wait_pair", AsyncMock(return_value=finished)):
            command = self.bot.tree.get_command("router-link", guild=self.guild)
            self.assertFalse(command.to_dict(self.bot.tree)["options"][0]["required"])
            await command.callback(self.interaction)
            await asyncio.sleep(0.03)
        self.assertGreaterEqual(self.interaction.followup.send.call_count, 3)
        for call in self.interaction.followup.send.call_args_list:
            self.assertTrue(call.kwargs["ephemeral"])
        self.assertIn("Connected @alice", self.interaction.followup.send.call_args.args[0])
        self.ctx.llm.acomplete.assert_not_called()

    async def test_wrong_channel_is_ephemeral_and_does_not_defer(self):
        self.interaction.channel_id=1568051146172403816
        await self.bot.tree.get_command("router-save", guild=self.guild).callback(self.interaction, "synthetic")
        self.assertTrue(self.interaction.response.send_message.call_args.kwargs["ephemeral"])
        self.interaction.response.defer.assert_not_called()
        self.ctx.llm.acomplete.assert_not_called()

    async def test_guild_mode_saves_from_general_with_a_named_private_audience(self):
        settings={"base_url":"https://router.example", "guild_id":str(self.guild.id),
                  "scope":"guild", "group_id":"private-test"}
        with patch.dict(os.environ, {"HERMES_HOME":self.temp.name, "ROUTER_PRIVATE_SECRET_KEY":"synthetic"}), \
                patch.object(plugin.json, "loads", return_value=settings):
            plugin.register(self.ctx)
            self.factory(self.bot, SimpleNamespace())
        await asyncio.sleep(0.01)
        self.interaction.channel_id=1568051146172403816
        self.assertIn("#private-test", self.bot.tree.get_command("router-save", guild=self.guild).description)
        operation=AsyncMock(return_value={"groupId":"private-test", "entry":{"id":"sample", "handle":"alice"}})
        with patch.object(plugin.PrivateRouter, "operate", operation):
            await self.bot.tree.get_command("router-save", guild=self.guild).callback(self.interaction, "Selected note")
        operation.assert_awaited_once()
        self.interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        response=self.interaction.followup.send.call_args
        self.assertTrue(response.kwargs["ephemeral"])
        self.assertIn("#private-test", response.args[0])
        self.ctx.llm.acomplete.assert_not_called()


if __name__ == "__main__":
    unittest.main()
