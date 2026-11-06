# Private Discord test profile

This profile gives the Router Test Discord bot its own Hermes home and Router identity. It is separate from the Shape agent on Phala. It reads public notebook entries and replies only in the test channel; it does not publish Discord messages.

- Server: `1568051145551650858`
- Channel: `1568051571751788644`
- Application: `1568056630380200118`
- Runtime root on Tulip: `%LOCALAPPDATA%\teleport-router\discord-test`
- Private Hermes state on Tulip: `C:\RouterDiscord` (short path avoids Windows path-length failures during dependency installation)
- Hermes release: `v0.23.0`, commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`

Copy `config.yaml` and `SOUL.md` to the private Hermes state directory. Its protected `.env` supplies `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, and this bot's `ROUTER_SECRET_KEY`. Never copy James's notebook key or the Shape agent's configuration into this profile.

Keep `DISCORD_ALLOWED_USERS` and `DISCORD_ALLOWED_ROLES` empty and both allow-all switches false. The Discord adapter requires `allowed_channels`, and the central gateway separately requires `extra.group_allowed_chats`; both must name only the test channel. Both layers deny DMs and other channels. Discord permission overwrites also deny access to the other channels. `group_allow_admin_from` restricts administrative slash commands to the owner.

After installation, verify the running version, effective tool list, denied DM/other-channel authorization, and an actual Discord message and bot reply that calls notebook search. A successful REST request alone does not verify the Gateway connection.

## Setup status (November 5, 2026)

The bot is online in the test server. Its token is stored in the protected runtime `.env`. The hidden Windows task `Teleport Router Discord Test` runs the isolated gateway at startup and retries failed exits up to three times, one minute apart; duplicate starts are ignored. No production Router deployment was changed.

Verified against the pinned runtime and this profile:

- Live MCP discovery and the effective Discord tool list expose exactly `mcp__router__router_search` and `mcp__router__router_get_entry`.
- The actual Discord adapter and central gateway authorization both permit the test channel and deny `general`, `feedback`, and DMs. Discord REST calls independently return 200 for test-channel messages and 403 for general/feedback; the bot cannot view the voice channel and has no administrator or management permissions.
- A separate notebook identity can search the public notebook, and the configured model credential passes the provider's model-metadata request.
- The private `.env` inherits access only for the Windows administrator account and SYSTEM.

- A real user message in Discord triggered public notebook search and entry retrieval, followed by the bot's visible summary at 20:06 EST. The tested entry was `mnm8jri0-3mdwez`.
- The scheduled task starts successfully and stays attached to the gateway process. Graceful profile shutdown returns task exit code 0. Reboot recovery is configured but has not been tested by rebooting Tulip.

The Windows wrapper uses `Start-Process` with separate stdout/stderr files because PowerShell's terminating error preference treated a native stderr warning as a fatal error. Keep `logging.level: WARNING`: this upstream version's HTTP request INFO logger otherwise writes the notebook query-string credential. Earlier private log copies were scrubbed, and a scan after the live test found no raw credentials in logs.

The test bot has no notebook publishing tool. Its conversation history stays in Discord and the private local Hermes state on Tulip.
