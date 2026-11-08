// The pinned SDK's public facade does not yet expose plugin RPCs. Keep this
// compatibility boundary in one file; upgrade it when the public API does.
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

const { values } = parseArgs({ options: {
  agent: { type: 'string' }, entry: { type: 'string' }, daemon: { type: 'string' },
  'connection-file': { type: 'string' },
} });
const agentId = values.agent || process.env.PASEO_AGENT_ID;
if (!agentId || !/^[a-f0-9-]{36}$/.test(agentId)) throw new Error('A conversation UUID is required');
// An optional protected file holds Paseo authentication, never a Router key.
const connection = values['connection-file'] ? JSON.parse(await readFile(values['connection-file'], 'utf8')) : {};
const client = new DaemonClient({
  clientId: `router-sharing-card:${agentId}`,
  url: values.daemon || connection.url || 'ws://127.0.0.1:6767/ws',
  password: connection.password, reconnect: { enabled: false },
});
try {
  await client.connect();
  const card = await client.invokePluginRpc('router-sharing-card', values.entry ? 'add-post' : 'show-card', {
    agent_id: agentId, ...(values.entry ? { entry_id: values.entry } : {}),
  });
  // Never claim this is display/attention evidence. Only the mounted client
  // reports layout; no acknowledgment is made by this command.
  console.log(JSON.stringify({ attached: true, posts: card.receipts.length, notice_recorded_by_command: false }));
} finally { await client.close(); }
