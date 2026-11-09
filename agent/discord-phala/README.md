# Discord on Router's Phala machine

This moves the existing Router Test gateway from Tulip to a sixth container in
Router's existing CVM. It preserves the Hermes release, Opus/Haiku models, live
participation rules, channel allowlist, six private commands and three
participation controls. The pending ARIA guild-wide activation is separate.

The image extends Hermes v0.23.0 at a fixed digest and verifies its source commit
`2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`. Configuration, prompt and plugins are
in the image. Runtime package installation is disabled. The process is non-root,
with a read-only root filesystem, a dedicated volume, no published ports and no
host/Docker/dstack sockets. Its limit is 0.5 CPU and 512 MiB, without extra swap.
It receives neither Router's storage credentials nor the Shape agent's identity.

Router still decides what each bot identity can retrieve. Container isolation is
not a separate TEE boundary. The attested compose binds the image digest; it does
not prove that a legitimate member cannot copy material. Discord receives messages
and replies; Anthropic receives the context used for classification/composition
and private recall. Web search also uses Anthropic's service. Private commands
continue to call Router, whose author storage is on TinyCloud.

## Research source continuity

The two cohort tools keep their existing semantics. `discord-cohort-publish.py`
exports only posted issues and the public source fields previously returned by
the local MCP server. It excludes the roster, unpublished drafts, raw fetches,
credentials and all chat history. Project display names are resolved during export.

At cutover, attach this JSON to the existing bot-owned newsletter message
`1568776784294576190` in `#router-test`. No new message or ping is needed. The
publisher retains other attachments and verifies that the newsletter text is
unchanged. A small scheduled sync on Tulip refreshes this attachment every
15 minutes, only when the source content changes. The weekday/weekly producers
remain on Tulip and keep using their existing credential.

The Phala tools read this one fixed message, verify its author and channel, and
download only its bounded JSON attachment from Discord's CDN. The bot credential
is never sent to the CDN. Redirects are disabled and the content hash is checked.
The cache is private to the bot's volume and refreshed after 60 seconds; a failed
refresh is reported as unavailable, never silently presented as fresh. No incoming
administration API or chat-state export exists.

Prepare (does not post):

```powershell
& 'C:\Users\Admin\src\aria-cohort-digest\.venv\Scripts\python.exe' -I -X utf8 `
  'C:\Users\Admin\src\teleport-router-discord\scripts\discord-cohort-publish.py' `
  --cohort-root 'C:\Users\Admin\src\aria-cohort-digest' `
  --out 'C:\Users\Admin\AppData\Local\teleport-router\discord-phala\cohort.json'
```

After cutover approval, the same command with `--apply --bot-env
C:\RouterDiscord\.env` updates the attachment. Install a pinned copy of the script
and its two library modules in the protected runtime directory for the scheduled
sync; do not have the task follow a changing development worktree.

## Cutover and rollback

1. Obtain approval for this deployment after PR checks and review. A compose
   deployment may interrupt Router and the cohosted Matrix bridge. Plan for the
   same brief outage seen in previous deployments. No new CVM is provisioned.
2. Check current Phala disk/memory headroom and the Tulip operations board. The
   Nov 9 01:18 UTC diagnostic showed 995 MB available of 1.94 GB total memory.
   CI measures offline Linux startup under the 512 MiB cap; this is not a live
   workload measurement or evidence of a real Discord reply.
3. Copy only the existing bot/model/public/private service credentials into the
   five `DISCORD_*` GitHub secrets named in the compose/workflow. The optional
   `DISCORD_INITIAL_LINKS_B64` is the existing scoped `links.json`, base64 encoded.
   Never use James's personal key. Secret values do not enter compose or logs.
4. Publish/verify the research attachment and install its sync task. Disable
   **Teleport Router Discord Test**, then gracefully stop that gateway through
   its existing Hermes CLI. Confirm it is disconnected before deploying the
   Phala service. Never run two gateways with the same token.
5. Deploy through CI. Fresh Phala state seeds existing private links once.
   Later deploys never restore an unlinked grant. Conversation sessions and
   participation diagnostics start fresh; Discord backfill supplies recent
   context without triggering checks on old messages. The public notebook,
   private Router groups, TinyCloud posts and Discord messages remain in place.
6. Verify the attested third image digest, healthy Discord heartbeat, all nine
   native commands, a real mention reply, source lookup, private save/read, and
   a controlled live participation example. Confirm Router/Shape health too.
   Record which checks actually passed. A Docker health result alone is not the
   end-to-end test.
7. Keep the disabled Tulip gateway as rollback until the real tests pass. After
   that, separately remove unneeded staging history under the user's retention
   choice. Do not delete `.env`: the existing newsletter producer still uses it.

If deployment fails before Discord starts, confirm no Phala gateway is running
before re-enabling Tulip. If it has started, remove/stop the Phala service through
an approved deployment first, then re-enable Tulip. Rollback uses Tulip's old
staging history; it does not export new private conversation history from Phala.

Future bot image/prompt changes go through the shared CVM's deployment process,
so they can affect Router availability. A separate CVM would decouple restarts;
this change follows the requested same-machine staging arrangement.

## Validation

The `discord-image` CI job runs both existing plugin suites and migration tests
inside the exact shipped Linux runtime, with networking disabled. It also starts
the real gateway under the production CPU/memory/security limits. The compose
check rejects shared volumes/credentials, host sockets, inbound ports or missing
limits. Deployment verification requires the expected image and a fresh connected
Discord heartbeat, and archives the Discord digest alongside Router's evidence.

Upstream references: [Hermes v0.23.0](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0),
[Discord attachment editing](https://docs.discord.com/developers/resources/message#edit-message),
[Phala CLI and attestation](https://github.com/Phala-Network/phala-cloud).
