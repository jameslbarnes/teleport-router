/**
 * Browser-to-local-agent pairing for trace-app approvals.
 *
 * The local agent generates a fresh secp256k1 keypair on the user's machine and starts a 10-minute
 * pairing session with its public key. The user opens the pairing URL in their signed-in browser
 * (where OpenKey or their browser-saved recovery backup lives), reviews the verification code and
 * scope (get-only on router/traces/), and clicks Allow. The browser mints a scoped TinyCloud
 * delegation for the agent key, seals the handoff payload to the agent's public key, and posts only
 * ciphertext to Router. The agent picks it up once and decrypts it locally. Router never sees the
 * delegation or trace key.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { computeAddress, SigningKey } from 'ethers';
import type { User } from './storage.js';

export const PAIR_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
const MAX_SEALED_BYTES = 120 * 1024;

export class TraceAgentPairError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface SealedPairPayload {
  ephemeralPublicKey: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface PairRecord {
  token: string;
  pairId: string;
  ownerKeyHash: string;
  handle: string;
  agentPublicKey: string;
  agentDid: string;
  verifyCode: string;
  createdAt: number;
  expiresAt: number;
  status: 'waiting' | 'completed';
  sealed?: SealedPairPayload;
}

interface Actor { keyHash: string; user: User | null }

function checkedCompressedKey(key: unknown): string {
  if (typeof key !== 'string' || !/^0x(?:02|03)[0-9a-fA-F]{64}$/.test(key)) {
    throw new TraceAgentPairError('agent_public_key must be a compressed secp256k1 public key (0x02 or 0x03 + 64 hex chars).');
  }
  try { return SigningKey.computePublicKey(key, true); }
  catch { throw new TraceAgentPairError('Invalid agent_public_key.'); }
}

function checkedToken(token: unknown): string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    throw new TraceAgentPairError('Invalid pairing token.', 404);
  }
  return token;
}

function checkedSealed(value: unknown): SealedPairPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TraceAgentPairError('Invalid sealed pairing payload.');
  const v = value as Record<string, unknown>;
  const b64 = (s: unknown, exactBytes?: number) => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
    const buf = Buffer.from(s, 'base64url');
    if (buf.toString('base64url') !== s) return false;
    if (exactBytes !== undefined && buf.length !== exactBytes) return false;
    return true;
  };
  const ephemeralPublicKey = checkedCompressedKey(v.ephemeralPublicKey);
  if (!b64(v.nonce, 12) || !b64(v.tag, 16) || !b64(v.ciphertext) || String(v.ciphertext).length > MAX_SEALED_BYTES) {
    throw new TraceAgentPairError('Invalid sealed pairing payload.');
  }
  return { ephemeralPublicKey, nonce: v.nonce as string, tag: v.tag as string, ciphertext: v.ciphertext as string };
}

export function verifyCodeFor(publicKey: string): string {
  const hex = createHash('sha256').update(publicKey.toLowerCase(), 'utf8').digest('hex').slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export function traceAgentPairStore() {
  const records = new Map<string, PairRecord>();
  const sweep = (now: number) => {
    for (const [k, r] of records) if (r.expiresAt <= now) records.delete(k);
  };
  return {
    put(record: PairRecord, now: number) {
      sweep(now);
      if (records.size >= MAX_PENDING) {
        const oldest = records.keys().next().value;
        if (oldest) records.delete(oldest);
      }
      records.set(record.token, record);
    },
    get(token: string, now: number): PairRecord | undefined {
      sweep(now);
      const r = records.get(token);
      if (!r || r.expiresAt <= now) { records.delete(token); return undefined; }
      return r;
    },
    delete(token: string) { records.delete(token); },
  };
}

export function traceAgentPairing({
  store, baseUrl, host, now = Date.now,
}: {
  store: ReturnType<typeof traceAgentPairStore>;
  baseUrl: string;
  host: string;
  now?: () => number;
}) {
  const origin = baseUrl.replace(/\/+$/, '');

  function requireLinkedUser(actor: Actor): User & { tinycloud: NonNullable<User['tinycloud']> } {
    const user = actor.user;
    if (!user?.handle) throw new TraceAgentPairError('Claim a Router handle before authorizing a trace agent.', 401);
    if (!user.tinycloud?.space || !user.tinycloud?.ownerDid) {
      throw new TraceAgentPairError('Link your encrypted storage at /group-setup before authorizing a trace agent.', 409);
    }
    return user as User & { tinycloud: NonNullable<User['tinycloud']> };
  }

  return {
    start(actor: Actor, input: Record<string, unknown>) {
      const user = requireLinkedUser(actor);
      const agentPublicKey = checkedCompressedKey(input.agent_public_key);
      const agentDid = 'did:pkh:eip155:1:' + computeAddress(agentPublicKey);
      const token = randomBytes(32).toString('base64url');
      const pairId = randomUUID();
      const verifyCode = verifyCodeFor(agentPublicKey);
      const createdAt = now();
      const expiresAt = createdAt + PAIR_TTL_MS;
      store.put({
        token, pairId, ownerKeyHash: actor.keyHash, handle: user.handle,
        agentPublicKey, agentDid, verifyCode, createdAt, expiresAt, status: 'waiting',
      }, createdAt);
      return {
        pair_id: pairId,
        pair_token: token,
        url: `${origin}/trace-access#pair=${token}`,
        verify_code: verifyCode,
        agent_did: agentDid,
        owner_did: user.tinycloud.ownerDid,
        expires_at: expiresAt,
      };
    },

    info(actor: Actor, input: Record<string, unknown>) {
      const user = requireLinkedUser(actor);
      const token = checkedToken(input.token);
      const r = store.get(token, now());
      if (!r || r.ownerKeyHash !== actor.keyHash) throw new TraceAgentPairError('This authorization link expired or belongs to another account.', 404);
      const tc = user.tinycloud;
      return {
        pair_id: r.pairId,
        status: r.status,
        handle: r.handle,
        agent_did: r.agentDid,
        agent_public_key: r.agentPublicKey,
        verify_code: r.verifyCode,
        expires_at: r.expiresAt,
        storage: {
          host,
          space: tc.space,
          owner_did: tc.ownerDid,
          owner_public_key: tc.ownerPublicKey || null,
          mode: tc.networkRecovery ? 'openkey' : 'recovery',
        },
      };
    },

    complete(actor: Actor, input: Record<string, unknown>) {
      requireLinkedUser(actor);
      const token = checkedToken(input.token);
      const r = store.get(token, now());
      if (!r || r.ownerKeyHash !== actor.keyHash) throw new TraceAgentPairError('This authorization link expired or belongs to another account.', 404);
      if (r.status !== 'waiting') throw new TraceAgentPairError('This authorization link was already used.', 409);
      r.sealed = checkedSealed(input.sealed);
      r.status = 'completed';
      return { status: 'completed', pair_id: r.pairId };
    },

    poll(actor: Actor, input: Record<string, unknown>) {
      const token = checkedToken(input.token ?? input.pair_token);
      const r = store.get(token, now());
      if (!r || r.ownerKeyHash !== actor.keyHash) throw new TraceAgentPairError('This authorization session expired or was already collected.', 404);
      if (r.status === 'waiting' || !r.sealed) {
        return { status: 'waiting', pair_id: r.pairId, expires_at: r.expiresAt };
      }
      // One-time pickup: remove the sealed payload from Router as soon as the agent retrieves it.
      store.delete(token);
      return { status: 'completed', pair_id: r.pairId, sealed: r.sealed };
    },
  };
}
