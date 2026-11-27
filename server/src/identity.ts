/**
 * Router Identity System
 *
 * Tripcode-style identity: secret_key → pseudonym
 * The secret_key never leaves the client (ideally) or is only used for auth
 * The pseudonym is derived deterministically and stored with entries
 */

import { createHash } from 'crypto';

// Poetic word lists for pseudonym generation
const ADJECTIVES = [
  'Wandering', 'Quiet', 'Gentle', 'Swift', 'Patient',
  'Curious', 'Dreaming', 'Distant', 'Wistful', 'Tender',
  'Luminous', 'Hushed', 'Fleeting', 'Steady', 'Liminal',
  'Ephemeral', 'Veiled', 'Kindred', 'Solitary', 'Resonant',
  'Twilight', 'Amber', 'Silver', 'Mossy', 'Verdant',
  'Coastal', 'Northern', 'Autumn', 'Midnight', 'Morning'
];

const NOUNS = [
  'Iris', 'Ember', 'Echo', 'Sage', 'Moth',
  'Sparrow', 'River', 'Willow', 'Fern', 'Stone',
  'Signal', 'Candle', 'Feather', 'Anchor', 'Compass',
  'Lantern', 'Harbor', 'Meadow', 'Tide', 'Constellation',
  'Archive', 'Threshold', 'Vessel', 'Witness', 'Keeper',
  'Wanderer', 'Listener', 'Scribe', 'Pilgrim', 'Chronicler'
];

/**
 * Generate a deterministic pseudonym from a secret key.
 * The same key always produces the same pseudonym.
 * Includes a tripcode-style hash suffix for uniqueness.
 */
export function derivePseudonym(secretKey: string): string {
  // Hash the secret key
  const hash = createHash('sha256').update(secretKey).digest();

  // Use different parts of the hash for each word selection
  const adjIndex = hash.readUInt16BE(0) % ADJECTIVES.length;
  const nounIndex = hash.readUInt16BE(2) % NOUNS.length;

  // Add tripcode suffix for uniqueness
  const suffix = hash.toString('hex').slice(0, 6);

  return `${ADJECTIVES[adjIndex]} ${NOUNS[nounIndex]}#${suffix}`;
}

/**
 * Generate a short hash suffix for uniqueness verification
 * (like a tripcode, shown as pseudonym#abc123)
 */
export function deriveHashSuffix(secretKey: string): string {
  const hash = createHash('sha256').update(secretKey).digest('hex');
  return hash.slice(0, 6);
}

/**
 * Generate a new random secret key
 */
export function generateSecretKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Validate that a secret key is properly formatted
 */
export function isValidSecretKey(key: string): boolean {
  // Should be a base64url string of appropriate length
  if (typeof key !== 'string') return false;
  if (key.length < 32 || key.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/**
 * Hash a secret key for storage (full SHA-256 hash)
 * Used to look up users by their secret key without storing the key itself
 */
export function hashSecretKey(secretKey: string): string {
  return createHash('sha256').update(secretKey).digest('hex');
}

/**
 * Validate a handle format (Twitter-style)
 * - 3-15 characters
 * - Lowercase alphanumeric and underscores only
 * - Must start with a letter
 */
export function isValidHandle(handle: string): boolean {
  if (typeof handle !== 'string') return false;
  if (handle.length < 3 || handle.length > 15) return false;
  // Must start with letter, then letters/numbers/underscores
  return /^[a-z][a-z0-9_]*$/.test(handle);
}

/**
 * Normalize a handle (lowercase, strip @ if present)
 */
export function normalizeHandle(handle: string): string {
  return handle.toLowerCase().replace(/^@/, '');
}
/**
 * Whether a caller wrote a note. A note with a handle belongs only to the account with that handle. A note with no
 * handle belongs to the key whose derived name matches the note's. Claiming a handle moves the notes with no handle
 * under that key's name to it (see migrateEntriesToHandle); notes that already have a handle keep it.
 */
export function isNoteAuthor(
  note: { handle?: string | null; pseudonym?: string | null },
  caller: { pseudonym?: string | null; handle?: string | null },
): boolean {
  if (note.handle) return !!caller.handle && note.handle === caller.handle;
  return !!caller.pseudonym && note.pseudonym === caller.pseudonym;
}
