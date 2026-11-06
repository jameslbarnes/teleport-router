# Inline sharing card test

A small host adapter for trying Router receipts inside an actual agent conversation.
The receipt format is Router's `SharingReceipt`, not a Paseo-specific posting protocol.
Other hosts need their own renderer (for example an MCP Apps resource on supporting hosts).
This adapter is a local prototype, not the production connector.

The card shows exact text, audience, timing, and a Delete button. One row is updated in
place as receipts change. More than two posts collapse behind "Show all"; hidden posts
are not reported as displayed. The client reports layout after mounting each post.
That is `client_reported` evidence, not proof of viewport visibility or human attention.

The backend accepts only a loopback Router and a configured disposable identity. It
never sends its key to the app, transcript, or card. The client cannot choose an API URL,
key, conversation, or post outside the configured test session. Deletion changes the
Router record before the card says it succeeded. Failed RPCs leave an error in place.

Private setup file: `~/.paseo/router-card-test/session.json`:

```json
{
  "agent_id": "the-conversation-id",
  "base_url": "http://127.0.0.1:18571",
  "test_key": "generated-disposable-key-kept-only-on-the-host",
  "card": { "version": 1, "test": true, "updated_at": 0, "receipts": [] }
}
```

Populate `receipts` from POST `/api/entries` on an isolated Router with no production
credentials. Install dependencies for typechecking, then install this directory as a
trusted local Paseo plugin. Plugins must already be enabled or explicitly authorized.
Call the plugin's `show-card` RPC with the configured `agent_id` to display the card.

For a disposable instance, first build Router's server, then run
`node server/start-local-test.mjs <conversation-uuid>` from this adapter directory.
It generates a fresh identity, starts a loopback-only server on port 18571, and writes
the private setup file. It refuses to replace a running instance. Its process ID is
in `~/.paseo/router-card-test/process.json`; stop only that process after the test.

The host keeps this row through scroll/reconnect but not a daemon restart; the private
session file survives, and `show-card` restores the row. No live Router deployment or
Paseo daemon restart is needed. Remove `router-sharing-card-test` to remove the adapter.
