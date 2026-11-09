# TinyCloud record encryption

Router encrypts a linked author's published posts, imported conversations and summaries before sending them to TinyCloud. This includes public posts: their stored copies are encrypted, while Router can still serve them publicly according to their audience. Private-group membership and Discord permissions remain Router's responsibility.

## Format and keys

- Each v2 record uses AES-256-GCM with a fresh random 96-bit nonce and a 128-bit tag. Associated data binds the format, owner DID, space, delegated prefix, record kind and record ID. The complete previous signed JSON record is inside the ciphertext, so content, author fields and audience are hidden together.
- Production obtains a separate 32-byte root through dstack at `teleport-router/record-encryption/v1`. HKDF-SHA-256 derives an author key bound to owner, space and prefix. The existing TinyCloud identity and record-integrity key are unchanged. A persistent key check beside the DID pin rejects a changed encryption root at startup.
- Router's existing HMAC remains inside the encrypted record. An owner receives their encryption key through recovery, but cannot use it to forge Router's authorization of an edited record.
- `router/recovery-v1` holds the author key encrypted to the owner's secp256k1 public key: ephemeral ECDH, HKDF-SHA-256, AES-256-GCM, with owner/space/prefix/recipient/ephemeral key bound as associated data. The public key is recovered from the verified one-time owner linking signature and checked against the owner DID. Router authenticates the recovery envelope with its independent integrity key before using it.
- No encryption root or owner private key is stored in Firestore, posted to Router, or included in API responses. Firestore retains account metadata, public recovery key and the minimum accepted record version.

These are application-encrypted records, not device-to-device end-to-end encryption. Router has plaintext while serving authorized requests. Whoever can authorize a future Router update under the current dstack key-release policy remains trusted. No new remote attestation verifier or stricter upgrade policy is introduced here.

## Upgrade and recovery

Existing linked authors retain legacy reads until they sign a fresh link challenge. New writes for those accounts wait for setup instead of silently publishing more plaintext. Re-run the existing `server/scripts/link-tinycloud.mjs` with the same protected TinyCloud and Router key files; it reuses the existing grant when valid. The script never sends the owner private key to Router.

Before migration, Router returns a recovery envelope encrypted to the verified owner. The client must decrypt it and return an HMAC proof bound to that exact envelope and the one-time signed challenge. A signature alone cannot activate encryption. Linking then creates and reads back the owner recovery record. It migrates existing v1 records using their strong network ETag and `If-Match`; a concurrent edit or deletion aborts without an unconditional retry. New legacy-to-TinyCloud copies use `If-None-Match: *`. The migration decrypts and checks all current records before committing a durable per-author minimum of v2. Interrupted runs can resume; an uncertain database commit quarantines the account until a successful re-link. After that commit, an authentic old v1 wire record is rejected, including on restart or re-link. Stale Firestore cleanup copies never recreate records deleted from an already-linked owner's space. Before a first link activates, Firestore is still authoritative, so a retry may recopy a deleted partial destination.

Owners with an existing raw TinyCloud key can export independently, including after revoking Router:

```sh
cd server
npm ci
npm run build
node scripts/decrypt-my-router-data.mjs --tinycloud-key-file /private/tinycloud.key --output /private/router-export.json
```

Use `--space-prefix` if the original space used a prefix other than `router`. The exporter contacts TinyCloud directly; it does not need Router, a Router API key, a Router delegation or a dstack key. It writes a new file with mode 0600 (on Windows, use a private parent-directory ACL) and refuses to overwrite it. The file contains plaintext. The exported records pass the AEAD check but are not independently verifiable Router authorship receipts: the Router HMAC remains private. This CLI recovery path requires a raw secp256k1 key; browser and hardware wallets that cannot perform ECDH cannot complete the recovery proof and need a separate recovery integration before linking. The link CLI also decrypts the actual stored recovery envelope before reporting success. Backups of the owner's TinyCloud key are therefore part of the confidentiality boundary.

## Limits

- Encryption cannot erase plaintext previously retained in TinyCloud history, provider backups or recipients' copies. Migration replaces current values; it does not prove historical deletion.
- TinyCloud can still see account and record paths, sizes, timing and access patterns, and can withhold, delete or replay ciphertext. The v2 floor stops plaintext wire-format downgrade, not authentic replay: the node can replay an older valid v2 record, and an owner with the AES key can rewrap a previously signed v1 record into v2. One missing recovery record or corrupt record makes that author's whole Router index unavailable; it does not disclose the content.
- Legacy accounts that have not linked to TinyCloud still use the existing Firestore storage. The unused `TINYCLOUD_GROUPS` prototype is separate from production author storage and is not covered by this format. Startup rejects enabling both modes together.
- Waiting posts, in-memory indexes and the restart recovery file remain inside Router's existing Phala trust boundary. This change does not claim every Router data store is application-encrypted.
- Discord and any model service used for authorized agent replies still receive the selected plaintext context. Legitimate group members can copy information they can read.

## Deployment checks

Before deployment, run the unit suite and the synthetic hosted-node author test. The hosted test must demonstrate real conditional-write rejection, ciphertext on the node, private-group access boundaries, and owner decryption after revocation. Do not infer server support for conditional writes from SDK types alone.

Deploy only after approval. Inventory existing linked accounts and confirm an owner recovery method for each before deployment; the upgrade pauses their new writes until they re-link. Record the existing Router DID, image and record counts, deploy the reviewed image, and verify the DID remains unchanged. Re-link each existing author with their own protected key; inspect `/api/tinycloud/status` for `encryption.version: 2` and `setupRequired: false`. Verify private retrieval and deletion with synthetic data, and run a real owner-only export to a private file before reporting completion. Authors without a usable owner key remain explicitly pending, not silently marked encrypted. Keep the existing identity key backups; the recovery record must remain with the encrypted records.

Rolling back to old application code after an author migrates is unsafe: old code cannot read v2 and might publish plaintext. Use a forward fix that retains v2 reads and the durable downgrade barrier. Changing Phala app identity or key-release configuration can change the encryption root; there is no automatic migration to a new root in this change. Owners can still export with their keys, but Router requires an explicit reimport/key migration. Never delete the key pins or change key-derivation paths to make a startup error disappear.
