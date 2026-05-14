import { describe, it, expect } from 'vitest';
import { AdaptiveCooldown } from './classifier.js';

// ─── AdaptiveCooldown tests ─────────────────────────────────────────────────

describe('AdaptiveCooldown', () => {
  it('starts with zero chattiness', () => {
    const cd = new AdaptiveCooldown();
    expect(cd.getChattiness()).toBeCloseTo(0, 5);
  });

  it('returns base threshold when silent', () => {
    const cd = new AdaptiveCooldown();
    // Base threshold is 0.3
    expect(cd.getThreshold()).toBeCloseTo(0.3, 2);
  });

  it('increases threshold after speaking', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    cd.recordSpeak(now);
    // Just spoke: chattiness ≈ 1.0, threshold ≈ 0.3 + 0.25 * 1.0 = 0.55
    expect(cd.getThreshold(now)).toBeCloseTo(0.55, 1);
  });

  it('stacks chattiness from multiple recent speaks', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    cd.recordSpeak(now - 60_000); // 1 min ago
    cd.recordSpeak(now - 30_000); // 30 sec ago
    cd.recordSpeak(now);          // just now
    // All three are very recent, chattiness ≈ 3.0
    const chattiness = cd.getChattiness(now);
    expect(chattiness).toBeGreaterThan(2.5);
    // Threshold should be near max (0.90)
    expect(cd.getThreshold(now)).toBeGreaterThan(0.85);
  });

  it('decays chattiness with half-life of 30 minutes', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    cd.recordSpeak(now);
    // At 30 min later: chattiness should be ~0.5
    const halfLife = 30 * 60 * 1000;
    const chatAt30 = cd.getChattiness(now + halfLife);
    expect(chatAt30).toBeCloseTo(0.5, 1);
    // At 60 min later: chattiness should be ~0.25
    const chatAt60 = cd.getChattiness(now + 2 * halfLife);
    expect(chatAt60).toBeCloseTo(0.25, 1);
  });

  it('threshold drops back to base after long silence', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    cd.recordSpeak(now);
    // 2 hours later: chattiness ≈ 0.06, threshold ≈ 0.31
    const twoHoursLater = now + 2 * 60 * 60 * 1000;
    expect(cd.getThreshold(twoHoursLater)).toBeCloseTo(0.3, 1);
  });

  it('caps threshold at 0.90', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    // Speak 10 times in rapid succession
    for (let i = 0; i < 10; i++) {
      cd.recordSpeak(now - i * 1000);
    }
    expect(cd.getThreshold(now)).toBe(0.90);
  });

  it('timeSinceLastSpeak returns Infinity when never spoken', () => {
    const cd = new AdaptiveCooldown();
    expect(cd.timeSinceLastSpeak()).toBe(Infinity);
  });

  it('timeSinceLastSpeak returns correct duration', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    cd.recordSpeak(now - 5000);
    expect(cd.timeSinceLastSpeak(now)).toBe(5000);
  });

  it('persists and restores state', () => {
    const cd1 = new AdaptiveCooldown();
    const now = Date.now();
    cd1.recordSpeak(now - 60_000);
    cd1.recordSpeak(now);

    const timestamps = cd1.getTimestamps();
    expect(timestamps).toHaveLength(2);

    const cd2 = new AdaptiveCooldown();
    cd2.restore(timestamps);
    expect(cd2.getChattiness(now)).toBeCloseTo(cd1.getChattiness(now), 5);
  });

  it('prunes timestamps older than 24 hours on restore', () => {
    const cd = new AdaptiveCooldown();
    const now = Date.now();
    const old = [
      now - 25 * 60 * 60 * 1000, // 25 hours ago — should be pruned
      now - 1000,                  // 1 second ago — should be kept
    ];
    cd.restore(old);
    expect(cd.getTimestamps()).toHaveLength(1);
  });
});
