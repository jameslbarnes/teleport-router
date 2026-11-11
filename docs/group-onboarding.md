# Start with a group

An invitation should take someone to people and notes they care about. The first contribution is optional. Start by reading something useful, then help the person choose what their agent may share.

For a private community, create the group with `join_rule: "invite"`. Open groups are public: anyone can read their notes on the web without joining. Membership in one group does not grant access to another.

## Guided account and connection setup

Group invitations open a browser flow at `/join?channelinvite=...`; returning members use `/group-setup?group=...`. The page keeps the group name and audience visible. A personal agent is optional.

- Create a Router handle or restore an existing account. A failed join keeps the created account and offers another attempt.
- Create a TinyCloud owner key locally, or import an existing one locally. Choose a recovery password and download a PBKDF2-SHA256/AES-GCM recovery file containing the Router account key and TinyCloud owner key. The encrypted copy stays in this browser; the password and plaintext owner key are not persisted. Acknowledging the backup is a user choice, not proof that the download was kept.
- Grant the Router access to `router/` for one year. The browser signs the existing owner challenge, decrypts the server's owner-recovery envelope, returns its confirmation proof, then reads the stored recovery record back before reporting completion. TinyCloud holds encrypted published records. The owner private key never goes to Router, Discord or TinyCloud.
- Connect Discord using `/router-link` without a code. Its private reply opens this same setup page with a ten-minute pairing capability in the URL fragment. Open it in the browser used for Router, or restore the recovery file there. Check the unique Discord username, confirm that you started the request, and approve the exact account connection. The bot stores its restricted permission before acknowledging; the UI reports a completed connection only after that acknowledgement. Legacy one-use codes still work.
- Choose personal sharing rules in the existing editor. Returning members see the actual saved mode and audience; automatic public posting is explicitly labelled when retained. Confirmed saves use the same revision-checked settings agents read. Joining, linking and downloading never save new rules automatically.

People can postpone storage and Discord, save rules and read the group. The final page names unfinished connections. It offers group reading and, when connected, the native Discord commands; it does not claim that ordinary chat has private-group memory or that chat is automatically saved. An expired, unavailable or changed binding gives a retry route. No group invitations or public posts are sent during setup.

The host must first bind an invite-only Router group to the intended Discord server and configure the private plugin's `group_id` and scope. Browser setup never grants group membership from a Discord link. Discord and Router memberships remain separate; one Discord server can route several topic channels into one Router group. A saved note goes to that whole group even if its source channel has a narrower audience.

The setup page serves its scripts locally, has no-referrer and a restricted Content Security Policy, and clears pairing capabilities from the visible URL. The trusted Router frontend can use locally unlocked keys; the encrypted recovery file does not protect a user from malicious frontend code. The existing honest-agent posting model is unchanged.

Build the browser assets with `npm ci && npm run build` in `browser/`. Docker does this in a separate build stage. Run the server build before `npm test` in `browser/` so its WebCrypto recovery tests can compare against the actual server codec.

## An invitation for the guest's agent

An invitation is one link, `/join?channelinvite=…`, for two readers. A browser asks for a page and gets the guided setup. Anything that does not ask for HTML, such as curl or an agent's fetch tool, gets the same invitation as plain-text steps; `/agent-invite/<token>` always returns the text, and the setup page tells an agent that read the HTML where to find it. So the guest can open the link, or give it to their own agent (Claude Code, Codex or any agent with a shell and Node.js 20) and say "set me up with this".

`router_channels` action `invite`, `POST /api/channels/:id/invite` and the group page's "Copy invitation message" button return a `message` to send. It leads with `agent_message`, a few lines the guest pastes into their agent that tell it to fetch the steps from `agent_url` and carry them out, and ends with the link for someone without an agent. They also return `invite_url` and the full steps as `agent_prompt`. Opened in a browser, the invitation page starts with the same "Give this to your agent" text and a copy button, above the form. Both forms carry the same token, so they end on the same date and after the same number of joins.

A group with a Discord server can keep its Discord invitation: pass `discord_invite` once when creating an invitation (admins only; only `discord.gg` and `discord.com/invite` addresses are accepted). It is saved on the group and shown to invited people and members, on the setup page and in the agent's steps.

The message tells the agent to download `/agent-setup.mjs` from this Router, read it and run one command:

```
node router-setup.mjs join --invite <token> --handle <name> --approve-rules group
```

- It checks the invitation, creates the account, joins the group, creates the person's storage key and connects encrypted storage with the same grant, recovery proof and read-back as the setup page, and prints a summary. Running it again continues where it stopped.
- Keys are written to `~/.router/accounts/<handle>/` and never printed. There is no password-protected recovery file in this path: the folder is the backup, and the summary says so.
- Someone invited to a private group is asked one question about rules: should your agent ever post publicly? "Only this group" saves rules that post to the group and never publicly (`--approve-rules group-only`, `group_only_rules`). "This group, and public when I approve" saves rules that post to the group and need approval of the exact text for anything public (`--approve-rules group`, `suggested_rules`). The agent's steps ask it in those words, and the setup page asks it as two buttons that open the rules editor with the matching draft. The answer is the approval; without `--approve-rules` nothing is saved. Existing rules are never replaced. An open group is already public, so it is not asked.
- `tools` and `call` reach Router's tools with the new account before Router is connected to the agent's app, so the agent can read the group and post a first note in the same conversation. The usual sharing receipt comes back.
- Discord still needs the person: they join the server, type `/router-link` and paste the private link to their agent. `discord --link` shows which Discord account asked; `--confirm` connects it.
- `connect` installs the Router plugin in Claude Code. The script, not the agent, refuses when Router is already connected there, so an invitation can never replace another account's connection.

The group's name and description are written by its admin. They appear in the message as one quoted data line and never as steps.

`server/scripts/agent-setup-e2e.mjs` runs the whole path with synthetic accounts against a local Router and hosted TinyCloud.

## Invitations, removal and Discord permissions

- Every invitation link ends. By default it works for 7 days and 10 joins; an admin can set `expires_in_hours` (up to 720) and `max_uses` (up to 100). Invitations to one named person are single-use and last 7 days. Links created before this rule keep their original terms.
- The group page's "Copy invite link" button and `router_channels` both give the guided link, `/join?channelinvite=…`.
- An admin can remove an ordinary member with `router_channels` action `remove_member`, or `POST /api/channels/:id/remove-member` with `{ "handle": "…" }` and the admin's key in the `Authorization` header. The person loses access to the group's notes at once and their Discord permission for the group stops working. Notes they already saved stay; copies they made elsewhere are out of reach. Admins can only leave on their own. Outstanding invitation links still work until they expire, so a removed person who holds one can rejoin; there is no way yet to list or cancel links.
- A Discord permission stays active while it is used. It ends 30 days after the last command, and after a year in any case; `/router-link` renews it. The bot's token is useless without the bot's own Router key.
- `/router-recall` puts notes that match more of the question first and ignores common words on their own.

## Joining and choosing rules

Invite links lead to `/join?channelinvite=…`. The guided setup links to `/posting-rules?group=…&onboarding=1`, with a route back after saving. People can also use the rules editor directly, read group notes and get an optional prompt for their agent. An invitation does not change posting rules. Drafting does not save them; the person reviews and confirms first.

The private-group suggestion permits useful automatic notes inside that group and asks before posting to Router's public notebook. An explicit request to publish a particular post also authorizes it. Open groups suggest review mode for every post. Existing review/manual choices and the person's own wording are retained. The page explains that these are personal rules used across connected agents, so choosing a group replaces the person's previous default audience.

This uses Router's existing honest-agent model. `posting_intent` is the agent's declaration of a request or approval; a sharing notice is not proof of approval or human attention. Agents must keep other groups' private material out, even when the same person belongs to both. A person's approval of their own idea does not authorize publishing someone else's private contribution.

For several selected audiences, each write must supply `to` explicitly. Router rejects an omitted destination instead of sending to every selected audience. One selected audience remains the default. No existing personal rules are rewritten by deployment.

## Reading in context

`router_search` accepts `group_id`. It checks current membership before and after fetching notes, searches the latest 500 group notes, and applies the usual per-entry access checks. It excludes pending entries, other groups, general public results, and Matrix messages. Failed group access returns an error without falling back to a broader search. Read an original with `router_get_entry` before relying on it, and cite its author and link.

The 500-note limit is explicit; this is not a complete archive search for larger groups. Search responses are capped at 50 results. An agent must still choose which group's context belongs in the conversation. Router does not independently know which private conversation an agent is summarizing.

## Before inviting a pilot

- Walk a fresh account through joining, choosing rules, an authorized read, and a group save with its sharing notice and delete link.
- Check public-post approval, cross-group exclusion, and access after leaving.
- Verify the browser's explicit storage and recovery setup for each author. Joining alone does not create that connection; existing accounts are never silently migrated.
- Configure and test the Discord connection for the intended private group. This change does not activate private group memory in the conversational Discord bot. Its existing native private commands remain separate from ordinary channel chat.

`group-onboarding-browser-smoke.mjs` uses an isolated in-memory server and synthetic accounts. Its storage-availability and Discord responses are labelled fixtures; account creation, encrypted recovery files, reload/unlock, rules, membership and pages are real. `group-setup-live-smoke.mjs` runs the browser against a local Router with real hosted TinyCloud and throwaway identities: storage delegation, recovery readback, Discord pairing API, private save/read and independent owner decryption. It emulates the Discord interaction context and sends no Discord messages. Native plugin tests check actual slash-command registration and ephemeral replies. A final real Discord walkthrough is still required after deployment and binding.
