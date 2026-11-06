# Private Discord test profile

This profile gives the Router Test Discord bot its own Hermes home and Router identity. It is separate from the Shape agent on Phala. It reads public notebook entries and replies only in the test channel; it does not publish Discord messages.

- Server: `1568051145551650858`
- Channel: `1568051571751788644`
- Application: `1568056630380200118`
- Runtime root on Tulip: `%LOCALAPPDATA%\teleport-router\discord-test`
- Private Hermes state on Tulip: `C:\RouterDiscord` (short path avoids Windows path-length failures during dependency installation)
- Hermes release: `v0.23.0`, commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`

Copy `config.yaml` and `SOUL.md` to the private Hermes state directory. Its protected `.env` supplies `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, and this bot's `ROUTER_SECRET_KEY`. Never copy James's notebook key or the Shape agent's configuration into this profile.

Keep `DISCORD_ALLOWED_USERS` and `DISCORD_ALLOWED_ROLES` empty and both allow-all switches false. In this Hermes release, the channel allowlist then grants access only from that channel and denies DMs. Use Discord permission overwrites to deny the bot access to the other channels as well. Set the server owner's ID as `platforms.discord.extra.group_allow_admin_from` to restrict administrative slash commands to the owner.

After installation, verify the running version, effective tool list, denied DM/other-channel authorization, and an actual Discord message and bot reply that calls notebook search. A successful REST request alone does not verify the Gateway connection.

## Setup status (November 5, 2026)

The application is installed in the test server. The native Windows Hermes installation and its Discord/Anthropic extras are installed on Tulip. The bot is offline: Discord account verification has not yielded a bot token, and no gateway service has been started.

Verified against the pinned runtime and this profile:

- Live MCP discovery and the effective Discord tool list expose exactly `mcp__router__router_search` and `mcp__router__router_get_entry`.
- The actual Discord adapter's authorization permits the test channel and denies `general`, `feedback`, DMs, and requests without channel context.
- A separate notebook identity can search the public notebook, and the configured model credential passes the provider's model-metadata request.
- The private `.env` inherits access only for the Windows administrator account and SYSTEM.

Before starting, finish Discord's bot-token verification and save the token directly in the protected `.env`; set the owner's numeric ID in `platforms.discord.extra.group_allow_admin_from`. Then verify real Discord permissions, run the gateway, and observe a notebook-search reply in `#router-test`. No real Discord message/reply, model completion, or automatic service startup has been tested yet.
