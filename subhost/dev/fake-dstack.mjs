// A stand-in for dstack's socket, for running the host outside a CVM. Its quotes
// have the right layout but no signature: run the grant script with --simulated
// and --approved-file subhost/dev/approved-local.json against it.
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../host.mjs';
import { eventDigest, replayRtmr } from '../verify.mjs';

export const FAKE_VALUES = Object.freeze({
  GIT_SHA: 'abcdef0',
  IMAGE_DIGEST: `sha256:${'1'.repeat(64)}`,
  AGENT_IMAGE_DIGEST: `sha256:${'2'.repeat(64)}`,
  DISCORD_IMAGE_DIGEST: `sha256:${'3'.repeat(64)}`,
});

export function startFakeDstack({ socketPath, template, appId = 'f'.repeat(40), secret = 'local-only' }) {
  const compose = template.replace(/\r\n/g, '\n').replace(/\$\{([A-Z_]+)\}/g, (_, name) => FAKE_VALUES[name] ?? '');
  const appCompose = canonicalJson({ docker_compose_file: compose, runner: 'docker-compose' });
  const composeHash = sha256Hex(appCompose);
  const event = (name, payload) => { const e = { imr: 3, event_type: 134217729, event: name, event_payload: payload }; return { ...e, digest: eventDigest(e) }; };
  const events = [event('app-id', appId), event('compose-hash', composeHash), event('os-image-hash', '0'.repeat(64))];
  const reply = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', c => { text += c; });
    req.on('end', () => {
      const body = text ? JSON.parse(text) : {};
      if (req.url === '/GetKey') return reply(res, { key: createHmac('sha256', secret).update(`${body.path}|${body.purpose}`).digest('hex'), signature_chain: [] });
      if (req.url === '/Info') return reply(res, { app_id: appId, tcb_info: JSON.stringify({ app_compose: appCompose, event_log: events }) });
      if (req.url === '/GetQuote') {
        const quote = Buffer.alloc(632);
        quote.writeUInt16LE(4, 0);
        quote.writeUInt32LE(0x81, 4);
        Buffer.from(`01${composeHash}${'0'.repeat(30)}`, 'hex').copy(quote, 232);
        Buffer.from(replayRtmr(events, 3), 'hex').copy(quote, 520);
        Buffer.from(body.report_data, 'hex').copy(quote, 568);
        return reply(res, { quote: quote.toString('hex'), event_log: JSON.stringify(events) });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  rmSync(socketPath, { force: true });
  return new Promise(resolve => server.listen(socketPath, () => resolve(server)));
}
