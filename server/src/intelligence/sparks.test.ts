import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectSparks,
  evaluateSpark,
  formatEntryForSparkEvaluation,
  getConnectionInfo,
  SPARK_COPY_MODEL,
  SPARK_EVALUATION_MODEL,
} from './sparks.js';
import { MemoryStorage } from '../storage.js';
import type { JournalEntry } from '../storage.js';

describe('detectSparks', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('does not turn private group writing into public connection suggestions',async()=>{
    const bob=await storage.addEntry({handle:'bob',pseudonym:'bob',client:'code',content:'secret attestation',
      keywords:['attestation'],timestamp:Date.now(),to:['#private']});
    const alice=await storage.addEntry({handle:'alice',pseudonym:'alice',client:'code',content:'public attestation',
      keywords:['attestation'],timestamp:Date.now()});
    expect(await detectSparks(alice,storage)).toEqual([]);
    expect(await detectSparks(bob,storage)).toEqual([]);
  });

  it('returns empty array when source entry has no handle', async () => {
    const entry: JournalEntry = {
      id: '1',
      pseudonym: 'Anon#abc',
      client: 'desktop',
      content: 'test',
      timestamp: Date.now(),
    };
    const sparks = await detectSparks(entry, storage);
    expect(sparks).toEqual([]);
  });

  it('returns empty when no search terms available', async () => {
    const entry: JournalEntry = {
      id: '1',
      handle: 'alice',
      pseudonym: 'Alice#abc',
      client: 'desktop',
      content: 'test',
      timestamp: Date.now(),
    };
    const sparks = await detectSparks(entry, storage);
    expect(sparks).toEqual([]);
  });

  it('finds candidates with overlapping topics', async () => {
    // Bob writes about TEE attestation
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-bob' });
    await storage.addEntry({
      handle: 'bob',
      pseudonym: 'Bob#001',
      client: 'desktop',
      content: 'Working on TEE attestation and enclave key rotation patterns for ML model signing.',
      timestamp: Date.now() - 1000,
      keywords: ['tee', 'attestation', 'enclave', 'ml'],
      topicHints: ['tee-attestation'],
    });

    // Alice writes about the same topic
    const aliceEntry = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'Exploring TEE attestation for ML provenance.',
      timestamp: Date.now(),
      keywords: ['tee', 'attestation', 'provenance'],
      topicHints: ['tee-attestation'],
    });

    const sparks = await detectSparks(aliceEntry, storage);
    expect(sparks.length).toBeGreaterThan(0);
    expect(sparks.map(s => s.handle)).toContain('bob');
  });

  it('excludes the source author from candidates', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-alice' });

    const entry1 = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'First entry about TEE.',
      timestamp: Date.now() - 1000,
      keywords: ['tee'],
    });

    const entry2 = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'Second entry about TEE.',
      timestamp: Date.now(),
      keywords: ['tee'],
      topicHints: ['tee'],
    });

    const sparks = await detectSparks(entry2, storage);
    expect(sparks.every(s => s.handle !== 'alice')).toBe(true);
  });

  it('includes AI-only entries in spark candidates', async () => {
    await storage.addEntry({
      handle: 'bob',
      pseudonym: 'Bob#001',
      client: 'desktop',
      content: 'AI-only entry about TEE.',
      timestamp: Date.now() - 1000,
      keywords: ['tee'],
      topicHints: ['tee'],
      aiOnly: true,
    });

    const aliceEntry = await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#002',
      client: 'desktop',
      content: 'Public entry about TEE.',
      timestamp: Date.now(),
      keywords: ['tee'],
      topicHints: ['tee'],
    });

    const sparks = await detectSparks(aliceEntry, storage);
    expect(sparks.map(s => s.handle)).toContain('bob');
  });

  it('uses AI-only content for evaluation when present', () => {
    const summary = formatEntryForSparkEvaluation({
      id: '1',
      handle: 'bob',
      pseudonym: 'Bob#001',
      client: 'desktop',
      content: 'AI-only entry about TEE attestation and model verification.',
      timestamp: Date.now(),
      aiOnly: true,
      topicHints: ['TEE'],
      keywords: ['attestation'],
    });

    expect(summary).toContain('AI-only entry about TEE attestation');
    expect(summary).not.toContain('[AI-only entry] Topics:');
  });

  it('falls back to AI-only topics when content is empty', () => {
    const summary = formatEntryForSparkEvaluation({
      id: '1',
      handle: 'bob',
      pseudonym: 'Bob#001',
      client: 'desktop',
      content: '',
      timestamp: Date.now(),
      aiOnly: true,
      topicHints: ['TEE', 'attestation'],
      keywords: ['verifier'],
    });

    expect(summary).toContain('[AI-only entry] Topics:');
    expect(summary).toContain('TEE');
  });
});

describe('getConnectionInfo', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('returns not-connected for users with no relationship', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(false);
    expect(info.sharedRoomIds).toEqual([]);
  });

  it('does not treat shared channel membership as an existing spark room', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });
    await storage.createChannel({
      id: 'tees',
      name: 'TEEs',
      visibility: 'public',
      createdBy: 'alice',
      createdAt: Date.now(),
      skills: [],
      subscribers: [],
    } as any);
    await storage.addSubscriber('tees', 'alice', 'admin');
    await storage.addSubscriber('tees', 'bob', 'member');

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(false);
    expect(info.sharedRoomIds).toEqual([]);
  });

  it('detects connection when users already have a spark pair room', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });
    await storage.setSparkPairRoom('alice', 'bob', '!pair-room:example.test');

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(true);
    expect(info.sharedRoomIds).toEqual(['!pair-room:example.test']);
    await expect(storage.getSparkPairRoom('bob', 'alice')).resolves.toBe('!pair-room:example.test');
  });

  it('detects connection via mutual follows', async () => {
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-a',
      following: [{ handle: 'bob', note: 'works on TEE' }],
    });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(true);
  });

  it('detects connection via addressed entries', async () => {
    await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-a' });
    await storage.createUser({ handle: 'bob', secretKeyHash: 'hash-b' });
    await storage.addEntry({
      handle: 'alice',
      pseudonym: 'Alice#abc',
      client: 'desktop',
      content: 'Message for bob',
      timestamp: Date.now(),
      to: ['@bob'],
    });

    const info = await getConnectionInfo('alice', 'bob', [], storage);
    expect(info.isConnected).toBe(true);
  });
});

describe('evaluateSpark', () => {
  const sourceEntry: JournalEntry = {
    id: 'source-1',
    handle: 'alice',
    pseudonym: 'Alice#002',
    client: 'desktop',
    content: 'I am debugging TEE-backed routing verification so silent model mismatches are caught before users rely on the answer.',
    timestamp: Date.now(),
  };

  const candidate = {
    handle: 'bob',
    matchingEntries: [
      {
        id: 'target-1',
        handle: 'bob',
        pseudonym: 'Bob#001',
        client: 'desktop' as const,
        content: 'Built an attestation chain that caught a live model-routing mismatch in production.',
        timestamp: Date.now() - 1000,
      },
    ],
    overlapTopics: ['tee', 'model routing'],
  };

  it('uses Haiku to evaluate and Opus to write surfaced spark copy', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: '{"confidence":"high","reason":"Alice and Bob are both working on TEE-backed model routing verification."}' },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: '{"topic":"TEE-backed model routing verification overlap","message":"Hey @alice and @bob, you are both working on catching model-routing mismatches with attestation. Worth comparing notes."}' },
        ],
      });
    const anthropic = { messages: { create } };

    const action = await evaluateSpark(
      sourceEntry,
      candidate,
      { handle: 'bob', sharedRoomIds: [], recentInteractions: 0, isConnected: false },
      anthropic as any,
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].model).toBe(SPARK_EVALUATION_MODEL);
    expect(create.mock.calls[1][0].model).toBe(SPARK_COPY_MODEL);
    expect(action).toMatchObject({
      action: 'introduce',
      confidence: 'high',
      sourceHandle: 'alice',
      targetHandle: 'bob',
      reason: 'TEE-backed model routing verification overlap',
      message: 'Hey @alice and @bob, you are both working on catching model-routing mismatches with attestation. Worth comparing notes.',
    });
  });

  it('does not call Opus when Haiku skips the spark', async () => {
    const create = vi.fn().mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"confidence":"skip","reason":"The overlap is only keyword-level."}' },
      ],
    });
    const anthropic = { messages: { create } };

    const action = await evaluateSpark(
      sourceEntry,
      candidate,
      { handle: 'bob', sharedRoomIds: [], recentInteractions: 0, isConnected: false },
      anthropic as any,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe(SPARK_EVALUATION_MODEL);
    expect(action).toMatchObject({
      action: 'skip',
      confidence: 'skip',
      reason: 'The overlap is only keyword-level.',
    });
  });
});
