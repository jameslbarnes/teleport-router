#!/usr/bin/env node

const base = (process.env.SHAPE_ROUTER_BASE_URL || 'https://shaperotator.teleport.computer').replace(/\/$/, '');
const key = process.env.SHAPE_ROUTER_SECRET_KEY || '';

function log(message) {
  console.log(`[shape-smoke] ${message}`);
}

async function request(path, options = {}) {
  const url = new URL(path, `${base}/`);
  if (options.auth !== false && key) url.searchParams.set('key', key);
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'shape-router-smoke/1.0',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url.pathname} failed ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  log(`base=${base}`);

  const health = await request('/health', { auth: false });
  if (health.status !== 'ok') throw new Error(`/health did not return status=ok: ${JSON.stringify(health)}`);
  log('/health ok');

  const serverInfo = await request('/api/server-info', { auth: false });
  if (!Array.isArray(serverInfo?.features?.languages) || !serverInfo.features.languages.includes('en')) {
    throw new Error(`/api/server-info missing expected languages: ${JSON.stringify(serverInfo)}`);
  }
  if (serverInfo.features.platforms?.includes('lark')) {
    throw new Error(`/api/server-info unexpectedly exposes lark platform: ${JSON.stringify(serverInfo)}`);
  }
  log('/api/server-info ok');

  const api = await request('/api', { auth: false });
  if (!api?.mcp?.sse?.startsWith(`${base}/mcp/sse`)) {
    throw new Error(`/api MCP URL does not point at Shape base URL: ${JSON.stringify(api?.mcp)}`);
  }
  log('/api ok');

  if (!key) {
    log('SHAPE_ROUTER_SECRET_KEY not set; skipped authenticated bot key/write/read checks');
    return;
  }

  const me = await request('/api/me');
  log(`/api/me ok handle=@${me.user?.handle || me.handle || 'unknown'}`);

  const stamp = new Date().toISOString();
  const created = await request('/api/entries', {
    method: 'POST',
    body: JSON.stringify({
      summary: `Shape Matrix bridge smoke test ${stamp}`,
      content: [
        '> Source: automated smoke test',
        '> Purpose: verify private Shape Router API path for Matrix bridge',
        '',
        `Smoke test created at ${stamp}.`,
      ].join('\n'),
      tags: ['shape-rotator', 'matrix', 'smoke-test'],
      client: 'code',
      oneliner: 'Smoke test',
    }),
  });
  const entryId = created?.entry?.id;
  if (!entryId) throw new Error(`POST /api/entries did not return entry.id: ${JSON.stringify(created)}`);
  log(`POST /api/entries ok id=${entryId}`);

  if (created.entry.publishAt) {
    await request(`/api/entries/${encodeURIComponent(entryId)}/publish`, { method: 'POST' });
    log('POST /api/entries/:id/publish ok');
  }

  const listed = await request('/api/entries?tags=smoke-test&limit=10');
  const found = (listed.entries || []).some(entry => entry.id === entryId);
  if (!found) throw new Error(`GET /api/entries did not include smoke entry ${entryId}`);
  log('GET /api/entries ok');

  const detail = await request(`/api/entries/${encodeURIComponent(entryId)}`);
  if (detail.entry?.id !== entryId) throw new Error(`GET /api/entries/:id returned wrong entry: ${JSON.stringify(detail)}`);
  log('GET /api/entries/:id ok');

  if (process.env.SHAPE_ROUTER_SMOKE_KEEP_ENTRY !== '1') {
    await request(`/api/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    log('DELETE /api/entries/:id ok');
  } else {
    log(`kept smoke entry: ${base}/entry?id=${entryId}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
