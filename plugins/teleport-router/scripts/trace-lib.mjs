// The private trace behind one Router post: find it in a Claude Code or Codex session log, clean it,
// and encrypt it so that only its owner's key opens it.
//
// A trace is the part of the session that led to the post: every kept record after the
// session's previous post (or its start) up to the result of this post's write call. The
// slices split a session cleanly, so no record belongs to two posts.
//
// The envelope is the same format as server/src/trace-envelope.ts; server/src/trace-capture.test.ts
// checks the two against each other. Node built-ins only, so the plugin needs no install step.
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, ECDH } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// ── Envelope ────────────────────────────────────────────────────────────────────────────

const b64 = b => Buffer.from(b).toString('base64url');
function unb64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid trace envelope encoding');
  const out = Buffer.from(value, 'base64url');
  if (out.toString('base64url') !== value || (length !== undefined && out.length !== length)) throw new Error('Invalid trace envelope field');
  return out;
}
export const sha256Hex = b => createHash('sha256').update(b).digest('hex');

/** Compressed secp256k1 public key, 0x-prefixed. Accepts compressed or uncompressed input. */
export function compressPublicKey(publicKey) {
  const raw = Buffer.from(String(publicKey).replace(/^0x/, ''), 'hex');
  if (raw.length !== 33 && raw.length !== 65) throw new Error('Expected a secp256k1 public key');
  return '0x' + Buffer.from(ECDH.convertKey(raw, 'secp256k1', undefined, undefined, 'compressed')).toString('hex');
}
export function publicKeyOf(privateKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Expected a 32-byte hex private key');
  const ecdh = createECDH('secp256k1'); ecdh.setPrivateKey(Buffer.from(privateKey.slice(2), 'hex'));
  return '0x' + ecdh.getPublicKey('hex', 'compressed');
}

const partAAD = (c, part) => Buffer.from(JSON.stringify(['teleport-router/trace/v1', c.ownerDid.toLowerCase(), c.entryId, part]));
const wrapAAD = (c, part, role, recipient, ephemeral) =>
  Buffer.from(JSON.stringify(['teleport-router/trace-wrap/v1', c.ownerDid.toLowerCase(), c.entryId, part, role, recipient, ephemeral]));
const kek = (secret, aad) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), aad, 32));

/** Encrypt the full record for its owner alone. Returns the record Router stores and the ciphertext. */
export function sealFull(plaintext, context, ownerPublicKey) {
  const recipient = compressPublicKey(ownerPublicKey);
  const contentKey = randomBytes(32), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, nonce, { authTagLength: 16 });
  cipher.setAAD(partAAD(context, 'full'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ephemeral = createECDH('secp256k1'); ephemeral.generateKeys();
  const ephemeralPublicKey = '0x' + ephemeral.getPublicKey('hex', 'compressed');
  const aad = wrapAAD(context, 'full', 'owner', recipient, ephemeralPublicKey);
  const wrapNonce = randomBytes(12);
  const wrapper = createCipheriv('aes-256-gcm', kek(ephemeral.computeSecret(Buffer.from(recipient.slice(2), 'hex')), aad), wrapNonce, { authTagLength: 16 });
  wrapper.setAAD(aad);
  const wrapped = Buffer.concat([wrapper.update(contentKey), wrapper.final()]);
  contentKey.fill(0);
  return {
    meta: { nonce: b64(nonce), tag: b64(tag), sha256: sha256Hex(ciphertext), bytes: ciphertext.length,
      wraps: { owner: { ephemeralPublicKey, nonce: b64(wrapNonce), ciphertext: b64(wrapped), tag: b64(wrapper.getAuthTag()) } } },
    ciphertext,
  };
}

/** The owner opens their own record. Throws if the key, the post or the ciphertext does not match. */
export function openFull(meta, ciphertext, context, ownerPrivateKey) {
  if (sha256Hex(ciphertext) !== meta.sha256 || ciphertext.length !== meta.bytes) throw new Error('Trace ciphertext does not match its record');
  const wrap = meta.wraps?.owner;
  if (!wrap || !/^0x(?:02|03)[0-9a-f]{64}$/.test(wrap.ephemeralPublicKey || '')) throw new Error('This trace is not wrapped for an owner key');
  const ecdh = createECDH('secp256k1'); ecdh.setPrivateKey(Buffer.from(ownerPrivateKey.replace(/^0x/, ''), 'hex'));
  const recipient = '0x' + ecdh.getPublicKey('hex', 'compressed');
  const aad = wrapAAD(context, 'full', 'owner', recipient, wrap.ephemeralPublicKey);
  const unwrapper = createDecipheriv('aes-256-gcm', kek(ecdh.computeSecret(Buffer.from(wrap.ephemeralPublicKey.slice(2), 'hex')), aad), unb64(wrap.nonce, 12), { authTagLength: 16 });
  unwrapper.setAAD(aad); unwrapper.setAuthTag(unb64(wrap.tag, 16));
  const contentKey = Buffer.concat([unwrapper.update(unb64(wrap.ciphertext, 32)), unwrapper.final()]);
  try {
    const decipher = createDecipheriv('aes-256-gcm', contentKey, unb64(meta.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(partAAD(context, 'full')); decipher.setAuthTag(unb64(meta.tag, 16));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally { contentKey.fill(0); }
}

// ── Finding posts in a session log ──────────────────────────────────────────────────────

const WRITE_TOOL = /(?:^|__)(?:router_write_entry|write_to_shared_notebook)$/;
const WRITE_HINTS = ['router_write_entry', 'write_to_shared_notebook'];
/**
 * Tools whose results are never uploaded, even encrypted: each owner lists their own, as tool-name
 * prefixes such as "mcp__diary__". Matched anywhere in the tool name. None by default.
 */
export const NEVER_UPLOAD_TOOLS = [];
/** Record types that carry the conversation. Bookkeeping records (request logs, file snapshots, queue state, token counts) are left out. */
const KEPT_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'summary']);
// Codex wraps everything in { type, payload }. Model input and output are response_item records; an MCP call and its
// result are one item_completed record. Command output appears in both, so only the response_item copy is kept.
const codexMcpCall = record => record?.type === 'event_msg' && record.payload?.type === 'item_completed' && record.payload.item?.type === 'McpToolCall' ? record.payload.item : null;
const keptRecord = record => KEPT_TYPES.has(record.type) || record.type === 'response_item' || record.type === 'compacted' || !!codexMcpCall(record);
const typeLabel = record => record.payload && typeof record.payload.type === 'string' ? `${record.type}/${record.payload.type}` : record.type || 'unknown';
/** "mcp__diary__" also names the Codex MCP server "diary". */
const serverOf = pattern => /^mcp__([A-Za-z0-9-]+)__/.exec(pattern)?.[1] || null;
const mentionsTool = (raw, pattern) => raw.includes(pattern) || (serverOf(pattern) !== null && raw.includes(`"server":"${serverOf(pattern)}"`));
/** Whether a log could contain a call to a never-upload tool. A cheap test before reading it line by line. */
export const mentionsNeverUpload = (text, patterns) => patterns.some(p => mentionsTool(text, p));

const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
const blocksOf = record => Array.isArray(record?.message?.content) ? record.message.content.filter(b => b && typeof b === 'object') : [];
const resultText = block => typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? block.content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('') : '';

// Router answers a write with a receipt. Depending on the client it arrives as structured content,
// as JSON text, or as a written notice with an "Entry ID:" line and a review link.
function entryIdFrom(text, structured) {
  const parsed = parse(text);
  for (const id of [structured?.receipt?.entry_id, structured?.entry_id, parsed?.receipt?.entry_id, parsed?.entry_id])
    if (typeof id === 'string' && /^[\w-]{1,160}$/.test(id)) return id;
  return /"entry_id"\s*:\s*"([\w-]{1,160})"/.exec(text)?.[1]
    || /^Entry ID:\s*([\w-]{1,160})\s*$/m.exec(text)?.[1]
    || /\/e\/([\w-]{1,160})#manage/.exec(text)?.[1] || null;
}

/**
 * One item per successful Router write in a session log, in order.
 * `lines` are the raw JSONL lines. A post's slice is lines [firstLine, lastLine], inclusive.
 *
 * `withheld` marks posts whose trace must not be uploaded:
 *   - from the first call to a never-upload tool onward, because later slices may quote what it returned
 *   - the whole log, when it belongs to a session started by one that made such a call (`excludedSessions`)
 *   - the whole log, when it opens with a summary of an earlier session, whose history cannot be checked
 * `sessionId`, `parentSessionId` and `calledNeverUpload` let the caller carry exclusions from log to log.
 */
export function findPosts(lines, { neverUpload = NEVER_UPLOAD_TOOLS, excludedSessions = new Set(), fileName = '' } = {}) {
  const origin = sessionOrigin(lines, fileName);
  const posts = [], pending = new Map();
  let withheld = origin.startsFromSummary ? 'the session log opens with a summary of an earlier session that cannot be checked'
    : origin.parentSessionId && excludedSessions.has(origin.parentSessionId) ? 'a session this one descends from called a tool whose results are never uploaded, or its log has not been read so that cannot be ruled out' : null;
  let first = 0, previous = null, failed = 0, unrecognized = 0, calledNeverUpload = false;
  const never = name => { const hit = neverUpload.find(p => name.includes(p)); if (hit) { calledNeverUpload = true; withheld ||= `the session called ${hit}, whose results are never uploaded`; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const mentionsWrite = WRITE_HINTS.some(h => raw.includes(h));
    const mentionsNever = !calledNeverUpload && neverUpload.some(p => mentionsTool(raw, p));
    let mentionsPending = false;
    if (pending.size) for (const id of pending.keys()) if (raw.includes(id)) { mentionsPending = true; break; }
    if (!mentionsWrite && !mentionsNever && !mentionsPending) continue;
    const record = parse(raw);
    const call = codexMcpCall(record);
    if (call) {
      const name = `mcp__${call.server}__${call.tool}`;
      never(name);
      if (WRITE_TOOL.test(name)) {
        const text = (Array.isArray(call.result?.content) ? call.result.content : []).map(c => (c && typeof c.text === 'string') ? c.text : '').join('');
        const bad = call.status !== 'completed' || call.error || call.result?.isError || call.result?.is_error;
        const entryId = bad ? null : entryIdFrom(text, call.result?.structuredContent);
        if (!entryId) { bad ? failed++ : unrecognized++; continue; }
        posts.push({ entryId, agent: 'codex', firstLine: first, lastLine: i, previousEntryId: previous, sessionId: record.payload.thread_id || origin.sessionId,
          postedAt: record.timestamp || null, withheld });
        first = i + 1; previous = entryId;
      }
      continue;
    }
    for (const block of blocksOf(record)) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        never(block.name);
        if (WRITE_TOOL.test(block.name) && typeof block.id === 'string') pending.set(block.id, { line: i });
      } else if (block.type === 'tool_result' && pending.has(block.tool_use_id)) {
        pending.delete(block.tool_use_id);
        const entryId = block.is_error ? null : entryIdFrom(resultText(block), record.mcpMeta?.structuredContent ?? record.toolUseResult?.structuredContent);
        if (!entryId) { block.is_error ? failed++ : unrecognized++; continue; }
        posts.push({ entryId, agent: 'claude-code', firstLine: first, lastLine: i, previousEntryId: previous, sessionId: record.sessionId || origin.sessionId,
          postedAt: record.timestamp || null, withheld });
        first = i + 1; previous = entryId;
      }
    }
  }
  return { posts, failedWrites: failed, unrecognizedResults: unrecognized, unanswered: pending.size,
    sessionId: origin.sessionId, logSessionId: origin.logSessionId, parentSessionId: origin.parentSessionId, calledNeverUpload, startsFromSummary: origin.startsFromSummary };
}

/**
 * Which session a log belongs to, which session started it, and whether it opens with carried-over history.
 * `logSessionId` names this log itself; a caller that records it with `parentSessionId` for every log can
 * follow exclusions through any number of generations.
 */
export function sessionOrigin(lines, fileName = '') {
  const meta = parse(lines[0] || '');
  if (meta?.type === 'session_meta') {   // Codex
    const p = meta.payload || {};
    let startsFromSummary = false;
    for (let i = 1; i < Math.min(lines.length, 5000); i++) {
      if (lines[i].includes('"type":"compacted"') && parse(lines[i])?.type === 'compacted') { startsFromSummary = true; break; }
      if (lines[i].includes('"type":"response_item"') && parse(lines[i])?.type === 'response_item') break;
    }
    const sessionId = p.id || p.session_id || null;
    return { sessionId, logSessionId: sessionId, parentSessionId: p.parent_thread_id || null, startsFromSummary };
  }
  let sessionId = null, startsFromSummary = false;
  for (let i = 0; i < Math.min(lines.length, 5000); i++) {
    const raw = lines[i];
    if (!sessionId && raw.includes('"sessionId"')) sessionId = parse(raw)?.sessionId || null;
    if (!/"type":"(?:user|assistant|summary)"/.test(raw)) continue;
    const record = parse(raw);
    if (!record || !['user', 'assistant', 'summary'].includes(record.type)) continue;
    sessionId ||= record.sessionId || null;
    startsFromSummary = record.type === 'summary' || record.isCompactSummary === true;
    break;
  }
  // A Claude Code subagent's log carries the session ID of the session that started it, under its own file name.
  const stem = fileName.replace(/\.jsonl$/, '');
  const subagent = !!(stem && sessionId && stem !== sessionId);
  return { sessionId, logSessionId: subagent ? stem : sessionId, parentSessionId: subagent ? sessionId : null, startsFromSummary };
}

// ── Cleaning ────────────────────────────────────────────────────────────────────────────

const REMOVED = '[secret removed]';
// Best effort. Encryption to the owner's key is what protects the record; this keeps
// credentials out of it so that reading or later sharing a trace does not leak them.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bRD-PAIR-[A-Za-z0-9_-]{16,}/g,
  /\brdg1\.[A-Za-z0-9._-]{16,}/g,
  /\b0x[0-9a-fA-F]{64}\b/g,
];
// A name that says "this is a credential", then its value. Keeps the name, removes the value.
const NAMED_SECRET = /((?:secret[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token)\\?["']?\s*[:=]\s*\\?["']?)([^\s"'\\&,;<>)}\]]{8,})/gi;
const URL_SECRET = /([?&](?:key|secret_key|token|access_token|api_key|invite_token)=)([^&\s"'\\<>)]{8,})/gi;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g;

export function scrubText(text, extraSecrets = []) {
  let count = 0, out = text;
  for (const secret of extraSecrets) {
    if (typeof secret !== 'string' || secret.length < 12 || !out.includes(secret)) continue;
    count += out.split(secret).length - 1; out = out.split(secret).join(REMOVED);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, () => { count++; return REMOVED; });
  for (const pattern of [NAMED_SECRET, URL_SECRET, BEARER]) out = out.replace(pattern, (m, lead, value) => value === REMOVED || value.startsWith('[secret') ? m : (count++, lead + REMOVED));
  return { text: out, count };
}

function deepStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(v => deepStrings(v, fn));
  if (value && typeof value === 'object') { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = deepStrings(v, fn); return out; }
  return value;
}

/**
 * Clean the parsed records of one slice. Returns new records and counts; the input is not changed.
 *   - bookkeeping record types are left out
 *   - provider ciphertext (thinking signatures, redacted thinking, encrypted reasoning) is dropped
 *     wherever it is nested, including inside compacted history; nobody but the provider can read it
 *   - the duplicate copy of each tool result (toolUseResult) is dropped; the result itself stays
 *   - inline images and files are replaced by their size
 *   - credentials it recognises are replaced by a marker (best effort)
 */
export function cleanRecords(records, { extraSecrets = [] } = {}) {
  const stats = { records_in: records.length, records_kept: 0, left_out_by_type: {}, provider_ciphertext_bytes: 0,
    duplicate_result_bytes: 0, images_removed: 0, secrets_removed: 0 };
  const clean = value => {
    if (typeof value === 'string') {
      if (value.length > 200 && /^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(value)) { stats.images_removed++; return `[removed: inline file, ${value.length} characters]`; }
      const r = scrubText(value, extraSecrets); stats.secrets_removed += r.count; return r.text;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'redacted_thinking') { stats.provider_ciphertext_bytes += String(value.data || '').length; return { type: 'redacted_thinking', removed: 'provider ciphertext' }; }
    if (value.type === 'image' && value.source && typeof value.source.data === 'string') { stats.images_removed++; return { type: 'image', removed: `image, ${value.source.data.length} base64 characters` }; }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'encrypted_content' || (key === 'signature' && value.type === 'thinking')) { stats.provider_ciphertext_bytes += String(child || '').length; continue; }
      out[key] = clean(child);
    }
    return out;
  };
  const out = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (!keptRecord(record)) { const label = typeLabel(record); stats.left_out_by_type[label] = (stats.left_out_by_type[label] || 0) + 1; continue; }
    const copy = { ...record };
    for (const key of ['toolUseResult', 'mcpMeta']) {
      if (copy[key] !== undefined) { stats.duplicate_result_bytes += JSON.stringify(copy[key]).length; delete copy[key]; }
    }
    out.push(clean(copy));
  }
  stats.records_kept = out.length;
  return { records: out, stats };
}

// ── Building the record ─────────────────────────────────────────────────────────────────

const clip = (s, limit) => s.length <= limit ? s
  : `${s.slice(0, Math.floor(limit * 0.6))}\n[… ${s.length - limit} characters left out to fit the size limit …]\n${s.slice(-Math.floor(limit * 0.4))}`;

/**
 * The plaintext of one post's trace: gzipped JSON. Long strings are shortened, longest first,
 * only when the record would not fit `maxBytes`; what was shortened is written in the record.
 */
export function buildTrace({ post, lines, source = {}, extraSecrets = [], maxBytes = 5_000_000 }) {
  const header = { v: 1, kind: 'router-post-trace', entry_id: post.entryId, agent: post.agent || 'claude-code', session_id: post.sessionId,
    posted_at: post.postedAt, previous_entry_id: post.previousEntryId, ...source,
    slice: { first_line: post.firstLine, last_line: post.lastLine } };
  if (post.withheld) {
    const doc = { ...header, withheld: `Not uploaded: ${post.withheld}.`, records: [] };
    return { plaintext: gzipSync(Buffer.from(JSON.stringify(doc))), summary: { withheld: true, records: 0, shortened_to: null } };
  }
  const parsed = [];
  for (let i = post.firstLine; i <= post.lastLine; i++) { const r = parse(lines[i]); if (r) parsed.push(r); }
  const cleaned = cleanRecords(parsed, { extraSecrets });
  let records = cleaned.records, shortenedTo = null, droppedOldest = 0;
  const pack = () => gzipSync(Buffer.from(JSON.stringify({ ...header,
    cleaning: { rules: 1, ...cleaned.stats, strings_shortened_to: shortenedTo, oldest_records_left_out: droppedOldest }, records })));
  let plaintext = pack();
  for (const limit of [200_000, 50_000, 10_000, 2_000]) {
    if (plaintext.length <= maxBytes) break;
    shortenedTo = limit; records = deepStrings(records, s => clip(s, limit)); plaintext = pack();
  }
  while (plaintext.length > maxBytes && records.length > 1) {
    const drop = Math.ceil(records.length / 4); droppedOldest += drop; records = records.slice(drop); plaintext = pack();
  }
  if (plaintext.length > maxBytes) throw new Error('The trace does not fit the size limit even after shortening');
  return { plaintext, summary: { withheld: false, records: records.length, shortened_to: shortenedTo, oldest_left_out: droppedOldest, ...cleaned.stats } };
}

/** Where a post's session ran: read from the log itself, never from outside it. */
export function sourceOf(lines, post) {
  if (post.agent === 'codex') {
    const meta = parse(lines[0] || '');
    const p = meta?.type === 'session_meta' ? meta.payload || {} : {};
    return { cwd: p.cwd || null, git_branch: null, agent_version: p.cli_version || null };
  }
  for (let i = post.firstLine; i <= post.lastLine; i++) {
    if (!lines[i].includes('"cwd"')) continue;
    const r = parse(lines[i]);
    if (r?.cwd) return { cwd: r.cwd, git_branch: r.gitBranch || null, agent_version: r.version || null };
  }
  return { cwd: null, git_branch: null, agent_version: null };
}

export const readTrace = plaintext => JSON.parse(gunzipSync(plaintext).toString('utf8'));
