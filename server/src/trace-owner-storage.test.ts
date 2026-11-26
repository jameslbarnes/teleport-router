import { describe, it, expect } from 'vitest';
// The owner tool's helper is plain JavaScript beside it.
// @ts-ignore
import { traceRecordState } from '../scripts/trace-owner-storage.mjs';

const KEY = 'router/traces/a-note/meta';
const error = (code: string, message: string) => ({ ok: false, error: { code, message, service: 'kv' } });

describe('what the owner tool takes from its own storage before uploading a trace', () => {
  it('takes only the storage SDK\'s exact answer for a missing key as "no trace stored"', () => {
    expect(traceRecordState(error('KV_NOT_FOUND', `Key not found: ${KEY}`), KEY)).toBe('none');
  });

  it('treats a stored record as stored', () => {
    expect(traceRecordState({ ok: true, data: { data: '{"v":1}' } }, KEY)).toBe('stored');
    expect(traceRecordState({ ok: true, data: { data: { v: 1 } } }, KEY)).toBe('stored');
  });

  it('does not know, and so uploads nothing, on an empty success', () => {
    for (const got of [{ ok: true }, { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: { data: null } }, { ok: true, data: { data: '' } }])
      expect(traceRecordState(got, KEY)).toBe('unknown');
  });

  it('does not know on other errors, even ones that say "not found"', () => {
    for (const got of [
      error('KV_NOT_FOUND', 'KV 404 - Space not found'),
      error('KV_NOT_FOUND', 'Key not found: router/traces/another-note/meta'),
      error('NOT_FOUND', `Key not found: ${KEY}`),
      error('SPACE_NOT_FOUND', 'not found'),
      error('NETWORK_ERROR', 'upstream said: record not found'),
      error('AUTH_UNAUTHORIZED', 'Failed to get key'),
      null, undefined, {}, { ok: false },
    ]) expect(traceRecordState(got, KEY)).toBe('unknown');
  });
});
