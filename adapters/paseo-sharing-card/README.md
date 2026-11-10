# Router sharing cards in Paseo

This optional host adapter shows the exact saved post, audience, status, publication
time and a Delete button in the conversation that shared it. It consumes Router's
portable `SharingReceipt`; other hosts can render that receipt themselves or show a
visible text notice with the review/delete link. Paseo is not required by the protocol.

Each new post gets a new row at the bottom of the conversation. Status and deletion
updates replace that post's own row, so later shares do not get buried in an old card.
After a post mounts and lays out, the client reports that
event as `client_reported`. This may happen off-screen or in a background app; it
does not prove viewport visibility, attention, reading or approval.

## Connect a conversation

Requires a Router server that returns sharing notices and has the
`router_record_sharing_notice` tool. Against a server without them, `add-post`
fails; it does not make up a receipt.

1. Install dependencies in this directory and run `npm run typecheck` and `npm test`.
2. Install this directory as a trusted local Paseo plugin, ID `router-sharing-card`.
   It runs unsandboxed on the trusted host. No daemon restart is needed.
3. Keep the existing Router key in a protected plain-text file outside the repository.
   Configure a conversation on the host:

   ```sh
   node server/configure-session.mjs --agent <conversation-uuid> --key-file <protected-file>
   ```

   This checks authentication and writes a private session file under
   `~/.paseo/router-sharing-card/sessions/`. It refuses to replace an existing session.
   It restricts the directory ACL on Windows and uses private modes on Unix.
   Never put a key in an argument, transcript, card or committed file.

4. Immediately after a Router write returns its receipt, attach the saved post:

   ```sh
   node server/show-post.mjs --agent <conversation-uuid> --entry <entry-id> --daemon ws://127.0.0.1:6767/ws
   ```

   Use the actual local daemon endpoint from `paseo status` (Tulip listens on its
   tailnet address). For authenticated Paseo connections, pass `--connection-file`
   pointing to protected JSON with `url` and `password`; never use chat for it.
   `PASEO_AGENT_ID` can supply the conversation ID. Omitting `--entry` restores the
   saved card after a daemon restart.

The command reports attachment only. It never acknowledges a notice. Only the
mounted client callback reports layout and starts a gated public post's countdown.
If attachment fails or no client layout report is available, immediately show the
receipt as visible text, then use the portable `router_record_sharing_notice` flow
with `agent_reported` and a reference to that message. Do not report delivery merely
because the attachment command succeeded. A tool result alone is not the notice.
Automatic posting remains automatic within the person's saved rules.

The agent must call the adapter for each write. It does not watch unrelated chats,
intercept every connector, or infer a destination from group membership. Configure
only conversations authorized to use that account. The host/client are trusted;
this is not an isolation boundary between mutually untrusted agents on one host.

## Credential and post boundaries

- Production is explicitly configured and restricted to
  `https://router.teleport.computer`. Redirects and alternate origins are rejected.
- The client supplies a conversation and entry ID, never a key, URL or replacement
  text. The adapter retrieves Router's canonical receipt and requires owner access.
- Refresh, layout reports and Delete operate only on posts already bound to that
  conversation. The notice ID and hash must match before recording delivery.
- Production sessions reference one protected key file rather than copying the key
  per conversation. Card state sent to the app contains neither the key nor its path.
  Saved local cards contain private post text; protect them like conversation history.
- Delete changes the Router record before the card reports success. It does not
  erase copies in transcripts, screenshots or downstream services.
- Mutations are serialized. Failed operations preserve state and can be retried.
  A full card (200 posts) refuses another attachment; use the visible text fallback.

The SDK helper uses a pinned internal RPC API because this SDK's public facade
does not yet expose plugin calls. Test this compatibility boundary on SDK upgrades.

## Disposable local test

Build Router's server, then run `node server/start-local-test.mjs <conversation-uuid>`
from this directory. It starts a loopback-only, memory-backed Router on port 18571
with a disposable identity and creates one test post. It refuses to replace a running
instance or an existing conversation configuration. It never uses production keys.
The private process record is `~/.paseo/router-card-test/process.json`; stop only that
owned process after the test. Attach/restore the card with `show-post.mjs` above.

For a separately started test Router, use `configure-session.mjs --test-base
http://127.0.0.1:<port> --key-file <disposable-key-file>`. Test and production modes
have separate origin checks and visible labels; a production card cannot be marked
as a disposable test.

The timeline row survives scroll/reconnect. The saved session restores it after a
daemon restart when `show-post` is next called; restoration is not automatic.
