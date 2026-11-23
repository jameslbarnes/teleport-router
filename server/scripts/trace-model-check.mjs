// Checks the attested model providers against their live endpoints. Run from server/ after npm run build:
//
//   node scripts/trace-model-check.mjs
//
// Without keys it verifies each provider's attestation and shows that the verified connection refuses an
// unaccepted release, any other address, and a call without a key. With REDPILL_API_KEY or TINFOIL_API_KEY
// set, it also sends one short prompt through the gateway and, for RedPill, verifies the signed receipt.
// REDPILL_RELEASES is a comma-separated list of accepted gateway release hashes; RedPill publishes them at
// https://docs.redpill.ai/guides/release-measurements.md .
import assert from 'node:assert/strict';
import { modelGateway } from '../dist/trace-model.js';
import { redpillConnector, tinfoilConnector } from '../dist/trace-model-providers.js';

const releases = (process.env.REDPILL_RELEASES || '').split(',').map(s => s.trim()).filter(Boolean);
const models = { redpill: process.env.REDPILL_MODEL || 'z-ai/glm-5.3', tinfoil: process.env.TINFOIL_MODEL || 'gpt-oss-120b' };
const keys = { redpill: process.env.REDPILL_API_KEY, tinfoil: process.env.TINFOIL_API_KEY };
let failed = false;
const check = async (name, run) => {
  const started = Date.now();
  try { const detail = await run(); console.log(`ok    ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ''}`); }
  catch (err) { failed = true; console.log(`FAIL  ${name}: ${String(err?.message || err).slice(0, 300)}`); }
};
const refuses = async (promise, what) => { let sent; try { sent = await promise; } catch { return; } assert.fail(`${what}: sent, status ${sent.status}`); };

async function provider(name, connect) {
  let channel;
  await check(`${name}: attestation verifies before anything is sent`, async () => { channel = await connect(); return `${channel.verdict}; release ${channel.release}`; });
  if (!channel) return;
  const url = `${channel.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({ ...channel.extraBody, model: models[name], messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 });
  await check(`${name}: the verified connection refuses another address`, () => refuses(channel.fetch('https://example.com/', { method: 'GET' }), 'other address'));
  await check(`${name}: a call without a key is refused`, async () => {
    const response = await channel.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 401);
  });
  await channel.close();
  if (!keys[name]) { console.log(`skip  ${name}: no key set, so no model call was made`); return; }
  await check(`${name}: one call through the gateway`, async () => {
    const declaration = { provider: name, model: models[name], calls: 1, prompt_bytes: 200, reply_tokens: 16 };
    const gateway = modelGateway({ declaration, apiKey: keys[name], connect });
    try {
      const reply = await gateway.ask('Reply with the single word: ready');
      const evidence = gateway.evidence();
      if (name === 'redpill') assert.equal(evidence.receipts.length, 1, 'a verified receipt');
      return `${JSON.stringify(reply.slice(0, 60))}; receipts ${evidence.receipts.length}`;
    } finally { await gateway.close(); }
  });
}

if (releases.length) {
  await provider('redpill', redpillConnector(releases));
  await check('redpill: an unaccepted release is refused', () => refuses(redpillConnector(['11'.repeat(32)])().then(c => ({ status: c.verdict })), 'unaccepted release'));
} else console.log('skip  redpill: set REDPILL_RELEASES to the accepted gateway release hashes');
await provider('tinfoil', tinfoilConnector());
process.exit(failed ? 1 : 0);
