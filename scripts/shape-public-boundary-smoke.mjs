#!/usr/bin/env node

const base = (
  process.env.PUBLIC_ROUTER_BASE_URL
  || process.env.ROUTER_PUBLIC_BASE_URL
  || 'https://router.teleport.computer'
).replace(/\/$/, '');
const key = process.env.PUBLIC_ROUTER_SECRET_KEY || process.env.ROUTER_SECRET_KEY || '';
const sentinel = (
  process.env.SHAPE_PUBLIC_BOUNDARY_SENTINEL
  || process.env.SHAPE_MATRIX_BOUNDARY_SENTINEL
  || ''
).trim();
const broadScan = process.env.SHAPE_PUBLIC_BOUNDARY_BROAD_SCAN === '1';

function parsePositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const pageSize = Math.min(parsePositiveInt('SHAPE_PUBLIC_BOUNDARY_PAGE_SIZE', 50), 100);
const maxEntries = parsePositiveInt('SHAPE_PUBLIC_BOUNDARY_MAX_ENTRIES', 250);

function log(message) {
  console.log(`[shape-public-boundary] ${message}`);
}

async function request(path) {
  const url = new URL(path, `${base}/`);
  if (key) url.searchParams.set('key', key);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'shape-public-boundary-smoke/1.0',
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
    throw new Error(`GET ${url.pathname} failed ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

function collectMarkers() {
  const markers = [];
  if (sentinel) markers.push(sentinel);
  if (broadScan) {
    markers.push(
      '> Source: matrix',
      'Source: Matrix',
      'matrix event id',
      'matrix_event_id',
      'Matrix room ID',
      'Shape Rotator Matrix',
      'shape-rotator,matrix',
    );
  }
  return [...new Set(markers.map(marker => marker.trim()).filter(Boolean))];
}

function findMarkers(entry, markers) {
  const findings = [];

  function visit(value, path, depth) {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      const haystack = value.toLowerCase();
      for (const marker of markers) {
        if (haystack.includes(marker.toLowerCase())) {
          findings.push({ marker, path });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const [keyName, item] of Object.entries(value)) {
        visit(item, path ? `${path}.${keyName}` : keyName, depth + 1);
      }
    }
  }

  visit(entry, '', 0);
  return findings;
}

function describeEntry(entry) {
  const id = typeof entry?.id === 'string' ? entry.id : '(unknown id)';
  const author = entry?.handle ? `@${entry.handle}` : entry?.pseudonym || '(unknown author)';
  const timestamp = entry?.timestamp ? new Date(entry.timestamp).toISOString() : '(unknown time)';
  return { id, author, timestamp };
}

async function main() {
  log(`base=${base}`);
  log(`auth=${key ? 'present' : 'anonymous'}`);

  const markers = collectMarkers();
  if (markers.length === 0) {
    const body = await request('/api/entries?limit=1');
    if (!Array.isArray(body?.entries)) {
      throw new Error(`/api/entries did not return entries array: ${JSON.stringify(body)}`);
    }
    log('/api/entries reachable');
    log('SHAPE_PUBLIC_BOUNDARY_SENTINEL not set; skipped strict raw-content boundary scan');
    return;
  }

  let cursor = null;
  let checked = 0;
  const leaks = [];

  while (checked < maxEntries) {
    const limit = Math.min(pageSize, maxEntries - checked);
    const path = cursor
      ? `/api/entries?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `/api/entries?limit=${limit}`;
    const body = await request(path);
    if (!Array.isArray(body?.entries)) {
      throw new Error(`/api/entries did not return entries array: ${JSON.stringify(body)}`);
    }

    for (const entry of body.entries) {
      checked++;
      const matches = findMarkers(entry, markers);
      if (matches.length === 0) continue;
      const described = describeEntry(entry);
      for (const match of matches) {
        leaks.push({ ...described, ...match });
      }
    }

    if (!body.nextCursor || body.entries.length === 0 || checked >= maxEntries) break;
    cursor = body.nextCursor;
  }

  if (leaks.length > 0) {
    console.error(`[shape-public-boundary] found ${leaks.length} public leak candidate${leaks.length === 1 ? '' : 's'}`);
    for (const leak of leaks.slice(0, 20)) {
      const marker = leak.marker.length > 80 ? `${leak.marker.slice(0, 77)}...` : leak.marker;
      console.error(`[shape-public-boundary] id=${leak.id} author=${leak.author} timestamp=${leak.timestamp} field=${leak.path} marker=${JSON.stringify(marker)}`);
    }
    process.exit(1);
  }

  log(`checked ${checked} recent public entr${checked === 1 ? 'y' : 'ies'}; no boundary markers found`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
