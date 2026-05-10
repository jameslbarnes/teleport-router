// Federation MITM. Sits in front of hs-b on the docker bridge:
//
//   hs-a-core  →  MITM (alias `hs-b`, TLS :8448)  →  hs-b-real (the real nginx)
//
// Default: pass-through. When MITM_DROP_TYPES is set (comma-separated),
// POST /_matrix/federation/v1/send/<txnId> requests have any matching
// to-device EDU types stripped from the JSON body before forwarding.
//
// Plain Node JS so it runs in node:24-alpine with no install dance.

const https = require('node:https');
const fs = require('node:fs');

const LISTEN_PORT   = Number(process.env.MITM_LISTEN_PORT || 8448);
const UPSTREAM_HOST = process.env.MITM_UPSTREAM_HOST || 'hs-b-real';
const UPSTREAM_PORT = Number(process.env.MITM_UPSTREAM_PORT || 8448);
const TLS_CERT      = process.env.MITM_TLS_CERT || '/certs/hs-b.crt';
const TLS_KEY       = process.env.MITM_TLS_KEY  || '/certs/hs-b.key';
const UPSTREAM_CA   = process.env.MITM_UPSTREAM_CA || '/certs/ca.pem';
const DROP_TYPES    = (process.env.MITM_DROP_TYPES || '').split(',').filter(Boolean);
const LOG_FILE      = process.env.MITM_LOG_FILE || '';

function log(obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj });
  console.log(line);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  }
}

const upstreamCa = fs.readFileSync(UPSTREAM_CA);

const server = https.createServer({
  cert: fs.readFileSync(TLS_CERT),
  key:  fs.readFileSync(TLS_KEY),
}, (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const isFederationSend = req.url && /^\/_matrix\/federation\/v1\/send\//.test(req.url);
    let outBody = body;
    let droppedTypes = [];

    // Helper: pull out every "type" claim an EDU makes — outer edu_type,
    // content.type (m.direct_to_device case where type is on content),
    // and any inner message types in content.messages.
    function eduTypes(edu) {
      const types = new Set();
      if (edu.edu_type) types.add(edu.edu_type);
      if (edu.type) types.add(edu.type);
      if (edu.content?.type) types.add(edu.content.type);
      if (edu.content?.messages) {
        for (const u of Object.values(edu.content.messages)) {
          for (const m of Object.values(u || {})) {
            if (m?.type) types.add(m.type);
          }
        }
      }
      return [...types];
    }

    if (isFederationSend && body.length > 0 && process.env.MITM_LOG_BODIES === '1') {
      try {
        const parsed = JSON.parse(body.toString());
        const eduSummary = (parsed.edus || []).map((e) => eduTypes(e).join('|') || '?');
        log({ event: 'send_body', url: req.url, edus: eduSummary, n_pdus: (parsed.pdus || []).length });
      } catch (_) {}
    }

    if (isFederationSend && DROP_TYPES.length > 0 && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString());
        if (Array.isArray(parsed.edus)) {
          const before = parsed.edus.length;
          parsed.edus = parsed.edus.filter((edu) => {
            const types = eduTypes(edu);
            const matches = types.filter(t => DROP_TYPES.includes(t));
            if (matches.length > 0) {
              droppedTypes.push(...matches);
              return false;
            }
            return true;
          });
          if (before !== parsed.edus.length) {
            outBody = Buffer.from(JSON.stringify(parsed));
            log({ event: 'mitm_drop', url: req.url, dropped: droppedTypes });
          }
        }
      } catch (e) {
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
      // hs-b-real serves the cert for "hs-b". TLS handshake checks SAN.
      servername: 'hs-b',
    };
    const upstream = https.request(opts, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('error', (err) => {
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
