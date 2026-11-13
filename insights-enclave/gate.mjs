// The insights enclave's gate: the only container in its CVM with a route to the internet.
//
// The enclave program (the container that holds the release key and opens traces) sits on an internal
// network with no way out. Everything it sends or receives passes through this gate, which does two things
// and nothing else:
//
//   in:   the five requests the enclave serves (GET /health, /info, /runs/<id>; POST /run, /decide) are
//         passed to it unchanged;
//   out:  one kind of request is passed on, to one address: POST /v1/messages on the model provider, for
//         the model named in INSIGHTS_MODEL, holding one system text and one user text. The gate adds the
//         model key, which the enclave program never has. Any other request from inside is refused, so the
//         program has nowhere else to send what it reads: not another host, and not another part of the
//         provider's API (file uploads, batches) where the key's holder could collect it later.
//
// This file uses only Node's standard library and is written, whole, into the measured compose file by
// `node insights-enclave/embed.mjs`, to run on a stock Node image pinned by digest. So it does not change
// when the enclave program's image changes, and a reviewer can check it by comparing text.
//
// What it does not do: it does not judge what is inside the one allowed request (the trace view the program
// sends is the program's business), and it cannot see into the sealed replies that go back to Router.
import { createServer, request as httpRequest } from 'node:http';

export const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const OUT_MAX = 8 * 1024 * 1024, IN_MAX = 41 * 1024 * 1024;
const IN_ROUTES = [['GET', /^\/health$/], ['GET', /^\/info$/], ['GET', /^\/runs\/[\w%-]{1,480}$/], ['POST', /^\/run$/], ['POST', /^\/decide$/]];

/** The one request allowed out. Returns the exact body to send; throws on anything else. */
export function checkModelRequest(text, model) {
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('not JSON'); }
  const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)) && keys.every(k => k in value);
  if (!only(body, ['model', 'max_tokens', 'system', 'messages'])) throw new Error('fields other than model, max_tokens, system and messages');
  if (body.model !== model) throw new Error('a model other than the one named in the program');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192) throw new Error('max_tokens out of range');
  if (typeof body.system !== 'string') throw new Error('system must be one text');
  if (!Array.isArray(body.messages) || body.messages.length !== 1 || !only(body.messages[0], ['role', 'content'])
    || body.messages[0].role !== 'user' || typeof body.messages[0].content !== 'string') throw new Error('messages must be one user text');
  return JSON.stringify({ model: body.model, max_tokens: body.max_tokens, system: body.system, messages: [{ role: 'user', content: body.messages[0].content }] });
}

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > limit) { reject(new RangeError('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

/** The two listeners. `send` makes the outside request; tests replace it. */
export function createGate({ model, apiKey, appUrl, send = fetch }) {
  if (!model || !apiKey || !/^http:\/\/[a-z0-9-]+:\d+$/.test(appUrl || '')) throw new Error('The gate needs INSIGHTS_MODEL, ANTHROPIC_API_KEY and APP_URL');
  const app = new URL(appUrl);

  // Out: from the enclave program to the model, and nowhere else.
  const outbound = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/messages') return json(res, 403, { error: 'The gate passes only POST /v1/messages.' });
      let body;
      try { body = checkModelRequest((await readBody(req, OUT_MAX)).toString('utf8'), model); }
      catch (err) { return json(res, err instanceof RangeError ? 413 : 403, { error: `The gate refused this request: ${err.message}.` }); }
      const reply = await send(UPSTREAM, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(170_000),
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey } });
      const text = await reply.text();
      res.writeHead(reply.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(text);
    } catch { json(res, 502, { error: 'The model could not be reached.' }); }
  });

  // In: the enclave's own five requests, passed through unchanged.
  const inbound = createServer(async (req, res) => {
    try {
      const path = (req.url || '/').split('?')[0];
      if (!IN_ROUTES.some(([method, pattern]) => method === req.method && pattern.test(path))) return json(res, 404, { error: 'Not found' });
      const body = req.method === 'POST' ? await readBody(req, IN_MAX) : null;
      const headers = { 'content-type': 'application/json' };
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      if (body) headers['content-length'] = String(body.length);
      const forward = httpRequest({ host: app.hostname, port: app.port, path, method: req.method, headers, timeout: 16 * 60_000 }, reply => {
        res.writeHead(reply.statusCode || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.pipe(res);
      });
      forward.on('timeout', () => forward.destroy(new Error('timeout')));
      forward.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'The enclave program did not answer.' }); else res.destroy(); });
      forward.end(body || undefined);
    } catch (err) { json(res, err instanceof RangeError ? 413 : 400, { error: 'Request failed' }); }
  });
  return { inbound, outbound };
}

if (process.env.INSIGHTS_GATE === 'run') {
  const gate = createGate({ model: process.env.INSIGHTS_MODEL, apiKey: process.env.ANTHROPIC_API_KEY, appUrl: process.env.APP_URL });
  gate.inbound.listen(Number(process.env.IN_PORT || 3100), () => console.log('[insights-gate] in: listening'));
  gate.outbound.listen(Number(process.env.OUT_PORT || 8089), () => console.log('[insights-gate] out: listening'));
}
