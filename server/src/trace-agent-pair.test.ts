import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { traceAgentPairing, traceAgentPairStore, TraceAgentPairError } from './trace-agent-pair.js';
import type { User } from './storage.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    handle: 'alice',
    createdAt: 1,
    tinycloud: {
      ownerDid: 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111',
      space: 'urn:tinycloud:space:eip155:1:0x1111111111111111111111111111111111111111:router',
      ownerPublicKey: Wallet.createRandom().signingKey.compressedPublicKey,
      linkedAt: 1,
    } as any,
    ...overrides,
  } as User;
}

describe('traceAgentPairing', () => {
  it('completes a one-time pairing for the same account and rejects other accounts', () => {
    let now = 1_000_000;
    const pairing = traceAgentPairing({
      store: traceAgentPairStore(),
      baseUrl: 'https://router.teleport.computer',
      host: 'https://tee.node.tinycloud.xyz',
      now: () => now,
    });
    const alice = { keyHash: 'hash-alice', user: makeUser() };
    const bob = { keyHash: 'hash-bob', user: makeUser({ handle: 'bob' }) };
    const agent = Wallet.createRandom();

    expect(() => pairing.start(alice, { agent_public_key: agent.signingKey.compressedPublicKey })).toThrow(/Update/);
    const started = pairing.start(alice, { key_version: 2, agent_public_key: agent.signingKey.compressedPublicKey });
    expect(started.url).toBe(`https://router.teleport.computer/trace-access#pair=${started.pair_token}`);
    expect(started.verify_code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

    // Bob cannot view, complete, or poll Alice's pairing session.
    expect(() => pairing.info(bob, { key_version: 2, token: started.pair_token })).toThrow(TraceAgentPairError);
    expect(() => pairing.poll(bob, { token: started.pair_token })).toThrow(TraceAgentPairError);

    const info = pairing.info(alice, { key_version: 2, token: started.pair_token });
    expect(() => pairing.info(alice, { token: started.pair_token })).toThrow(/Update/);
    expect(() => pairing.complete(alice, { token: started.pair_token })).toThrow(/Update/);
    expect(info.key_version).toBe(2);
    expect(info.handle).toBe('alice');
    expect(info.storage.mode).toBe('recovery');
    expect(info.verify_code).toBe(started.verify_code);

    expect(pairing.poll(alice, { token: started.pair_token }).status).toBe('waiting');

    const sealed = {
      ephemeralPublicKey: Wallet.createRandom().signingKey.compressedPublicKey,
      nonce: Buffer.alloc(12, 1).toString('base64url'),
      tag: Buffer.alloc(16, 2).toString('base64url'),
      ciphertext: Buffer.from('opaque-ciphertext').toString('base64url'),
    };
    expect(pairing.complete(alice, { key_version: 2, token: started.pair_token, sealed }).status).toBe('completed');
    // Cannot complete twice.
    expect(() => pairing.complete(alice, { key_version: 2, token: started.pair_token, sealed })).toThrow(/already used/);

    // First poll returns sealed payload and deletes it; second poll gets 404.
    const picked = pairing.poll(alice, { token: started.pair_token });
    expect(picked.status).toBe('completed');
    expect(picked.sealed).toEqual(sealed);
    expect(() => pairing.poll(alice, { token: started.pair_token })).toThrow(TraceAgentPairError);
  });

  it('expires pairings after 10 minutes and rejects unlinked accounts', () => {
    let now = 5_000_000;
    const pairing = traceAgentPairing({
      store: traceAgentPairStore(),
      baseUrl: 'https://router.teleport.computer',
      host: 'https://tee.node.tinycloud.xyz',
      now: () => now,
    });
    const unlinked = { keyHash: 'hash-u', user: makeUser({ tinycloud: undefined }) };
    const agent = Wallet.createRandom();
    expect(() => pairing.start(unlinked, { key_version: 2, agent_public_key: agent.signingKey.compressedPublicKey })).toThrow(/Link your encrypted storage/);

    const alice = { keyHash: 'hash-alice', user: makeUser() };
    const started = pairing.start(alice, { key_version: 2, agent_public_key: agent.signingKey.compressedPublicKey });
    now += 10 * 60_000 + 1;
    expect(() => pairing.info(alice, { key_version: 2, token: started.pair_token })).toThrow(TraceAgentPairError);
    expect(() => pairing.poll(alice, { token: started.pair_token })).toThrow(TraceAgentPairError);
  });

  it('reports openkey mode when networkRecovery is present', () => {
    const pairing = traceAgentPairing({
      store: traceAgentPairStore(),
      baseUrl: 'https://router.teleport.computer',
      host: 'https://tee.node.tinycloud.xyz',
    });
    const okUser = makeUser({ tinycloud: { ...makeUser().tinycloud!, networkRecovery: { publicKey: '0x02' + '11'.repeat(32) } } as any });
    const actor = { keyHash: 'hash-alice', user: okUser };
    const started = pairing.start(actor, { key_version: 2, agent_public_key: Wallet.createRandom().signingKey.compressedPublicKey });
    const info = pairing.info(actor, { key_version: 2, token: started.pair_token });
    expect(info.storage.mode).toBe('openkey');
    expect(info.storage.owner_public_key).toBe(okUser.tinycloud!.networkRecovery!.publicKey);
  });
});
