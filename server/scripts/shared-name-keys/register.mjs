// Tests only. Start the server with `--import tsx --import ./scripts/shared-name-keys/register.mjs` and
// ROUTER_TEST_SHARED_NAME_KEYS=key1,key2,... to give every listed key the name derived from the first one.
// Tests use it to check that a note with a handle belongs to that handle's account, whatever name its key has.
import { register } from 'node:module';
register(new URL('./hooks.mjs', import.meta.url));
