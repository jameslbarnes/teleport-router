---
status: proposed
date: 2026-11-16
---

# Recovering a storage key

## Context

A person has two keys (see "Accounts, keys and recovery" in `DOCS.md`). The Router key signs them in. The storage key owns their TinyCloud space, grants Router the `router/` folder, and is the only way to read their records without Router.

Today the only backup is the recovery file: both keys, encrypted under a password the person chooses. If they lose the file or the password, Router keeps serving their notes, because Router's per-author key comes from dstack, not from them. What they lose is the ability to export without Router and to revoke Router's grant. Router can't reset the password.

The storage key has to be a raw secp256k1 key. Router writes `router/recovery-v1` encrypted to it by ECDH, and setup doesn't finish until the owner has decrypted that record (`docs/tinycloud-encryption.md`). A wallet that can only sign can own the space but can't complete this step.

The storage key matters most when Router can't be relied on: a bad release, or a rebuild under a new app_id. Router's TinyCloud identity and its record encryption root both come from dstack. Rebuilt under a new app_id, Router would hold neither, so every author's grant would name a key it no longer has, and every record would be sealed under a root it can't derive. The recovery record, opened with the storage key, is the way back. This is not hypothetical. Phala's [preliminary incident report of 10 November 2026](https://phala.com/posts/phala-november-preliminary-incident-report) says an attacker obtained application credentials, that affected CVMs "may also have had secrets derived from Phala's key management system (KMS) exposed", and that on 6 November Phala "rotated the KMS root key used to derive application secrets." If GetKey returns different keys after such a rotation, Router's identity pin stops it at startup (`server/src/tinycloud-identity.ts`), and its existing grants and records stay tied to the old keys.

People will ask to recover by email. This compares the ways to add that.

## Options

Each option is a backup alongside the recovery file, not a replacement. "Router goes bad" means a malicious release or Router disappearing. A bad Router can already read everything, so the question for a backup is whether the person can still leave.

| | Recovery file (today) | OpenKey | DKIM email gate | Lit Chipotle action |
|---|---|---|---|---|
| What it is | Password-encrypted file the person keeps | TinyCloud Labs' key service; email code, passkey or Apple sign-in; keys sealed in a Phala dstack CVM | An attested app holds the storage key and releases it to a new device after the person sends it a DKIM-signed email ([dsmack's email gate](https://github.com/amiller/dsmack/blob/main/applications/private-agent-web/email-gate.mjs)) | A Lit action holds the key or the file's password and releases it after an email check |
| Who can recover without the person | Nobody without the file and password | Whoever controls their inbox; whoever can upgrade OpenKey | Whoever controls their inbox; whoever can upgrade the gate | Whoever controls their inbox; Lit's release signers |
| What the person keeps | File and password | Inbox or passkey | Inbox | Inbox |
| Revoke Router if it goes bad | Yes | Yes, it signs as owner | Yes | Yes |
| Export without Router | Yes | No: it only signs, with no export or ECDH route (`apps/api/src/routes/keys.ts`) | Yes, it holds the raw key | Yes, if it releases the raw key or password |
| Root outside Phala's KMS | Yes | No | No | No: Chipotle is one Phala TDX CVM |
| Who sees the recovery | Nobody | Resend, which delivers the code | Nobody; the gate sends no mail | Lit's email check provider |

A separate app_id doesn't put a backup outside Phala. Phala's 2-of-3 KMS Safe can approve an OS image or KMS build that claims any app's id, with no delay. That Safe sits under Router, OpenKey, a gate of ours, and Lit's Chipotle app alike. A separate app only separates the backup from Router's own upgrade owner.

## Proposed direction

- Keep the recovery file. It is the only backup whose root is outside Phala.
- Add an email backup modeled on dsmack's DKIM gate, holding the raw storage key, so both revoking and exporting keep working. Prefer DKIM to emailed codes: the person sends one message from their own account, the gate checks the signature against keys fetched from two DoH resolvers that must agree (`dkim-verifier.mjs`), and no mail service ever sees a recovery code.
- Make the gate's own state survive a rebuild. dsmack's gate generates its keys itself and keeps them in plaintext JSON in its data directory. On a webhost CVM the disk key depends on instance_id, so a rebuild loses them. Derive them with GetKey or back them up.

## Open: the recovery delay

dsmack's gate releases keys only after 48 hours. Existing devices check the gate when opened and every minute while visible, and show a notice with one-click cancellation. Passkey recovery and QR linking stay immediate, so email is the slow path of three ([README](https://github.com/amiller/dsmack/blob/main/applications/private-agent-web/README.md)). We shouldn't pick a delay for Router before knowing what it costs.

1. **Who waits.** Only people who have lost every device, the recovery file, and any passkey. How many depends on what Router offers before email.
2. **What is blocked while they wait.** The two keys don't need the same delay. Losing the Router key for 48 hours blocks all use of Router. The storage key is rarely needed day to day, so a delay there costs little. One option is a fast email path for the Router key and a delay only on the storage key. Fast recovery of the Router key would hand someone who takes over the inbox the person's private groups and the ability to post as them.
3. **What the delay buys.** Only something if the real person sees the pending recovery somewhere other than email: an existing device, Router's own pages, the Discord bot. Someone who has lost every device has nothing to cancel from, so for them it is only waiting.
4. **Parameters.** A shorter delay; a delay only on the storage key; instant release with notices through Router and Discord.

## Why TinyCloud and not any blob store

Router already treats TinyCloud as availability only: it stores ciphertext and can withhold, delete or replay records, but not read them. A person's own Google Drive holding the same ciphertext would see the same things (names, sizes, timing) and could do the same harm. For keeping records private from the storage provider, the two are the same.

The TEE isn't there to protect data from storage. It is there because Router has to read notes while their author is offline, to serve groups, search, sharing rules and the Discord bot. That is why records are encrypted with Router's per-author key, and why the storage key only opens a copy of it. If people encrypted with a key only they held, no TEE would be needed, and Router couldn't serve anything.

The differences are in who controls access to the storage:

| | TinyCloud | Google Drive |
|---|---|---|
| Who owns the storage | The storage key; one key both owns the space and opens the recovery record | A Google account; the key only decrypts. Losing the account loses the ciphertext |
| How Router gets access | A UCAN grant to Router's DID on `router/` only, checked by the node | An OAuth token Router keeps in the enclave, scoped per app (`drive.file` or `drive.appdata`), not per folder; needs a registered Google client |
| Revoking Router | The owner revokes the delegation | The person removes the app in their Google account settings |
| Granting a measured container | The owner signs a grant to the container's own key after checking its quote (`subhost/README.md`) | Only an OAuth client can be granted, so Router would hold the token and pass access on itself |
| Conditional writes | `If-Match` / `If-None-Match` with strong ETags, which linking relies on (`docs/tinycloud-encryption.md`) | Not checked |

Granting a container could also be done with encryption alone: wrap the content key to the container's attested public key, as the `insights/` folder does for its owner. Then a reader without the wrapped key gets only ciphertext wherever it is stored, and storage grants mainly protect against deletion and hide metadata.

## Other open questions

- A backup outside Phala other than the file: a holder on a different TEE vendor (Turnkey on AWS Nitro, Oasis ROFL), each with its own upgrade authority.
- The setup page's code handles the unlocked storage key and is served by Router (`DOCS.md`, "What each person has to trust"). An email gate adds another page flow with the same exposure.
- DKIM fails for Microsoft 365 tenants whose signing domain doesn't match the From address, for subject rewriting, and for forwarded mail.

## References

- `DOCS.md`; `docs/tinycloud-encryption.md`; `browser/src/storage.mjs`; `browser/src/setup.mjs`
- dsmack: https://github.com/amiller/dsmack, `applications/private-agent-web/` (`email-gate.mjs`, `email-gate-runtime.mjs`, `dkim-verifier.mjs`, `README.md`)
- Phala November preliminary incident report, 10 Nov 2026: https://phala.com/posts/phala-november-preliminary-incident-report
- OpenKey: https://github.com/TinyCloudLabs/openkey (`docs/tee-overview.md`, `apps/api/src/auth.ts`, `apps/api/src/routes/keys.ts`)
- Lit Chipotle architecture: https://developer.litprotocol.com/architecture/index
