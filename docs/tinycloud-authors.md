# Each author keeps their own writing

The Router can store an author's published posts, imported conversations and personal summaries in that author's TinyCloud space. A private group combines its members' posts through the same access rules as other Router channels. Each member can withdraw access independently.

## Linking an existing identity

Keep your TinyCloud private key separate from your Router identity key. The Router receives a scoped delegation and a one-time signature proving control of the TinyCloud owner, never the TinyCloud private key.

From `server/`, after `npm ci`:

```sh
node scripts/link-tinycloud.mjs --tinycloud-key-file /private/path/tinycloud.key --router-key-file /private/path/router.key
```

Both files must already exist. The command does not generate or replace identities. It uses the `router` space by default and grants get, put, list and delete on exactly `router/`, without also granting the public space. Grants last one year; rerun the command to renew. A protected receipt beside the key file retains the grant for safe retries and revocation. `--receipt` changes that location. The receipt's parent directory should have the same access restrictions as the key directory.

To withdraw access, run the same command with `--revoke`. Your data stays in your space. Existing copies held by people or services that already read it cannot be recalled.

Linking copies each record with its original ID and reads it back before switching the account. Only then are legacy records deleted. Interrupted copying leaves the old account storage active. A partially completed cleanup is reported and can be retried with the same command. A linked account never falls back to database copies when its TinyCloud grant fails.

## Runtime and ownership

- New waiting posts remain in the Router's existing staged-storage system. At publication, linked authors' records go to `router/posts/<id>`, `router/conversations/<id>` or `router/summaries/<id>` in their space.
- Feed and search indexes are held in process memory and rebuilt from the grants. They are checked before reads when a 60-second lease expires. Revoked, expired or unavailable grants remove that author's records from the current view. Owner-side deletion is detected by the same check. If a check is slow, the read waits; stale content is not returned after a failed check.
- Personal summaries follow the author. Cross-author daily summaries are kept only in memory and evicted when a contributing author's grant fails. Existing daily summaries containing the migrating author's writing are removed from legacy storage. Replies, quotations or digests previously delivered to other readers are those readers' copies.
- Records carry a Router integrity tag. Directly altering JSON in an owner's space cannot impersonate another author or change a published post's addressing. Owner deletion remains supported.
- User profiles, channel membership and scoped grants remain in Firestore. Authors who have not linked TinyCloud continue using their existing storage. Moving inactive authors requires their own identity and consent; it is not silently done for them.
- Failed publications remain waiting and do not block other authors. Staged IDs are retained on retry. Existing graceful-shutdown recovery is still used; this does not promise durability after a process or machine crash.

## Server identity

Production uses `TINYCLOUD_AUTHORS=tinycloud`, `TINYCLOUD_KEY_SOURCE=dstack`, `NODE_ENV=production`, and the `/var/run/dstack.sock` mount. The application derives its own key from the fixed dstack path `teleport-router/tinycloud/v1`, purpose `secp256k1`. It is independent of every person's key and is not written to disk. Only its public DID is pinned at `/data/tinycloud-router-did`; a mismatch fails startup rather than silently changing the recipient of existing grants. `TINYCLOUD_EXPECTED_DID` can additionally pin it in configuration.

`GET /api/tinycloud/router` exposes the public DID, host and required scope. Account-DID delegations remain usable with a new SDK session. Changing the CVM/application's KMS identity is a separate migration, not a normal key rotation. The current deployment uses Phala's cloud KMS; this does not claim immutable or independently governed upgrades. See the [dstack SDK](https://github.com/Dstack-TEE/dstack/tree/master/sdk/js) for deterministic key derivation and the [KMS design](https://docs.phala.com/dstack/design-documents/key-management-protocol) for the governance distinction.

Local tests supply a throwaway `TINYCLOUD_ROUTER_KEY`. A supplied test key is refused in production. Do not enable the older `TINYCLOUD_GROUPS` prototype alongside author storage.

## Verification

`npm test` covers migration/readback failures, recovery from a fresh index, all read surfaces after revocation, tamper rejection, cleanup retries, concurrent migration/publication and failure isolation. `npm run build && node scripts/tinycloud-authors-e2e.mjs` exercises three synthetic authors through a local HTTP/MCP Router against the real hosted TinyCloud node, including wrong-owner signature rejection, separate storage, private group membership, a fresh SDK session and independent revocation. Test keys are generated in memory and never printed; grants are revoked at the end.

The hosted three-author test passed on 2026-11-05. Production KMS and the first real-account migration must also be checked during rollout before reporting that the live Router has switched.
