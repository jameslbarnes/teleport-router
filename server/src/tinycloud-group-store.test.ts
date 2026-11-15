import { describe, it, expect } from 'vitest';
import { sessionExpiryFor } from './tinycloud-group-store.js';

describe('the session the Router asks for under a grant', () => {
  it('ends at the grant’s expiry rounded down to the whole second, never after it', () => {
    const grant = new Date('2027-11-15T23:12:08.053Z');
    const session = sessionExpiryFor(grant)!;
    expect(session.toISOString()).toBe('2027-11-15T23:12:08.000Z');
    expect(session.getTime()).toBeLessThanOrEqual(grant.getTime());
    expect(session.getTime() % 1000).toBe(0);
  });

  it('leaves a grant already held to the second unchanged', () => {
    expect(sessionExpiryFor(new Date('2027-01-01T00:00:00.000Z'))!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('accepts the expiry as text, and passes over a missing or unreadable one', () => {
    expect(sessionExpiryFor('2027-11-15T23:12:08.999Z')!.toISOString()).toBe('2027-11-15T23:12:08.000Z');
    expect(sessionExpiryFor(undefined)).toBeUndefined();
    expect(sessionExpiryFor('not a date')).toBeUndefined();
  });
});
