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

After the Router API has been deployed, run `server/scripts/link-discord-group.mjs` with paths to the operator's Router key, a separate private service key, and a new protected code file, plus the group, guild, channel, bot handle and expected Discord user ID. The script verifies an existing invite-only group, creates or verifies the service identity, binds the group to that channel, and issues a ten-minute linking code. Creating a new group requires the explicit `--create-group` flag; a missing or mistyped existing group stops setup. The personal key file must remain outside the bot's home and be removed if it was a temporary copy. Only the code is entered in `/router-link`; it is single-use and bound to the expected Discord account. Later members must join Router and link their own TinyCloud storage first, then obtain their own code through `/api/discord/link/start` using their own Router login.

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

For this mode, the operator setup script takes `--scope guild --guild <server-id>` and no `--channel`. The plugin's private `settings.json` must have `base_url`, `guild_id`, `scope: "guild"`, and the intended `group_id`, with no `channel_id`. Pinning `group_id` prevents a previous link to another group from receiving new saves. The save command's menu description and its receipt name that group, including when the command is used in a channel with a different audience. The plugin passes the actual channel ID from each native Discord interaction to Router. Native private commands use this plugin's scope and Router permissions; the conversational gateway's allowlists govern ordinary messages and mentions, not these native interactions. Check Discord's command and channel permissions separately in a real channel.

Existing configurations without `scope` keep their single-channel restriction. Changing between channel and server scope, or moving the binding to a different Discord server, invalidates existing grants and linking codes. Relink participants after such a change. The group, membership and existing TinyCloud notes stay in place, so moving from a staging server does not require copying the library or notes.

Deploy the Router API change before enabling guild scope in the plugin. Older API save responses remain supported during a staged upgrade. Back up the private plugin settings and scoped link file before changing them, and re-check the destination with `/router-status` before saving anything. Validate an allowed second channel, denial in another server and for an unlinked member, and a save/read whose destination remains the configured private group. Verify that the group's service member is the private-command identity and that the conversational public-search identity remains outside it. The conversational bot's channel allowlists and Discord permissions must be reviewed separately before allowing ordinary replies in additional channels.

Recall sends the matching notes to this profile's configured model provider for a stateless summary. Discord processes the command text and ephemeral replies. These are part of this test workflow; it is not end-to-end encrypted against Discord or the model provider.

Validation commands: server TypeScript build and Vitest suite, `node scripts/discord-groups-e2e.mjs` from `server/` (three synthetic authors with real hosted TinyCloud, no personal grants), and the pinned runtime Python `-m unittest discover -s agent/discord-test/router-private -p 'test_*.py'`. Verify actual slash-command responses in Discord and the source-link page after installation; local registration tests alone do not establish that Discord received the commands.

## Speaking without an @-mention

### Private group conversation

Set `private_conversation: true` in the participation profile to handle mentions and ambient replies through the private connection. This requires `router-private` in the same profile. Its native handler supplies the scoped connection in-process; credentials never enter a model tool argument. Set Hermes `discord.ignored_channels` to `["*"]`, remove `extra.group_allowed_chats` grants and set `history_backfill: false`. Native plugins still receive events, while the Hermes adapter rejects group messages even from a previously paired user.

A group admin enables destinations with `POST /api/discord/conversation/configure` and `{groupId, channelIds}`. An empty list turns shared recall off without revoking ephemeral commands. The Router service needs the existing `DISCORD_BOT_TOKEN` to check membership independently of the bot process. It uses Discord's complete, paginated member list, not the gateway cache or IDs supplied by a model. The bot needs Discord's Guild Members privileged intent; a denied, malformed or incomplete response stops retrieval. Router works out who can see the channel from the server's roles, the channel's permission overwrites and each member's roles, in Discord's documented order; the owner and administrators see every channel. Every viewer except this exact bot must have a verified, active link to the connected Router group, and a channel that a person with no roles could see is refused outright. It is intended for a small group using one server.

### The server door

With `member_role_id` and `welcome_channel_id` in the private plugin's settings (guild scope only), the bot keeps the server closed to everyone but the group. Set the server up so that @everyone sees only the welcome channel and the member role sees the rest. The bot needs Manage Roles, a role above the member role, and permission to post in the welcome channel. It then:

- gives the member role when `/router-link` completes, and takes it away on `/router-unlink`;
- lists the server's members over REST once a minute (the gateway does not send this bot the member list), welcomes anyone who joined in the last 15 minutes and has no link, and tells them to run `/router-link`;
- asks Router every five minutes whether each link is still good (`operate` with action `member`, which reads nothing and does not extend the permission), and removes the role when Router says no. If Router does not answer, nothing changes.

Without those two settings the plugin behaves as before. The door is housekeeping. The privacy check is Router's, above.

Private conversation offers only group search/read and anonymous public Router search to the model. The usual web search and configured external MCP servers are absent. Each reply rechecks source versions and current audience before sending. It stores neither source notes nor drafts in a persistent database; current channel context is held in memory, with previous bot reply text omitted. It never saves ordinary conversation to Router. Keep using `/router-save` for selected notes.

The native commands remain private to their requester and retain their configured channel or guild scope. Failed ambient checks stay quiet; mentions get a short failure notice with private-command alternatives. Shared replies are visible in Discord and remain in its history after source deletion or membership changes. The final check and Discord send are separate operations, with a small race between them. No claim of erasing Discord copies is made.

The following participation rules apply in both public and private conversation profiles. In the public profile Hermes answers mentions; in the private profile the native participation plugin answers them once, without starting a Hermes session.

`router-participation/` is a second Hermes plugin. It ports the retired Telegram bot's group-chat behavior: the March 2026 bot in `server/src/telegram/` (see commit `9081484^`) and the unmerged classifier and analytics in PRs #13 and #17. After each burst of ordinary messages, a Claude Haiku 5.5 check scores the latest message: question, wrong, stuck, relevant, directed at the bot, social. PR #13's rules then decide:

- Silence is the default. The check must say speak, or the adjusted confidence must reach 0.85.
- Two people trading quick messages are never interrupted. An answered question isn't answered again.
- The bar rises each time the bot speaks (0.30, plus 0.25 for each recent post, half-life 30 minutes, capped at 0.90). Messages addressed to the bot use the base bar.
- A two-person conversation backs the confidence off by 0.3 unless a question is waiting or a claim that matters is wrong (PR #17).
- A question with no real answer is checked again after 8 and 20 minutes. On Nov 7, 2026 Haiku 5.5 waited at 3 and 5 minutes and spoke in 8 of 8 runs at 8 minutes. Chatter such as "brb" doesn't count as an answer.
- Unprompted posts are limited to 6 an hour and 30 a day, 5 minutes apart. Checks are capped at 400 a day and drafts at 40.

When the rules say speak, Claude Opus 5.5 drafts at most a matching number of words. Both profiles can search the public notebook (addressed entries are dropped even if the server returns them). The public profile can also call the read-only MCP servers listed in `compose_mcp_servers` and search the web; the private profile uses only the Router tools described above. It answers `SKIP` when there's nothing worth adding, and the reply is posted as a Discord reply to the message that prompted it, with mentions and link previews off.

Modes, set in `settings.json` or the runtime-only `settings.local.json`: `off` records messages only; `shadow` decides and drafts but never posts; `live` posts. The public profile logs scores, adjustments and drafts for review. The private profile keeps only decision metadata in memory and never saves drafts.

In #router-test, replies visible only to the person asking:

- `/router-quiet hours`: no unprompted replies here for that many hours (0 resumes). @-mentions still work.
- `/router-why`: the last five decisions, with confidence, bar, top scores, reason and any draft.
- `/router-stats days`: the bot's posts by kind (unprompted, answers to mentions, other posts such as digests), with how many drew a human reply or reaction.

Privacy: the public profile keeps the channel's messages, reactions and decisions in `plugin-data/router-participation/participation.db` for `retention_days` (30); deleted messages lose their text at once. The private profile uses an in-memory database and omits previous bot reply text. Both send the last 15 to 30 messages to the model provider for checks and drafts. Logs carry IDs and counts, never message text.

Install: copy the folder to `C:\RouterDiscord\plugins\router-participation`, add `router-participation` to `plugins.enabled`, optionally add `settings.local.json` with `channel_note` (what the channel is for) and `compose_mcp_servers` (`[{"name", "command", "args"}]`), and restart the gateway. The plugin reads `ANTHROPIC_API_KEY` from the profile's environment and records messages only when it has none. Tests run with the pinned runtime Python: `-m unittest discover -s agent/discord-test/router-participation -p 'test_*.py'`.
