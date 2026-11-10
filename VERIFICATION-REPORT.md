# Router deployment verification report

Last revised November 10, 2026. This report says how to check which code the live Router is running, and what that check does and does not prove. Who can read what is described in [DOCS.md](DOCS.md), under "Trust model".

Router runs in an enclave (a trusted execution environment, Intel TDX on Phala Cloud via dstack).

## Deployment identity

| Field | Value |
|-------|-------|
| App ID | `db82f581256a3c9244c4d7129a67336990d08cdf` |
| Trust Center | https://trust.phala.com/app/db82f581256a3c9244c4d7129a67336990d08cdf |
| Enclave report | https://db82f581256a3c9244c4d7129a67336990d08cdf-8090.dstack-pha-prod9.phala.network/ (see step 1; it may be closed) |
| Production URL | https://router.teleport.computer |
| Source code | https://github.com/jameslbarnes/teleport-router |
| Docker images | `docker.io/generalsemantics/teleport-router`, `teleport-router-agent`, `teleport-router-discord` |
| KMS | Phala's cloud KMS ("Pha"). It keeps no public log of upgrades. A move to the on-chain KMS on Base is not done ([#4](https://github.com/jameslbarnes/teleport-router/issues/4)) |

## Verification steps

### 1. Get the enclave's report

The enclave reports what it is running: the compose file it was started with, a `compose-hash`, the OS image hash and the TDX measurements.

```bash
curl -s https://db82f581256a3c9244c4d7129a67336990d08cdf-8090.dstack-pha-prod9.phala.network/
```

This public address may not answer. The deploy scripts note that Phala closed public port 8090 on enclaves still running unpatched OS images after an incident in October 2026, and they fall back to Phala's attestation API, which needs the operator's API key (`scripts/verify-phala-deploy.sh`, `scripts/archive-tee-evidence.sh`). The copy archived on November 10, 2026 came from that API. Whether an outside reader can fetch the report today is not established from this repository. The Trust Center link above is Phala's own page for this app.

Each deploy also commits a copy of the report to `evidences/<date>/` in this repository (step 5). That copy is taken by the operator's CI, so it is the operator's record and not an independent one.

### 2. Read the compose file inside the report

Do not hash the `docker-compose.deploy.yml` committed to this repository. It is a stale snapshot. CI makes the real one on each deploy by filling `docker-compose.template.yml` with the short git SHA and the image digests it just built (`.github/workflows/build.yml`, "Generate compose file"), deploys it, and then deletes it.

The compose file that was actually deployed is inside the report, as `docker_compose_file` in the app compose record. Read it there and check two things:

- The `router` service sets `GIT_SHA=<short sha>`, and its image is `docker.io/generalsemantics/teleport-router:<short sha>@sha256:<digest>`. The agent and Discord images are pinned by digest in the same way.
- Apart from those values, it matches `docker-compose.template.yml` at that commit.

CI makes the same comparison after each deploy: `scripts/verify-phala-deploy.sh` waits until the report contains the expected `GIT_SHA` and the three image digests, and fails the deploy if it does not.

The report also carries a `compose-hash` measurement, which is what the hardware quote covers. How to recompute that hash from the archived copies is not established from this repository: the archived copies have secret values redacted, so they do not hash to the same value.

### 3. Match the image digests to a build

- Open the [Actions tab](https://github.com/jameslbarnes/teleport-router/actions) and find the workflow run for the deployed commit.
- The "Docker Image Attestation" section of the run summary lists the digests of the Router and agent images. The deployment summary lists them again.
- They should equal the digests in the compose file from step 2, and the ones in `evidences/<date>/deploy-info.json`.

This shows that the enclave runs the image CI built from that commit. Builds are not reproducible, so it does not let you rebuild the image yourself and get the same digest.

### 4. Deployment history

There is no public upgrade log. With Phala's cloud KMS, an upgrade does not leave an on-chain record. The history that exists is the `evidences/` folders committed by CI and the workflow runs on GitHub. Both are the operator's records.

The on-chain KMS on Base would emit a public event for every upgrade. Router does not use it. Moving to it means recreating the enclave ([#4](https://github.com/jameslbarnes/teleport-router/issues/4)).

### 5. Archived evidence

```
evidences/
  2026-11-10/
    attestation.json   # the enclave's report, from Phala's attestation API, secrets redacted
    deploy-info.json   # git SHA, image digests, where the report came from, time, workflow run
```

Older folders, from when the public report was reachable, hold `metadata.json` and sometimes `quote.json` instead of `attestation.json`.

## What this does and does not protect

### What the enclave protects

- **Waiting notes.** A note that has not published yet is kept in the enclave's memory. On a clean shutdown, waiting notes are written to the enclave's data volume and restored at startup. A crash loses them.
- **Keys from the key service.** Router's storage identity and its record-encryption root come from the enclave's key service. They are not stored in the database or returned by any API.
- **Router keys.** The database stores a SHA-256 hash of each person's Router key, not the key. Router sees the key itself on every connection.
- **Runtime integrity.** TDX measures what was started, so the report in step 1 describes the code that is running.

### What the enclave does not protect

- **Upgrades.** Whoever can authorize a new Router release can deploy different code, and the enclave's keys carry over to it. A changed release could read what the current one can. There is no independent public record of the change.
- **Notes by authors who have not linked storage.** Their published notes are in the older Firestore database, unencrypted, private-group notes and direct messages included. Its credentials are given to the enclave as environment variables, and the operator can read that database from outside the enclave.
- **Linked authors' stored notes, from Router itself.** They are kept encrypted in each author's own TinyCloud space, so TinyCloud cannot read them. Router can, while it serves a request.
- **Public notes.** They are public by design.
- **Anything that leaves the enclave on purpose.** When automated review is configured, the first 2,000 characters of a public note go to the review service as the note is written. Email goes through the email provider. Discord sees what is typed into its commands and the bot's replies.

### What you have to assume

1. Intel TDX hardware is not compromised.
2. Phala's dstack and its KMS work as described.
3. The operator, and anyone else who can authorize a release, deploys only code from this repository. Steps 1 to 3 check this for one deploy. They do not prevent a later one.
4. Docker Hub serves the right image for a digest. Pinning by digest limits this.

## Known gaps

| Gap | Status | Mitigation |
|-----|--------|------------|
| No public upgrade log (Phala's cloud KMS) | Open | Needs the enclave recreated with the on-chain KMS ([#4](https://github.com/jameslbarnes/teleport-router/issues/4)). Evidence is archived to git in the meantime |
| The enclave's public report may be closed | Open | CI falls back to Phala's authenticated API. Whether outsiders can fetch the report is not established from this repository |
| Releases are not restricted to approved builds | Open | Options are pinning to exact builds or a delay before upgrades (DOCS.md, "Known limits and open questions") |
| Builds are not reproducible | Open | The Dockerfile names its base image by tag (`node:22-alpine`), not by digest. Full reproducibility needs Nix or apko |
| Images are hosted on Docker Hub | Open | GHCR would allow Sigstore signatures and SLSA provenance |
| No rate limiting on the API | Open | Tracked separately from the enclave |

## References

- [Phala dstack verification docs](https://docs.phala.com/dstack/verification)
- [dstack key management design](https://docs.phala.com/dstack/design-documents/key-management-protocol)
- [xordi-release-process](https://github.com/Account-Link/xordi-release-process/) (reference implementation)
- [devproof audit report](https://github.com/amiller/devproof-audits-guide/blob/main/case-studies/hermes/DEVPROOF-REPORT.md)
