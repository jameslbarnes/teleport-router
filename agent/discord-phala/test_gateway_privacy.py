"""Exercise the shipped Hermes adapter, not just our interpretation of its YAML."""
import os
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from utils import fast_safe_load
from gateway.config import Platform
from plugins.platforms.discord.adapter import DiscordAdapter, _apply_yaml_config


class GatewayPrivacyTest(unittest.IsolatedAsyncioTestCase):
    async def test_private_channel_never_dispatches_into_saved_hermes_sessions(self):
        config = fast_safe_load((Path(__file__).parent / "config.yaml").read_text(encoding="utf-8"))
        self.assertFalse(config["discord"]["history_backfill"])
        self.assertEqual(config["discord"]["extra"]["group_allowed_chats"], [])
        # Deliberately allow the user at the central gateway. The adapter must
        # still reject the group message before a session or history is made.
        with patch.dict(os.environ, {"DISCORD_ALLOW_ALL_USERS": "true"}, clear=True):
            seeded = _apply_yaml_config(config, config["discord"])
            adapter = object.__new__(DiscordAdapter)
            adapter.config = NS(extra={**config["discord"]["extra"], **seeded})
            adapter.platform = Platform.DISCORD
            adapter._gate_env_snapshot = None
            adapter._client = NS(user=NS(id=99))
            adapter.handle_message = AsyncMock()
            for text in ("<@99> Explain our private note", "Ordinary group conversation"):
                message = NS(content=text, mentions=[NS(id=99)], message_snapshots=[],
                    channel=NS(id=int(config["discord"]["allowed_channels"][0]), name="test", parent_id=None))
                self.assertFalse(await adapter._handle_message(message, role_authorized=True))
            adapter.handle_message.assert_not_called()


if __name__ == "__main__":
    unittest.main()
