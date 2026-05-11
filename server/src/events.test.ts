import { describe, it, expect, beforeEach } from 'vitest';
import { pushEvent, getEventsSince, getLatestCursor, resetEvents } from './events.js';

describe('Event Queue', () => {
  beforeEach(() => {
    resetEvents();
  });

  describe('pushEvent', () => {
    it('should create an event with auto-incrementing ID', () => {
      const e1 = pushEvent('entry_staged', { entry_id: 'abc' });
      const e2 = pushEvent('entry_published', { entry_id: 'def' });

      expect(e1.id).toBe(1);
      expect(e2.id).toBe(2);
    });

    it('should set type, timestamp, and data', () => {
      const e = pushEvent('platform_message', { chat_id: '123', text: 'hello' });

      expect(e.type).toBe('platform_message');
      expect(e.timestamp).toBeGreaterThan(0);
      expect(e.data.chat_id).toBe('123');
      expect(e.data.text).toBe('hello');
    });

    it('should trim events beyond MAX_EVENTS (1000)', () => {
      for (let i = 0; i < 1050; i++) {
        pushEvent('platform_message', { i });
      }

      const all = getEventsSince(0, 2000);
      expect(all.length).toBe(1000);
      // First event should be the 51st one pushed (IDs 1-50 trimmed)
      expect(all[0].id).toBe(51);
    });
  });

  describe('getEventsSince', () => {
    it('should return recent events when cursor is 0', () => {
      for (let i = 0; i < 100; i++) {
        pushEvent('platform_message', { i });
      }

      const events = getEventsSince(0); // default limit 50
      expect(events.length).toBe(50);
      expect(events[0].id).toBe(51); // last 50 of 100
    });

    it('should return events after cursor', () => {
      pushEvent('entry_staged', { entry_id: 'a' });
      pushEvent('entry_staged', { entry_id: 'b' });
      pushEvent('entry_published', { entry_id: 'c' });

      const events = getEventsSince(1);
      expect(events.length).toBe(2);
      expect(events[0].data.entry_id).toBe('b');
      expect(events[1].data.entry_id).toBe('c');
    });

    it('should return empty array when no new events', () => {
      pushEvent('entry_staged', { entry_id: 'a' });
      const events = getEventsSince(1);
      expect(events.length).toBe(0);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        pushEvent('platform_message', { i });
      }

      const events = getEventsSince(0, 3);
      expect(events.length).toBe(3);
    });

    it('should filter by cursor and respect limit', () => {
      for (let i = 0; i < 10; i++) {
        pushEvent('platform_message', { i });
      }

      const events = getEventsSince(5, 2);
      expect(events.length).toBe(2);
      expect(events[0].id).toBe(6);
      expect(events[1].id).toBe(7);
    });
  });

  describe('getLatestCursor', () => {
    it('should return 0 when no events exist', () => {
      expect(getLatestCursor()).toBe(0);
    });

    it('should return the ID of the most recent event', () => {
      pushEvent('entry_staged', { entry_id: 'a' });
      pushEvent('entry_staged', { entry_id: 'b' });
      pushEvent('entry_staged', { entry_id: 'c' });

      expect(getLatestCursor()).toBe(3);
    });
  });

  describe('event types', () => {
    it('should support all event types', () => {
      const types = [
        'entry_staged',
        'entry_published',
        'entry_held',
        'platform_message',
        'platform_mention',
        'platform_onboarding',
      ] as const;

      for (const type of types) {
        const e = pushEvent(type, { test: true });
        expect(e.type).toBe(type);
      }

      expect(getLatestCursor()).toBe(6);
    });
  });
});
