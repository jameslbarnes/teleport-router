// The server's identity module, with one change for tests: the keys in ROUTER_TEST_SHARED_NAME_KEYS share one name.
export * from '../../src/identity.ts';
import { derivePseudonym as derive } from '../../src/identity.ts';
const shared = (process.env.ROUTER_TEST_SHARED_NAME_KEYS || '').split(',').filter(Boolean);
export function derivePseudonym(secretKey) {
  return derive(shared.includes(secretKey) ? shared[0] : secretKey);
}
