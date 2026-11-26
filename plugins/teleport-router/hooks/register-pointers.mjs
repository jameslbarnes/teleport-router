#!/usr/bin/env node
// Claude Code hook: after a Router post, and at session start, run the capture script in its pointer-only mode,
// so that Router learns which of your posts have a trace held on this machine (see scripts/capture-traces.mjs).
// Nothing of a trace is sent.
//
//   node register-pointers.mjs post    PostToolUse on this plugin's Router write tools: reads this session's log
//                                      once it holds the result of that call
//   node register-pointers.mjs start   SessionStart: catches posts an earlier run missed, from this project's
//                                      logs that changed in the last two days
//
// Only Claude Code's session folders are read. --pointers-only registers only this plugin's Claude Code posts, so
// reading Codex's logs here (which can run to hundreds of megabytes) would be wasted work; the manual --pointers
// command still covers Codex.
//
// It runs in the background (the hook is async), never prints anything, never fails the session, and stops itself
// and the script after two minutes. The script runs with V8's old-generation heap capped at SCRIPT_HEAP_MB
// (--max-old-space-size): a run that would need more stops instead of growing. That bounds the JavaScript heap, not
// the whole process, whose memory also holds Node itself, buffers and the young generation. The script reads logs one
// line at a time and needs far less.
// It can only ever register pointers: it runs the script with --pointers-only,
// which refuses every upload and open option, and it never names a Router address, so the key goes only to
// Router itself. A session log named in the hook's input is used only if it is a regular file inside Claude
// Code's session folders; anything else falls back to a scan of Claude Code's folders. The Router key is the one you gave the
// plugin, which Claude Code hands this hook as CLAUDE_PLUGIN_OPTION_ROUTER_KEY; without a key it does nothing.
// "pointers": false in ~/.router/traces/rules.json stops the registering; the local index and copy are still kept.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT_MS = 120_000;
const SCRIPT_HEAP_MB = 512;
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'capture-traces.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Claude Code's projects folders, which the hook reads. */
export function claudeRoots(env = process.env) {
  const roots = [join(homedir(), '.claude', 'projects')];
  if (env.CLAUDE_CONFIG_DIR) roots.push(join(env.CLAUDE_CONFIG_DIR, 'projects'));
  return roots;
}

/** The log's real path if it is a regular file inside one of the roots (links resolved on both sides), else null. */
export async function checkedLog(path, roots = claudeRoots()) {
  if (typeof path !== 'string' || !path || path.length > 4096 || !isAbsolute(path)) return null;
  const real = await realpath(path).catch(() => null);
  if (!real || !(await lstat(real).catch(() => null))?.isFile()) return null;
  for (const root of roots) {
    const base = await realpath(root).catch(() => null);
    if (!base) continue;
    const rel = relative(base, real);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return real;
  }
  return null;
}

/** The end of a log, where the newest records are. */
async function tail(path, bytes = 2 * 1024 * 1024) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, bytes), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}

/**
 * The capture script's arguments for one hook run. Always --pointers-only, never --router; paths are passed in
 * --option=value form. `waitMs` bounds the wait for the session log to hold the post's result. Without a usable
 * session log it scans Claude Code's folders (`roots`). A log is used only if it is inside one of them, so a
 * path into Codex's sessions folder also falls back to that scan, never to reading Codex's folder.
 */
export async function plan(mode, input = {}, { roots = claudeRoots(), waitMs = 30_000 } = {}) {
  const log = await checkedLog(input.transcript_path, roots);
  const claudeScan = roots.map(r => `--projects=${r}`);
  if (mode === 'start') {
    // This project's logs, where the previous sessions here posted. Unchanged logs are skipped.
    if (!log) return ['--pointers-only', ...claudeScan];
    return ['--pointers-only', `--projects=${dirname(log)}`];
  }
  if (mode !== 'post') return null;
  if (!log) return ['--pointers-only', ...claudeScan, '--days', '1'];
  // The session log is written a little after the hook fires. Wait until it holds the result of this call.
  const id = typeof input.tool_use_id === 'string' && /^[\w-]{1,200}$/.test(input.tool_use_id) ? input.tool_use_id : null;
  const deadline = Date.now() + waitMs;
  while (id && Date.now() < deadline) {
    if ((await tail(log)).includes(`"tool_use_id":"${id}"`)) return ['--pointers-only', `--log=${log}`];
    await sleep(1_000);
  }
  // Not found, for example because a subagent posted and keeps its own log: read this project's recent logs instead.
  return ['--pointers-only', `--projects=${dirname(log)}`, '--days', '1'];
}

let current = null;
/** Run the capture script; when another run holds its state file, try again a little later. */
async function capture(args) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { code, err } = await new Promise(resolve => {
      const child = current = spawn(process.execPath, [`--max-old-space-size=${SCRIPT_HEAP_MB}`, script, ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err = (err + d).slice(-2000); });
      child.on('error', () => resolve({ code: -1, err }));
      child.on('close', code => { current = null; resolve({ code, err }); });
    });
    if (code === 0 || !/Another run is using/.test(err)) return;
    await sleep(5_000 + attempt * 5_000);
  }
}

async function readInput() {
  if (process.stdin.isTTY) return {};
  let text = '';
  process.stdin.setEncoding('utf8');
  const done = new Promise(resolve => { process.stdin.on('data', d => { text += d; if (text.length > 4_000_000) resolve(); }); process.stdin.on('end', resolve); process.stdin.on('error', resolve); });
  await Promise.race([done, sleep(5_000)]);
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

async function main() {
  if (!process.env.CLAUDE_PLUGIN_OPTION_ROUTER_KEY && !process.env.ROUTER_KEY) return;
  const args = await plan(process.argv[2], await readInput());
  if (args) await capture(args);
}

/** True when this file was run directly. Compares real paths: Node resolves links in import.meta.url but not in argv,
 *  so a plugin folder reached through a link (a symlink or junction) would otherwise never run. */
export function isEntry(argv1 = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(self); } catch { return false; }
}

if (isEntry()) {
  // On the time limit, stop the script too, so nothing outlives the hook.
  const quit = () => { try { current?.kill(); } catch { /* already gone */ } process.exit(0); };
  setTimeout(quit, LIMIT_MS).unref();
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  main().then(quit, quit);
}
