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

## Selected private notes

`router-private/` is a standalone Hermes plugin using native Discord slash commands. It is separate from the conversational model's public notebook tools. Enable it with `plugins.enabled: [router-private]`, copy its four runtime files (`plugin.yaml`, `settings.json`, `__init__.py`, `router_private.py`) to `C:\RouterDiscord\plugins\router-private`, and supply `ROUTER_PRIVATE_SECRET_KEY` in the protected `.env`.

The private service identity must differ from `router_discord`, the ordinary public-search identity. Only the private identity joins the private Router group. Do not give either bot a person's Router key or TinyCloud key.

After the Router API has been deployed, run `server/scripts/link-discord-group.mjs` with paths to the operator's Router key, a separate private service key, and a new protected code file, plus the group, guild, channel, bot handle and expected Discord user ID. The script creates or verifies the service identity, creates or reuses an invite-only group, binds it to that channel, and issues a ten-minute linking code. The personal key file must remain outside the bot's home and be removed if it was a temporary copy. Only the code is entered in `/router-link`; it is single-use and bound to the expected Discord account. Later members must join Router and link their own TinyCloud storage first, then obtain their own code through `/api/discord/link/start` using their own Router login.

In #router-test:

- `/router-link code`: connect your Discord account to your Router identity.
- `/router-save note`: save the exact selected text under your authorship, in your own TinyCloud storage, addressed only to the private Router group. This explicit save is immediate; it does not use the public notebook's pending-publication delay.
- `/router-recall query`: search the most recent 500 group notes by keywords and summarize up to four matches, with original source links. An empty query uses the latest notes.
- `/router-read entry_id`: read a currently accessible source note.
- `/router-status`: check the account link and current storage availability.
- `/router-unlink`: stop this Discord account from using its scoped bot permission. It does not delete notes, remove the author from the group, or revoke the author's TinyCloud grant.

All private-command replies are ephemeral and visible only to the requester. Source links require that person's Router login in the browser. Normal channel messages are not automatically saved. The public-search bot has no membership in the private Router group; private notes and replies do not enter its ordinary conversation history.

The local plugin stores only scoped author grants, in the protected `plugin-data/router-private/links.json`, never a note cache. Router stores only token hashes. Permissions expire after 30 days and are checked against current membership, Discord identity, guild/channel binding and revocation on every operation. Recall re-reads sources after inference before delivering the summary. TinyCloud withdrawal takes effect within the server's configured 60-second read lease; already delivered copies in Discord or the recipient's browser cannot be recalled.

### One private group across a Discord server

The private-command bridge also supports `scope: "guild"`: one Router group can be used from multiple channels in the same Discord server. Channels can organize subjects while every selected save has the same private group audience. This does not synchronize Discord membership with Router membership, import channel history, or give the conversational bot private-group tools. Every person must still link their own Router account and remain a member of the group; private-command responses remain ephemeral.

For this mode, the operator setup script takes `--scope guild --guild <server-id>` and no `--channel`. The plugin's private `settings.json` must have `base_url`, `guild_id`, `scope: "guild"`, and the intended `group_id`, with no `channel_id`. Pinning `group_id` prevents a previous link to another group from receiving new saves. The save command's menu description and its receipt name that group, including when the command is used in a channel with a different audience. The plugin passes the actual channel ID from each native Discord interaction to Router. Discord's channel permissions and the conversational gateway's allowlists still apply independently.

Existing configurations without `scope` keep their single-channel restriction. Changing between channel and server scope, or moving the binding to a different Discord server, invalidates existing grants and linking codes. Relink participants after such a change. The group, membership and existing TinyCloud notes stay in place, so moving from a staging server does not require copying the library or notes.

Deploy the Router API change before installing the matching plugin. Back up the private plugin settings and scoped link file before changing them, and re-check the destination with `/router-status` before saving anything. Validate an allowed second channel, denial in another server and for an unlinked member, and a save/read whose destination remains the configured private group. The conversational bot's channel allowlists and Discord permissions must be reviewed separately before allowing ordinary replies in additional channels.

Recall sends the matching notes to this profile's configured model provider for a stateless summary. Discord processes the command text and ephemeral replies. These are part of this test workflow; it is not end-to-end encrypted against Discord or the model provider.

Validation commands: server TypeScript build and Vitest suite, `node scripts/discord-groups-e2e.mjs` from `server/` (three synthetic authors with real hosted TinyCloud, no personal grants), and the pinned runtime Python `-m unittest discover -s agent/discord-test/router-private -p 'test_*.py'`. Verify actual slash-command responses in Discord and the source-link page after installation; local registration tests alone do not establish that Discord received the commands.
