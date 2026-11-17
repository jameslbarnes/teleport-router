---
status: proposed
date: 2026-11-16
---

# Delegating insights runs while the owner is offline

## How an insights run works today

An insights run asks one question across private traces from at least three people. The private trace behind a post is the slice of the agent's session that led to it. The owner's machine encrypts it before upload (`server/src/trace-envelope.ts`): a full part that only the owner's key opens, and a shorter derived part that the owner's key opens and, once the owner has consented, the insights enclave's release key too. The enclave is a separate CVM. It holds the release key and has no storage access. Router has storage access and never has the release key, so reading a trace needs both (`server/src/insights-enclave.ts`).

As deployed (`/api/insights/release`: runs enabled, upgrades by the operator, at least three people), a run goes like this:

1. **Consent, once.** The owner checks the enclave's attestation and signs a consent with their storage key. It names the program by hash, the enclave and its release key, who may upgrade the enclave, the groups in scope, the accounts that may request runs, the model, the most traces per run, and an expiry of at most 90 days.
2. **Capture, every post.** The owner's machine uploads the trace, with the derived part's key wrapped to the release key (`plugins/teleport-router/scripts/capture-traces.mjs`).
3. **Request.** An account named in the consent asks a question about chosen posts, with a deadline: 48 hours by default, at most 7 days.
4. **Authorization, every run.** The owner's agent checks the request against the consent and signs, with the storage key, the enclave, the consent, the exact question and each trace by its ciphertext hash (`server/scripts/insights-owner.mjs`).
5. **Run.** Router hands the enclave the ciphertext and the signatures. The enclave checks both signatures itself, opens each derived part once, asks the model and checks the answers against the program's fixed shape.
6. **Approval, every run.** Each contributor gets their own answers sealed to them and signs approval or a veto. The result is built from approved contributions and published only if at least three people approved.

## Where the owner has to be online

Steps 4 and 6 need the storage key, which lives on the owner's machine. If that machine is off while a run is open, the owner is left out of it. A contributor who never approves or vetoes holds up publication. `DOCS.md` lists the underlying choice as undecided: "Who releases keys to the enclave: each owner's machine, or a shared key-release service."

It also means the key that owns a person's storage sits online on an agent's machine and signs every run.

## What each signature does

| Signature | When | What it does |
|---|---|---|
| Consent | Once, up to 90 days | Sets the standing rules |
| Wrap to the release key | At upload | Lets the enclave decrypt. This is the only step that hands over decryption |
| Authorization | Every run | Says yes to this run, now. Also the only way the enclave learns the owner still agrees: it verifies signatures but never sees Router's revocation record (`server/src/insights-release.ts` checks revocation; `insights-enclave.ts` does not) |
| Approval | Every run | Decides what leaves |

So step 4 doesn't need to decrypt anything. It is a permission check that happens to be signed with the storage key.

## Options for step 4

1. **The owner's machine signs (today).** The agent can sign without prompting under the owner's rules, but the machine has to be on.
2. **An authorizer key named in the consent.** The consent names a second key, held by an always-on service in its own CVM. The service signs an authorization whenever a request fits the consent: right enclave, right program, a requester the consent names, posts in scoped groups, within the trace limit. The enclave accepts that signature because the consent, which the storage key did sign, names it. Revoking means Router and the service both stop. The storage key is then needed only to consent, approve and leave.
3. **Consent alone.** The enclave runs on the consent and Router's request with no per-run signature. Simplest, but revocation would then rest on Router alone, since the enclave can't see it.

Option 2 matches what `DOCS.md` calls a shared key-release service, except that nothing has to be released: decryption was already delegated at upload.

## Options for step 6

- Keep approval manual. This is the step where a person sees what will be published.
- Let the consent pre-approve contributions that pass the program's own checks, signed by the same authorizer service.
- Give a non-deciding contributor a default after a deadline, so one silent person can't hold up a run.

## Keys that can change

- **The release key** comes from the enclave's dstack KMS (`teleport-router/insights-release/v1`) and is tied to the app, not the code. The live enclave says "any build the operator deploys can use this key." The code also supports a public timelock of 24 to 720 hours, which isn't in use. If the release key changed, derived parts wrapped to the old key could be re-wrapped only by their owners, since only the storage key opens the owner wrap.
- **Router's keys** (storage identity and author keys) also come from dstack. Phala's [preliminary incident report of 10 November 2026](https://phala.com/posts/phala-november-preliminary-incident-report) says it "rotated the KMS root key used to derive application secrets" on 6 November. That did not change Router's keys. The deploy of 5 November (`evidences/2026-11-05`, commit `841d007`) already pinned Router's identity in `/data`. Router has restarted many times since and today reports the same DID, `did:pkh:eip155:1:0xA72963f16852a24A0B9956813BAf3dbcFd7C5868`. Every archived attestation from 2 to 16 November names the same KMS. This assumes `/data` survived those deploys. If GetKey ever did change, Router's pins would stop it at startup (`server/src/tinycloud-identity.ts`), and there is no migration flow.

## Storage

Traces and posts reach storage already encrypted, so storage only has to keep ciphertext available and give the owner a way to cut Router off. TinyCloud does that. So could a person's Google Drive or Cloud Storage bucket, with Router holding an OAuth token in its CVM and the person revoking it from their Google account. That would need a small backend interface (get, put, list, delete, a conditional write, an access check), and a check that the second backend supports the conditional writes linking relies on. Cloud Storage has generation preconditions; Drive is unchecked.

TinyCloud's own encryption network wouldn't change the picture: its only working backend is dstack and networks are one of one (`tinycloud-node`, `encryption_network/types.rs`), so it would be one more CVM deciding who decrypts.

Two gaps in Router's TinyCloud use, whichever way the above goes:

- Grants linked in the browser last a year, and nothing renews them or warns the person (`browser/src/storage.mjs`, `server/src/author-store.ts`). Only `server/scripts/link-tinycloud.mjs` renews. TinyCloud's renewal leases (`tinycloud-core/src/renewal.rs`) could cover this.
- Revocation is noticed at the first read after a 60 s lease, not on a timer.

## Proposed direction

- Add an authorizer key to the consent (option 2), and have the enclave accept authorizations signed by it. Run the authorizer as its own small app, and send consent revocations to it as well as to Router.
- Keep approval manual for now. Decide separately what happens when a contributor never decides.
- Move the enclave's upgrade policy to the public timelock the code already supports.
- Fix grant renewal and add an expiry warning. Define the storage interface before adding a second backend.
- Update `DOCS.md`: "The enclave step (not built)" no longer describes the code.

## Open questions

- Where the authorizer runs and who may upgrade it. On Phala it sits under the same KMS as the enclave.
- Whether the enclave should check revocation itself, for example against a list the authorizer signs.
- How owners re-wrap traces if the release key ever changes.
- Which KMS key Phala rotated on 6 November. Router's evidence shows it wasn't Router's; the report doesn't say.

## References

- `server/src/insights-release.ts`, `server/src/insights-enclave.ts`, `server/src/insights-enclave-server.ts`, `server/src/trace-envelope.ts`, `server/scripts/insights-owner.mjs`, `plugins/teleport-router/scripts/capture-traces.mjs`
- `DOCS.md` ("Insights pipeline"); `docs/tinycloud-authors.md`; `docs/tinycloud-encryption.md`; `docs/storage-key-recovery.md`
- TinyCloud node: https://github.com/TinyCloudLabs/tinycloud-node
- Phala November preliminary incident report: https://phala.com/posts/phala-november-preliminary-incident-report
