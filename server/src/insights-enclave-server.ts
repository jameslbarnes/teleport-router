/** The insights enclave's own server: the only process in its CVM. Not part of Router.
 *
 *   GET  /health          liveness
 *   GET  /info            public: the program, the release key, the upgrade policy and a TDX quote binding them
 *   GET  /runs/<id>       public: a run's status, and its result once every contributor approved it
 *   POST /run             Router only (link secret): one run, with owners' signed consents and authorizations
 *   POST /decide          anyone may relay a contributor's signed approval or veto; the signature is what counts
 *
 * The release key comes from the CVM's dstack key service (INSIGHTS_KEY_SOURCE=dstack). Outside a CVM, for
 * local tests only, INSIGHTS_TEST_RELEASE_KEY is used and /info carries no quote.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { insightsEnclave } from './insights-enclave.js';
import { checkUpgradePolicy, type UpgradePolicy } from './insights-release.js';

const env = process.env;
const PORT = Number(env.PORT || 3100);
const LINK_SECRET = env.INSIGHTS_LINK_SECRET || '';
if (LINK_SECRET.length < 32) throw new Error('INSIGHTS_LINK_SECRET (at least 32 characters) is required');
if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required: the program names the Anthropic API as its model');
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

let releasePrivateKey: string, appId: string;
let quote: ((reportData: Buffer) => Promise<unknown>) | undefined;
if (env.INSIGHTS_KEY_SOURCE === 'dstack') {
  const { DstackClient } = await import('@phala/dstack-sdk');
  const client = new DstackClient();
  const key = await client.getKey('teleport-router/insights-release/v1', 'secp256k1');
  if (key.key.length !== 32) throw new Error('Unexpected dstack release key size');
  releasePrivateKey = '0x' + Buffer.from(key.key).toString('hex');
  const info = await client.info();
  appId = info.app_id;
  quote = async reportData => {
    const q = await client.getQuote(reportData);
    return { quote: q.quote, event_log: q.event_log, vm_config: q.vm_config ?? null, app_id: info.app_id, compose_hash: info.compose_hash };
  };
} else {
  if (env.NODE_ENV === 'production') throw new Error('The production enclave requires INSIGHTS_KEY_SOURCE=dstack');
  releasePrivateKey = env.INSIGHTS_TEST_RELEASE_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(releasePrivateKey)) throw new Error('INSIGHTS_TEST_RELEASE_KEY must be a 32-byte hex key outside a CVM');
  appId = 'local-test-enclave';
}
const upgrades: UpgradePolicy = env.INSIGHTS_UPGRADES === 'timelock'
  ? checkUpgradePolicy({ by: 'timelock', chain: env.INSIGHTS_CHAIN, appContract: env.INSIGHTS_APP_CONTRACT, timelock: env.INSIGHTS_TIMELOCK,
      delayHours: Number(env.INSIGHTS_TIMELOCK_HOURS || 48) })
  : { by: 'operator' };

const enclave = insightsEnclave({
  releasePrivateKey, appId, upgrades, quote, model: env.INSIGHTS_MODEL || 'claude-sonnet-5-5',
  build: { gitSha: env.GIT_SHA || null, imageDigest: env.IMAGE_DIGEST || null },
  complete: async ({ model, system, user, maxTokens }) => {
    // Current models think before answering by default, and the thinking counts against max_tokens,
    // so leave room beyond the answer and read the text block, which need not come first.
    const reply = await anthropic.messages.create({ model, max_tokens: maxTokens + 4000, system, messages: [{ role: 'user', content: user }] });
    if ((reply.stop_reason as string) === 'refusal') throw new Error('The model declined this trace.');
    const block = reply.content.find(b => b.type === 'text');
    return block?.type === 'text' ? block.text : '';
  },
});

const secretMatches = (header: string | undefined) => {
  const given = Buffer.from((header || '').replace(/^Bearer /i, ''));
  const want = Buffer.from(LINK_SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
};
function readJson(req: IncomingMessage, limit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new RangeError('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://enclave');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/info') return send(res, 200, await enclave.info());
    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const status = enclave.status(decodeURIComponent(url.pathname.slice('/runs/'.length)));
      return status ? send(res, 200, status) : send(res, 404, { error: 'No such run' });
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      if (!secretMatches(req.headers.authorization)) return send(res, 401, { error: 'Only Router hands this enclave a run.' });
      return send(res, 200, await enclave.run(await readJson(req, 40 * 1024 * 1024)));
    }
    if (req.method === 'POST' && url.pathname === '/decide') return send(res, 200, await enclave.decide(await readJson(req, 64 * 1024)));
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, err instanceof RangeError ? 413 : 400, { error: err instanceof Error ? err.message : 'Request failed' });
  }
}).listen(PORT, () => console.log(`[insights-enclave] listening on ${PORT}; app ${appId}`));
