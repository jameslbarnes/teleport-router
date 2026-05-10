/**
 * Repro bot — runs Router's MatrixPlatform pointed at hs-a, then
 * accepts driver commands on stdin. The driver is run-baseline.sh /
 * run-repro.sh which orchestrates the full scenario across both HSes.
 *
 * Stdin protocol (one JSON object per line):
 *   {"cmd": "create-room"}              → creates an encrypted room, prints room_id
 *   {"cmd": "invite", "user": "..."}    → invites mxid to the current room
 *   {"cmd": "send", "text": "..."}      → sends a text message
 *   {"cmd": "rotate"}                   → forceDiscardSession on the current room
 *   {"cmd": "exit"}
 *
 * Replies via stdout, also one JSON object per line:
 *   {"ok": true, "room_id": "..."} | {"ok": true, "event_id": "..."} | {"err": "..."}
 *
 * The driver matches request/reply by sequence — each reply corresponds
 * to the most recent command. Bot state (current room id) is implicit.
 */
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { MatrixPlatform } from '../../../server/src/platform/matrix.js';

const SERVER_URL  = process.env.FED_REPRO_HS_A_URL  || 'http://localhost:8001';
const SERVER_NAME = process.env.FED_REPRO_HS_A_NAME || 'hs-a';
const REG_TOKEN   = process.env.FED_REPRO_TOKEN     || 'fedrepro';
const BOT_HANDLE  = process.env.FED_REPRO_BOT_HANDLE || `repro-bot-${process.pid}`;
const BOT_SECRET  = process.env.FED_REPRO_BOT_SECRET || `repro-bot-secret-${process.pid}`;
// matrix-js-sdk + rust crypto spam stdout heavily during bootstrap.
// Use a separate file for JSON replies so the driver can read them
// without filtering SDK noise.
const REPLY_FILE  = process.env.FED_REPRO_BOT_REPLY_FILE || '/tmp/fed-repro-bot-reply.jsonl';

// Sync append so replies always land on disk even if the process is
// killed. createWriteStream buffers and the buffer doesn't always
// flush on signal-induced exit.
function reply(obj: any) {
  fs.appendFileSync(REPLY_FILE, JSON.stringify(obj) + '\n');
}

async function main() {
  const platform = new MatrixPlatform({
    serverUrl: SERVER_URL,
    serverName: SERVER_NAME,
    botSecretKey: BOT_SECRET,
    botHandle: BOT_HANDLE,
    registrationToken: REG_TOKEN,
  });
  await platform.start();
  reply({ ok: true, started: true, bot_handle: BOT_HANDLE });

  let currentRoom: string | null = null;

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cmd: any;
    try {
      cmd = JSON.parse(trimmed);
    } catch (e: any) {
      reply({ err: `bad json: ${e.message}` });
      continue;
    }
    try {
      switch (cmd.cmd) {
        case 'create-room': {
          // MatrixPlatform.createRoom(name, opts) returns PlatformRoom.
          const room = await platform.createRoom(
            cmd.name || `repro-${Date.now()}`,
            {
              type: 'dm',          // simple direct-style; no space-restricted setup
              encrypted: true,
              topic: 'federation repro',
              invite: cmd.invite || [],
            }
          );
          currentRoom = room.id ?? (room as any).room_id ?? String(room);
          reply({ ok: true, room_id: currentRoom, room_obj: room });
          break;
        }
        case 'invite': {
          if (!currentRoom) throw new Error('no current room');
          await platform.inviteToRoom(currentRoom, cmd.user);
          reply({ ok: true });
          break;
        }
        case 'send': {
          if (!currentRoom) throw new Error('no current room');
          const eid = await platform.sendMessage(currentRoom, cmd.text || '');
          reply({ ok: true, event_id: eid });
          break;
        }
        case 'rotate': {
          if (!currentRoom) throw new Error('no current room');
          const crypto = (platform as any).client?.getCrypto();
          if (!crypto) throw new Error('no crypto');
          await crypto.forceDiscardSession(currentRoom);
          reply({ ok: true, rotated: currentRoom });
          break;
        }
        case 'exit':
          reply({ ok: true, exiting: true });
          await platform.stop();
          process.exit(0);
        default:
          reply({ err: `unknown cmd: ${cmd.cmd}` });
      }
    } catch (e: any) {
      reply({ err: String(e.message || e) });
    }
  }
}

main().catch((e: any) => {
  reply({ err: `fatal: ${e.message || e}` });
  process.exit(1);
});
