/**
 * Federation MITM. Sits in front of hs-b on the docker bridge:
 *
 *   hs-a-core  →  MITM (alias `hs-b`, listens TLS :8448)  →  hs-b-real (the real nginx, was `hs-b`)
 *
 * Default behavior: pass-through. When MITM_DROP_TYPES is set (comma-
 * separated), POST /_matrix/federation/v1/send/<txnId> requests have any
 * matching to-device EDU types stripped from the JSON body before
 * forwarding. Other parts of the EDU/PDU array pass through untouched.
 *
 * Env:
 *   MITM_LISTEN_PORT       default 8448
 *   MITM_UPSTREAM_HOST     default hs-b-real
 *   MITM_UPSTREAM_PORT     default 8448
 *   MITM_TLS_CERT          default /certs/hs-b.crt
 *   MITM_TLS_KEY           default /certs/hs-b.key
 *   MITM_UPSTREAM_CA       default /certs/ca.pem
 *   MITM_DROP_TYPES        e.g. "m.room_key,m.room_key.withheld"
 *   MITM_LOG_FILE          path to log dropped/forwarded events (one JSON line each)
 */
import * as https from 'node:https';
import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';

const LISTEN_PORT   = Number(process.env.MITM_LISTEN_PORT || 8448);
const UPSTREAM_HOST = process.env.MITM_UPSTREAM_HOST || 'hs-b-real';
const UPSTREAM_PORT = Number(process.env.MITM_UPSTREAM_PORT || 8448);
const TLS_CERT      = process.env.MITM_TLS_CERT || '/certs/hs-b.crt';
const TLS_KEY       = process.env.MITM_TLS_KEY  || '/certs/hs-b.key';
const UPSTREAM_CA   = process.env.MITM_UPSTREAM_CA || '/certs/ca.pem';
const DROP_TYPES    = (process.env.MITM_DROP_TYPES || '').split(',').filter(Boolean);
const LOG_FILE      = process.env.MITM_LOG_FILE || '';

function log(obj: any) {
  const line = JSON.stringify({ ts: Date.now(), ...obj });
  console.log(line);
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n');
}

const upstreamCa = fs.readFileSync(UPSTREAM_CA);

const server = https.createServer({
  cert: fs.readFileSync(TLS_CERT),
  key:  fs.readFileSync(TLS_KEY),
}, (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const isFederationSend = req.url && /^\/_matrix\/federation\/v1\/send\//.test(req.url);
    let outBody = body;
    let droppedTypes: string[] = [];

    if (isFederationSend && DROP_TYPES.length > 0 && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString());
        if (Array.isArray(parsed.edus)) {
          const before = parsed.edus.length;
          parsed.edus = parsed.edus.filter((edu: any) => {
            if (DROP_TYPES.includes(edu.edu_type) || DROP_TYPES.includes(edu.type)) {
              droppedTypes.push(edu.edu_type || edu.type);
              return false;
            }
            // Special case: m.direct_to_device EDU wraps inner messages of various types.
            // Drop the entire EDU if any of its inner messages match.
            if (edu.edu_type === 'm.direct_to_device' && edu.content?.messages) {
              for (const userMessages of Object.values(edu.content.messages) as any[]) {
                for (const msg of Object.values(userMessages || {}) as any[]) {
                  if (msg && DROP_TYPES.includes(msg.type)) {
                    droppedTypes.push(`(direct_to_device:${msg.type})`);
                    return false;
                  }
                }
              }
            }
            return true;
          });
          if (before !== parsed.edus.length) {
            outBody = Buffer.from(JSON.stringify(parsed));
            log({ event: 'mitm_drop', url: req.url, dropped: droppedTypes });
          }
        }
      } catch (e: any) {
        log({ event: 'mitm_parse_err', url: req.url, err: String(e.message || e) });
      }
    }

    const opts = {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`, 'content-length': String(outBody.length) },
      ca: upstreamCa,
      // hs-b-real serves the cert for "hs-b" (its alias when it was the only proxy);
      // even though we connect to the upstream by a different alias,
      // setting servername preserves the TLS handshake correctness.
      servername: 'hs-b',
    };
    const upstream = https.request(opts, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('error', (err: any) => {
      log({ event: 'upstream_err', url: req.url, err: String(err.message || err) });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errcode: 'M_UNKNOWN', error: `mitm: ${err.message}` }));
    });
    upstream.end(outBody);
  });
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log({ event: 'listening', port: LISTEN_PORT, drop_types: DROP_TYPES, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` });
});
