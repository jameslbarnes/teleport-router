import { describe, it, expect } from 'vitest';
import { MemoryStorage } from './storage.js';
import { parsePostingRules, nextPostingRules, resolvePostingAudience, renderPostingRules, type PostingRulesDraft } from './posting-rules.js';

const draft: PostingRulesDraft = { mode: 'review', audience: 'public', destinations: [], purpose: 'Find useful ideas.', share: 'My experiments', avoid: 'Client work', style: 'Plain words', instructions: '  Keep my punctuation — and spacing.\n' };

describe('Personal posting rules', () => {
  it('keeps own-word instructions exactly and validates audience choices', () => {
    expect(parsePostingRules(draft).instructions).toBe(draft.instructions);
    for (const patch of [{ mode: 'passive' }, { audience: 'selected' }, { destinations: ['https://example.com/hook'] }, { unexpected: true }, { instructions: 'x'.repeat(4001) }]) {
      expect(() => parsePostingRules({ ...draft, ...patch })).toThrow();
    }
  });

  it('rejects concurrent stale saves without losing unrelated account settings', async () => {
    const store = new MemoryStorage();
    await store.createUser({ handle: 'person', secretKeyHash: 'test', bio: 'Keep this too.' });
    const results = await Promise.allSettled([
      store.savePostingRules('person', draft, 0),
      store.savePostingRules('person', { ...draft, mode: 'manual' }, 0),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const user = await store.getUser('person');
    expect(user?.bio).toBe('Keep this too.');
    expect(user?.postingRules?.revision).toBe(1);
    expect(user?.postingRules?.instructions).toBe(draft.instructions);
    await expect(store.savePostingRules('person', draft, NaN)).rejects.toThrow('expected_revision');
  });

  it('blocks undeclared automatic posts in review and manual modes', () => {
    for (const mode of ['review', 'manual'] as const) {
      const rules = nextPostingRules(undefined, { ...draft, mode }, 0);
      expect(() => resolvePostingAudience(rules, undefined, [])).toThrow();
      expect(() => resolvePostingAudience(rules, 'automatic', [])).toThrow();
      expect(resolvePostingAudience(rules, 'user-requested', [])).toEqual([]);
      expect(resolvePostingAudience(rules, 'user-approved', [])).toEqual([]);
      expect(renderPostingRules(rules)).toContain(draft.instructions);
    }
  });

  it('does not silently broaden a selected audience or infer an ask-each-time audience', () => {
    const rules = nextPostingRules(undefined, { ...draft, mode: 'automatic', audience: 'selected', destinations: ['#books'] }, 0);
    expect(resolvePostingAudience(rules, undefined, undefined)).toEqual(['#books']);
    expect(() => resolvePostingAudience(rules, undefined, [])).toThrow('outside');
    expect(() => resolvePostingAudience(rules, undefined, ['#other'])).toThrow('outside');
    expect(resolvePostingAudience(rules, 'user-requested', [])).toEqual([]);
    const ask = nextPostingRules(undefined, { ...draft, audience: 'ask' }, 0);
    expect(() => resolvePostingAudience(ask, 'user-approved', undefined)).toThrow('audience');
    expect(resolvePostingAudience(ask, 'user-approved', [])).toEqual([]);
  });

  it('preserves legacy writes until a person chooses rules', () => {
    expect(resolvePostingAudience(undefined, undefined, undefined)).toBeUndefined();
    expect(resolvePostingAudience(undefined, undefined, ['@reader'])).toEqual(['@reader']);
  });
});
