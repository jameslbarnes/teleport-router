import { describe, it, expect } from 'vitest';
import {
  derivePseudonym,
  deriveHashSuffix,
  generateSecretKey,
  isValidSecretKey,
  hashSecretKey,
  isValidHandle,
  normalizeHandle,
  isNoteAuthor,
} from './identity.js';

describe('identity', () => {
  describe('derivePseudonym', () => {
    it('should return a pseudonym in the format "Adjective Noun#hexsuffix"', () => {
      const pseudonym = derivePseudonym('test-secret-key-1234567890abcdef');
      expect(pseudonym).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+#[a-f0-9]{6}$/);
    });

    it('should be deterministic - same key produces same pseudonym', () => {
      const key = 'deterministic-test-key-abcdef123456';
      const pseudonym1 = derivePseudonym(key);
      const pseudonym2 = derivePseudonym(key);
      expect(pseudonym1).toBe(pseudonym2);
    });

    it('should produce different pseudonyms for different keys', () => {
      const pseudonym1 = derivePseudonym('key-one-abcdefghijklmnop');
      const pseudonym2 = derivePseudonym('key-two-abcdefghijklmnop');
      expect(pseudonym1).not.toBe(pseudonym2);
    });
  });

  describe('deriveHashSuffix', () => {
    it('should return a 6-character hex string', () => {
      const suffix = deriveHashSuffix('test-key-1234567890');
      expect(suffix).toMatch(/^[a-f0-9]{6}$/);
    });

    it('should be deterministic', () => {
      const key = 'suffix-test-key';
      expect(deriveHashSuffix(key)).toBe(deriveHashSuffix(key));
    });
  });

  describe('generateSecretKey', () => {
    it('should return a base64url string', () => {
      const key = generateSecretKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate unique keys', () => {
      const key1 = generateSecretKey();
      const key2 = generateSecretKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate keys that pass validation', () => {
      const key = generateSecretKey();
      expect(isValidSecretKey(key)).toBe(true);
    });
  });

  describe('isValidSecretKey', () => {
    it('should accept valid base64url strings of appropriate length', () => {
      expect(isValidSecretKey('abcdefghijklmnopqrstuvwxyz123456')).toBe(true); // 32 chars
      expect(isValidSecretKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe(true); // 32 chars
      expect(isValidSecretKey('abc_def-ghi_jkl-mno_pqr-stu_vwxy')).toBe(true); // 32 chars with _ and -
    });

    it('should reject strings that are too short', () => {
      expect(isValidSecretKey('short')).toBe(false);
      expect(isValidSecretKey('1234567890123456789012345678901')).toBe(false); // 31 chars
    });

    it('should reject strings that are too long', () => {
      expect(isValidSecretKey('a'.repeat(65))).toBe(false);
    });

    it('should reject non-base64url characters', () => {
      expect(isValidSecretKey('abcdefghijklmnopqrstuvwxyz12345!')).toBe(false);
      expect(isValidSecretKey('abcdefghijklmnopqrstuvwxyz12345=')).toBe(false);
      expect(isValidSecretKey('abcdefghijklmnopqrstuvwxyz 12345')).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidSecretKey(null as any)).toBe(false);
      expect(isValidSecretKey(undefined as any)).toBe(false);
      expect(isValidSecretKey(12345 as any)).toBe(false);
    });
  });

  describe('hashSecretKey', () => {
    it('should return a 64-character hex string (SHA-256)', () => {
      const hash = hashSecretKey('test-key-for-hashing');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be deterministic', () => {
      const key = 'hash-test-key';
      expect(hashSecretKey(key)).toBe(hashSecretKey(key));
    });

    it('should produce different hashes for different keys', () => {
      expect(hashSecretKey('key-one')).not.toBe(hashSecretKey('key-two'));
    });
  });

  describe('isValidHandle', () => {
    it('should accept valid handles (3-15 lowercase alphanumeric + underscore)', () => {
      expect(isValidHandle('james')).toBe(true);
      expect(isValidHandle('james123')).toBe(true);
      expect(isValidHandle('james_doe')).toBe(true);
      expect(isValidHandle('abc')).toBe(true); // minimum length
      expect(isValidHandle('abcdefghijklmno')).toBe(true); // maximum length (15)
    });

    it('should require handles to start with a letter', () => {
      expect(isValidHandle('1james')).toBe(false);
      expect(isValidHandle('_james')).toBe(false);
      expect(isValidHandle('123')).toBe(false);
    });

    it('should reject handles that are too short', () => {
      expect(isValidHandle('ab')).toBe(false);
      expect(isValidHandle('a')).toBe(false);
      expect(isValidHandle('')).toBe(false);
    });

    it('should reject handles that are too long', () => {
      expect(isValidHandle('abcdefghijklmnop')).toBe(false); // 16 chars
      expect(isValidHandle('a'.repeat(20))).toBe(false);
    });

    it('should reject uppercase letters', () => {
      expect(isValidHandle('James')).toBe(false);
      expect(isValidHandle('JAMES')).toBe(false);
      expect(isValidHandle('jAmEs')).toBe(false);
    });

    it('should reject special characters', () => {
      expect(isValidHandle('james!')).toBe(false);
      expect(isValidHandle('james-doe')).toBe(false);
      expect(isValidHandle('james.doe')).toBe(false);
      expect(isValidHandle('james@doe')).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidHandle(null as any)).toBe(false);
      expect(isValidHandle(undefined as any)).toBe(false);
      expect(isValidHandle(12345 as any)).toBe(false);
    });
  });

  describe('normalizeHandle', () => {
    it('should convert to lowercase', () => {
      expect(normalizeHandle('James')).toBe('james');
      expect(normalizeHandle('JAMES')).toBe('james');
      expect(normalizeHandle('JaMeS')).toBe('james');
    });

    it('should strip @ prefix', () => {
      expect(normalizeHandle('@james')).toBe('james');
      expect(normalizeHandle('@JAMES')).toBe('james');
    });

    it('should handle already normalized handles', () => {
      expect(normalizeHandle('james')).toBe('james');
    });

    it('should only strip leading @', () => {
      expect(normalizeHandle('james@doe')).toBe('james@doe');
      expect(normalizeHandle('@@james')).toBe('@james');
    });
  });
});

describe('isNoteAuthor', () => {
  const name = 'Quiet Feather#79c30b';
  it("gives a note with a handle to that handle's account only, whatever name the caller's key has", () => {
    const note = { handle: 'alice', pseudonym: name };
    expect(isNoteAuthor(note, { handle: 'alice', pseudonym: name })).toBe(true);
    expect(isNoteAuthor(note, { handle: 'alice', pseudonym: 'Other Name#000000' })).toBe(true);
    expect(isNoteAuthor(note, { handle: 'bob', pseudonym: name })).toBe(false);
    expect(isNoteAuthor(note, { handle: null, pseudonym: name })).toBe(false);
    expect(isNoteAuthor(note, { pseudonym: name })).toBe(false);
  });
  it('gives a note with no handle to the key whose derived name matches it', () => {
    const note = { pseudonym: name };
    expect(isNoteAuthor(note, { pseudonym: name })).toBe(true);
    expect(isNoteAuthor(note, { handle: 'alice', pseudonym: name })).toBe(true);
    expect(isNoteAuthor(note, { handle: 'alice', pseudonym: 'Other Name#000000' })).toBe(false);
    expect(isNoteAuthor({ pseudonym: undefined }, { pseudonym: undefined, handle: undefined })).toBe(false);
  });
});
