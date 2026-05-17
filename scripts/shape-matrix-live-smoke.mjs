#!/usr/bin/env node

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matrixBase = (
  process.env.MATRIX_SERVER_URL
  || process.env.MATRIX_HOMESERVER
  || 'https://mtrx.shaperotator.xyz'
).replace(/\/$/, '');
const matrixServerName = process.env.MATRIX_SERVER_NAME || new URL(matrixBase).hostname;
const shapeBase = (process.env.SHAPE_ROUTER_BASE_URL || 'https://shaperotator.teleport.computer').replace(/\/$/, '');
const shapeKey = process.env.SHAPE_ROUTER_SECRET_KEY || '';
const botHandle = process.env.MATRIX_BOT_HANDLE || 'shape-router-bridge';
let botMxid = process.env.MATRIX_USER_ID || process.env.MATRIX_BOT_USER_ID || `@${botHandle}:${matrixServerName}`;
const workdir = process.env.SHAPE_MATRIX_SMOKE_WORKDIR || '/tmp/shape-matrix-live-smoke';
const senderCredsPath = process.env.MATRIX_SMOKE_SENDER_CREDS_PATH || `${workdir}/sender-credentials.json`;
const bridgeLogPath = process.env.SHAPE_MATRIX_SMOKE_BRIDGE_LOG || `${workdir}/bridge.log`;
const sentinel = process.env.SHAPE_MATRIX_SMOKE_SENTINEL || `shape-matrix-live-smoke-${Date.now().toString(36)}`;
const useRunningBridge = process.env.SHAPE_MATRIX_SMOKE_RUNNING_BRIDGE === '1';
const matrixSpaceRoomId = process.env.MATRIX_SPACE_ROOM_ID || '!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g';

function log(message) {
  console.log(`[shape-matrix-live-smoke] ${message}`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomPassword() {
  return `sr-${randomUUID()}-${randomUUID()}`;
}

async function matrixRequest(creds, method, path, body) {
  const response = await fetch(`${matrixBase}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${creds.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function shapeRequest(path) {
  const url = new URL(path, `${shapeBase}/`);
  url.searchParams.set('key', shapeKey);
  const response = await fetch(url);
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`GET ${url.pathname} failed ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function ensureSenderCredentials() {
  if (process.env.MATRIX_SMOKE_SENDER_ACCESS_TOKEN) {
    return {
      access_token: process.env.MATRIX_SMOKE_SENDER_ACCESS_TOKEN,
      user_id: requiredEnv('MATRIX_SMOKE_SENDER_USER_ID'),
      device_id: process.env.MATRIX_SMOKE_SENDER_DEVICE_ID || 'SMOKE',
    };
  }

  if (existsSync(senderCredsPath)) {
    const creds = JSON.parse(readFileSync(senderCredsPath, 'utf8'));
    const whoami = await matrixRequest(creds, 'GET', '/_matrix/client/v3/account/whoami');
    if (whoami.user_id === creds.user_id) return creds;
  }

  const code = requiredEnv('MATRIX_SMOKE_SIGNUP_CODE');
  const username = `shape-router-smoke-${Date.now().toString(36)}`.slice(0, 32);
  const password = randomPassword();
  const response = await fetch(`${matrixBase}/signup/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      username,
      password,
      display_name: 'Shape Router smoke sender',
      intro: `Shape Router smoke sender for ${sentinel}`,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`sender signup failed ${response.status}: ${JSON.stringify(body)}`);
  }
  const creds = {
    access_token: body.access_token,
    user_id: body.user_id,
    device_id: body.device_id,
  };
  mkdirSync(dirname(senderCredsPath), { recursive: true });
  writeFileSync(senderCredsPath, `${JSON.stringify(creds)}\n`, 'utf8');
  log(`sender=${creds.user_id}`);
  return creds;
}

async function resolveBotMxid() {
  if (process.env.MATRIX_USER_ID || process.env.MATRIX_BOT_USER_ID) return botMxid;
  if (!process.env.MATRIX_ACCESS_TOKEN?.trim()) return botMxid;

  const tokenCreds = {
    access_token: process.env.MATRIX_ACCESS_TOKEN.trim(),
    user_id: botMxid,
    device_id: process.env.MATRIX_DEVICE_ID || 'BRIDGE',
  };
  const whoami = await matrixRequest(tokenCreds, 'GET', '/_matrix/client/v3/account/whoami');
  if (typeof whoami?.user_id !== 'string' || !whoami.user_id) {
    throw new Error('Matrix access token did not return user_id; set MATRIX_USER_ID');
  }
  return whoami.user_id;
}

function startBridge(label) {
  mkdirSync(workdir, { recursive: true });
  const out = createWriteStream(bridgeLogPath, { flags: label === 'initial' ? 'w' : 'a' });
  const env = {
    ...process.env,
    SHAPE_ROUTER_BASE_URL: shapeBase,
    MATRIX_SERVER_URL: matrixBase,
    MATRIX_SERVER_NAME: matrixServerName,
    MATRIX_BOT_HANDLE: botHandle,
    MATRIX_SPACE_ROOM_ID: matrixSpaceRoomId,
    MATRIX_CREDS_PATH: process.env.MATRIX_CREDS_PATH || `${workdir}/bot-credentials.json`,
    MATRIX_CRYPTO_SNAPSHOT_PATH: process.env.MATRIX_CRYPTO_SNAPSHOT_PATH || `${workdir}/bot-crypto-snapshot.json`,
    MATRIX_ONBOARDING_STATE_PATH: process.env.MATRIX_ONBOARDING_STATE_PATH || `${workdir}/bot-onboarding-state.json`,
    SHAPE_MATRIX_BRIDGE_STATE_PATH: process.env.SHAPE_MATRIX_BRIDGE_STATE_PATH || `${workdir}/bridge-state.json`,
    SHAPE_MATRIX_ENABLE_ONBOARDING: '0',
    SHAPE_MATRIX_BRIDGE_POLL_MS: '500',
  };

  const child = spawn('node', ['server/dist/shape-matrix-bridge.js'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 50_000) buffer = buffer.slice(-25_000);
  });
  child.stderr.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 50_000) buffer = buffer.slice(-25_000);
  });

  return { child, out, getLog: () => buffer };
}

async function waitForBridgeReady(bridge, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = bridge.getLog();
    if (text.includes('Initial sync complete')) return;
    if (text.includes('Matrix auth failed') || text.includes('Error:')) {
      throw new Error(`bridge startup failed; see ${bridgeLogPath}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`bridge did not become ready within ${timeoutMs}ms; see ${bridgeLogPath}`);
}

async function stopBridge(bridge, timeoutMs = 60_000) {
  if (bridge.child.exitCode != null || bridge.child.signalCode) return;
  bridge.child.kill('SIGTERM');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (bridge.child.exitCode != null || bridge.child.signalCode) {
      bridge.out.end();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  bridge.child.kill('SIGKILL');
  bridge.out.end();
  throw new Error('bridge did not stop after SIGTERM');
}

async function waitForJoined(creds, roomId, userId, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await matrixRequest(creds, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`).catch(() => null);
    if (body?.joined?.[userId]) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${userId} did not join ${roomId}`);
}

async function sendRoomText(creds, roomId, text, extraContent = {}) {
  const txn = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sentAt = Date.now();
  const body = await matrixRequest(
    creds,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`,
    { msgtype: 'm.text', body: text, ...extraContent },
  );
  return { eventId: body.event_id, sentAt };
}

async function sendBotMention(creds, roomId, text) {
  return sendRoomText(creds, roomId, `@${botHandle} ${text}`, {
    'm.mentions': { user_ids: [botMxid] },
  });
}

async function createSmokeMentionRoom(sender) {
  const room = await matrixRequest(sender, 'POST', '/_matrix/client/v3/createRoom', {
    preset: 'private_chat',
    invite: [botMxid],
    name: `Shape Router mention smoke ${sentinel}`,
    initial_state: [
      {
        type: 'm.space.parent',
        state_key: matrixSpaceRoomId,
        content: {
          via: [matrixServerName],
          canonical: true,
        },
      },
    ],
  });
  return room.room_id;
}

async function waitForReply(creds, roomId, expected, command, timeoutMs = 90_000) {
  const expectedParts = Array.isArray(expected) ? expected : [expected];
  const afterEventId = typeof command === 'string' ? command : command?.eventId;
  const sentAt = typeof command === 'object' ? command.sentAt : 0;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await matrixRequest(
      creds,
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=30`,
    );
    const events = body.chunk || [];
    const reply = events.find(event => {
      if (event.type !== 'm.room.message') return false;
      if (event.sender !== botMxid) return false;
      if (event.event_id === afterEventId) return false;
      if (typeof event.content?.body !== 'string') return false;
      if (!expectedParts.every(part => event.content.body.includes(part))) return false;

      const relatesToEvent =
        event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id
        || event.content?.['m.relates_to']?.event_id;
      if (afterEventId && relatesToEvent) return relatesToEvent === afterEventId;
      if (sentAt) return Number(event.origin_server_ts || 0) >= sentAt;
      return true;
    });
    if (reply) return reply;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`timed out waiting for bot reply containing ${JSON.stringify(expectedParts)}`);
}

async function countPrivateEntriesContaining(text) {
  return (await privateEntriesContaining(text)).length;
}

async function privateEntriesContaining(text) {
  const byId = new Map();
  for (const path of [
    `/api/entries?q=${encodeURIComponent(text)}&limit=100`,
    '/api/entries?limit=100',
  ]) {
    const body = await shapeRequest(path);
    for (const entry of body.entries || []) {
      if (entry.id) byId.set(entry.id, entry);
    }
  }

  const detailed = [];
  for (const entry of byId.values()) {
    const detail = await shapeRequest(`/api/entries/${encodeURIComponent(entry.id)}`);
    const detailedEntry = detail.entry || entry;
    if (JSON.stringify(detailedEntry).includes(text)) detailed.push(detailedEntry);
  }
  return detailed;
}

function assertPrivateEntryProvenance(entries) {
  const dmNote = entries.find(entry =>
    (entry.tags || []).includes('matrix-note')
    && String(entry.content || '').includes('Source: Matrix DM')
    && String(entry.content || '').includes('Matrix event:')
    && String(entry.content || '').includes('Organizer:')
    && String(entry.content || '').includes('private bridge save smoke')
  );
  if (!dmNote) {
    throw new Error('expected private Matrix DM note entry with matrix-note tag and Matrix provenance');
  }

  const roomNote = entries.find(entry =>
    (entry.tags || []).includes('matrix-note')
    && String(entry.content || '').includes('Source: Matrix room')
    && String(entry.content || '').includes('Matrix event:')
    && String(entry.content || '').includes('Organizer:')
    && String(entry.content || '').includes('explicit room save smoke')
  );
  if (!roomNote) {
    throw new Error('expected private Matrix room note entry with matrix-note tag and Matrix provenance');
  }

  const dmSummary = entries.find(entry =>
    (entry.tags || []).includes('matrix-summary')
    && String(entry.content || '').includes('Source: Matrix DM')
    && String(entry.content || '').includes('Window:')
    && String(entry.content || '').includes('Participants:')
    && String(entry.content || '').includes('private bridge save smoke')
  );
  if (!dmSummary) {
    throw new Error('expected private Matrix DM summary entry with matrix-summary tag and room/window provenance');
  }

  const roomSummary = entries.find(entry =>
    (entry.tags || []).includes('matrix-summary')
    && String(entry.content || '').includes('Source: Matrix room')
    && !String(entry.content || '').includes('Source: Matrix DM')
    && String(entry.content || '').includes('Window:')
    && String(entry.content || '').includes('Participants:')
    && String(entry.content || '').includes('explicit room save smoke')
  );
  if (!roomSummary) {
    throw new Error('expected private Matrix room summary entry with matrix-summary tag and room/window provenance');
  }
}

async function runPublicBoundaryCheck() {
  const child = spawn('node', ['scripts/shape-public-boundary-smoke.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SHAPE_PUBLIC_BOUNDARY_SENTINEL: sentinel,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) throw new Error(`public boundary check failed:\n${output}`);
  return output.trim().split('\n').at(-1) || 'public boundary passed';
}

async function main() {
  if (!shapeKey) throw new Error('SHAPE_ROUTER_SECRET_KEY is required');
  if (!useRunningBridge && !existsSync(resolve(repoRoot, 'server/dist/shape-matrix-bridge.js'))) {
    throw new Error('server/dist/shape-matrix-bridge.js missing; run npm --prefix server run build');
  }

  mkdirSync(workdir, { recursive: true });
  botMxid = await resolveBotMxid();
  log(`sentinel=${sentinel}`);
  log(`bot=${botMxid}`);
  log(`bridge=${useRunningBridge ? 'already-running' : 'local-process'}`);
  const sender = await ensureSenderCredentials();

  const bridge = useRunningBridge ? null : startBridge('initial');
  try {
    if (bridge) {
      await waitForBridgeReady(bridge);
      log('bridge initial sync ready');
    } else {
      log('using already-running bridge; startup/restart checks are skipped');
    }

    const room = await matrixRequest(sender, 'POST', '/_matrix/client/v3/createRoom', {
      preset: 'private_chat',
      is_direct: true,
      invite: [botMxid],
      name: `Shape Router smoke ${sentinel}`,
    });
    const roomId = room.room_id;
    log(`room=${roomId}`);
    await waitForJoined(sender, roomId, botMxid);

    const saveCommand = await sendRoomText(sender, roomId, `save ${sentinel} private bridge save smoke`);
    await waitForReply(sender, roomId, 'Saved to private Shape Router', saveCommand);
    log('Matrix save/reply ok');

    const searchCommand = await sendRoomText(sender, roomId, `search ${sentinel}`);
    await waitForReply(sender, roomId, ['Private Shape Router search results', sentinel], searchCommand);
    log('Matrix search/reply ok');

    const mentionRoomId = await createSmokeMentionRoom(sender);
    log(`mention_room=${mentionRoomId}`);
    await waitForJoined(sender, mentionRoomId, botMxid);

    const mentionCommand = await sendBotMention(sender, mentionRoomId, `search ${sentinel}`);
    await waitForReply(sender, mentionRoomId, ['Private Shape Router search results', sentinel], mentionCommand);
    log('Matrix explicit mention/search/reply ok');

    const roomSaveCommand = await sendBotMention(sender, mentionRoomId, `save ${sentinel} explicit room save smoke`);
    await waitForReply(sender, mentionRoomId, 'Saved to private Shape Router', roomSaveCommand);
    log('Matrix explicit room save/reply ok');

    const roomSummaryCommand = await sendBotMention(sender, mentionRoomId, `summarize this room 5m ${sentinel}`);
    await waitForReply(sender, mentionRoomId, 'Saved Matrix room context to private Shape Router', roomSummaryCommand);
    log('Matrix explicit room summary/reply ok');

    const summaryCommand = await sendRoomText(sender, roomId, `summarize this room 5m`);
    await waitForReply(sender, roomId, 'Saved Matrix room context to private Shape Router', summaryCommand);
    log('Matrix summary/reply ok');

    const privateEntries = await privateEntriesContaining(sentinel);
    assertPrivateEntryProvenance(privateEntries);
    const beforeRestartCount = privateEntries.length;
    if (beforeRestartCount < 4) {
      throw new Error(`expected at least DM save/summary + room save/summary private entries for sentinel, found ${beforeRestartCount}`);
    }
    log(`private entries containing sentinel=${beforeRestartCount}`);

    log(await runPublicBoundaryCheck());

    if (!bridge) {
      log('restart duplicate check skipped for already-running bridge mode');
      log('live Matrix smoke passed');
      return;
    }

    await stopBridge(bridge);
    log('bridge stopped for restart check');

    const restarted = startBridge('restart');
    try {
      await waitForBridgeReady(restarted);
      await new Promise(resolve => setTimeout(resolve, 5000));
    } finally {
      await stopBridge(restarted);
    }

    const afterRestartCount = await countPrivateEntriesContaining(sentinel);
    if (afterRestartCount !== beforeRestartCount) {
      throw new Error(`duplicate replay suspected: private sentinel count ${beforeRestartCount} -> ${afterRestartCount}`);
    }
    log(`restart duplicate check ok count=${afterRestartCount}`);
    log('live Matrix smoke passed');
  } catch (error) {
    if (bridge) await stopBridge(bridge).catch(() => {});
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
