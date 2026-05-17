# Shape Rotator Private Matrix Completion Audit

## Objective

Move Shape Rotator Matrix/Hermes activity from the public Router backend to the
private Router instance at:

```text
https://shaperotator.teleport.computer
```

Matrix transport may still use `teleport-router` code, but notebook reads,
writes, saves, summaries, searches, and private context must go through the
private Router unless an explicit broadcaster path posts curated output to the
public Router.

## Current Conclusion

The local implementation, tests, compose topology, CI gates, runbook, and smoke
tooling are in place. The goal is not complete yet because the updated image has
not been pushed/deployed to the live public Router deployment, the production
encrypted env has not been confirmed, and the tightened deployed-bridge Matrix
smoke has not been run against the already-running `shape-matrix-bridge`
service.

## Prompt-To-Artifact Checklist

| Requirement | Artifact / Evidence | Status |
|---|---|---|
| Hermes/Matrix agent reads and writes Shape Rotator data through private Router only | `server/src/shape-matrix-bridge.ts` uses `SHAPE_ROUTER_BASE_URL` and `SHAPE_ROUTER_SECRET_KEY` for HTTP writes and private MCP search | Implemented locally; tightened live smoke passed with a local bridge process; deployed service still needs smoke |
| Matrix summaries/saves/mentions/DMs/searches no longer use public Router backend except broadcaster | `docker-compose.template.yml` and `docker-compose.deploy.yml` remove Matrix env from `router` and `router-agent`, keep `ROUTER_ENABLE_GATEWAY=0`, and introduce dedicated `shape-matrix-bridge`; `agent/router_event_worker.mjs` skips Matrix events unless `ROUTER_AGENT_HANDLES_MATRIX` is explicitly enabled; `scripts/shape-agent-boundary-check.mjs` verifies the skip guards run before Hermes onboarding/mention calls; `server/src/events.ts` is process-local, so bridge Matrix events are consumed inside the standalone bridge process rather than exposed through the public server event queue; DM save/summary tests assert private Router-only writes and DM history reads | Implemented locally; live-smoked with dedicated bridge process; production deploy still required |
| Normal deploy does not rotate Matrix crypto unexpectedly | `MATRIX_FRESH_CRYPTO=once` is not set in either compose file; `scripts/shape-compose-boundary-check.mjs` rejects `MATRIX_FRESH_CRYPTO` and `MATRIX_FRESH_CRYPTO_ONCE_MARKER` in the normal bridge service; the runbook keeps fresh-crypto as an explicit manual recovery step for stale crypto state | Verified locally, including negative guard test |
| Private entries include useful tags and provenance | `buildProvenanceContent`, `createShapeEntry`, `buildRoomSummary`; saved room summaries sort Matrix context oldest-first for auditability; tests in `server/src/shape-matrix-bridge.test.ts`; `scripts/shape-matrix-live-smoke.mjs` finds matching private entries through both private search and recent-entry fallback, fetches entry details, and requires `matrix-note` / `matrix-summary` tags plus Matrix source/event/organizer/window provenance | Unit-tested; tightened local-bridge live smoke passed; deployed service still needs the same smoke |
| Matrix bot can answer with private Router search | `searchShapeRouter()` calls private MCP `router_search`; Matrix replies use `MatrixPlatform.sendMessage`; mocked command test covers `search`; command parsing tests cover plain/full Matrix mentions; `scripts/shape-matrix-live-smoke.mjs` sends live Matrix search and requires the reply to include the just-saved sentinel, not only a generic search-results header | Tightened local-bridge live smoke passed; deployed service still needs the same smoke |
| Matrix bot can save/summarize Matrix room context into private Router | `save` / `sync` / `record` and `summarize this room` command handlers; mocked command tests cover room and DM flows; live smoke verifies save + summary private entries | Tightened local-bridge live smoke passed; deployed service still needs the same smoke |
| Public Router receives only curated/broadcast output | Bridge has no public Router write/search path; runbook states broadcaster must be separate; `scripts/shape-public-boundary-smoke.mjs` scans public Router entries for a live Matrix smoke sentinel | Verified for live sentinel over 250 recent public entries; production deploy should rerun sentinel scan |
| Deploy evidence does not leak private integration env | `.github/workflows/build.yml` redacts `SHAPE_ROUTER_SECRET_KEY` and Matrix env names from archived TEE metadata; regex tested against `KEY=value`, raw JSON `"KEY":"value"`, escaped JSON `\"KEY\":\"value\"`, and HTML-escaped `&#34;KEY&#34;:&#34;value&#34;` formats | Implemented locally; applies after CI deploy |
| Private repo/API target is current | `/Users/etherealmachine/router-teamwork` is on `main` at `8424ce3`; `git pull --ff-only` returned `Already up to date.`; `docs/integration/http-api.md` and live `/api` confirm the needed routes | Verified locally |
| Public Matrix deployment reference is current | `/Users/etherealmachine/shape-rotator-matrix` cloned from `https://github.com/Account-Link/shape-rotator-matrix`; `README.md`, `STATE.md`, and `MATRIX_ONBOARDING.md` confirm `https://mtrx.shaperotator.xyz` and space `!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g`; runbook now points operators there for Matrix onboarding/code rotation | Verified locally at `47df6c5` |
| Matrix onboarding URLs are captured without leaking codes | `docs/shape-rotator-private-matrix-runbook.md` records the homeserver root, agent signup page, human knock-join URL pattern, and Element space deep link; it explicitly keeps live signup, knock-join, and smoke-test codes out of git and relies on env/secrets for smoke tests | Implemented locally |
| Matrix auth mode is deterministic with mixed env | `matrixBotSecretKey()` and `deriveMatrixBotPassword()` make `MATRIX_ACCESS_TOKEN` win over stale `MATRIX_BOT_SECRET_KEY`; focused tests cover both helper paths | Unit-tested |
| Smoke: health/server-info | `node scripts/shape-router-smoke.mjs` passes live checks | Verified |
| Smoke: bot account/key | `SHAPE_ROUTER_SECRET_KEY=<test key> node scripts/shape-router-smoke.mjs` | Verified against live private Router as `@testbot` |
| Smoke: POST/GET entries | `scripts/shape-router-smoke.mjs` creates, publishes when needed, lists, fetches detail, and deletes a smoke entry | Verified against live private Router |
| Bridge private Router preflight | `node server/dist/shape-matrix-bridge.js --preflight` verifies `/api/me`, tags, bot profile patch, MCP `/mcp/` connect, and `router_search`; short-lived MCP clients are closed after preflight/fallback | Verified against live private Router |
| Combined deploy readiness command | `npm --prefix server run shape:readiness` / `scripts/shape-bridge-readiness.mjs` checks required env presence without printing values, renders compose, verifies compose private/public boundary, verifies the public-agent Matrix boundary, runs HTTP smoke, runs public boundary smoke, and runs bridge preflight | Verified with private Router key and Matrix access-token auth present; compose and agent boundary reverified without secrets |
| Pinned deploy images contain required artifacts/guards | `scripts/shape-compose-boundary-check.mjs --check-image` can inspect/pull the compose-pinned `shape-matrix-bridge` image and fail if `/app/server/dist/shape-matrix-bridge.js` is missing; it also inspects the compose-pinned `router-agent` image and fails if `/app/router_event_worker.mjs` lacks the ordered Matrix boundary guard; when image checks are enabled, it rejects `:latest` service images | Implemented; local audit image verified; stale checked-in deploy snapshot intentionally fails image mode |
| Single pre-deploy gate command | `npm --prefix server run shape:deploy-gate` / `scripts/shape-deploy-gate.mjs` runs script syntax checks, the agent Matrix-boundary verifier, tests, TypeScript build, local Docker server-image build, bridge artifact check, local Docker agent-image build, Matrix-boundary guard check, readiness, and live Matrix smoke without printing secret values | Passed locally with private Router key, a temporary Shape Matrix bridge account, and reusable smoke sender credentials; deployed service still needs smoke |
| Smoke: Matrix mention/search/reply | `scripts/shape-matrix-live-smoke.mjs` starts a local bridge or targets an already-running bridge, sends live Matrix search in a private DM, then creates a non-DM smoke room and sends `@<bot> search <sentinel>` as an explicit room mention; `server/src/platform/matrix.test.ts` asserts a two-member room with `m.space.parent` and `m.mentions.user_ids` queues `platform_mention` with `is_dm=false` | Tightened local-bridge live smoke passed on `mtrx.shaperotator.xyz`; deployed service still needs the same smoke |
| Smoke: Matrix summary/save | `scripts/shape-matrix-live-smoke.mjs` sends live Matrix DM `save` and `summarize this room`, then sends explicit non-DM room `@<bot> save <sentinel>` and `@<bot> summarize this room ...` commands; private entry assertions require both DM and room `matrix-note` / `matrix-summary` provenance | Tightened local-bridge live smoke passed on `mtrx.shaperotator.xyz`; deployed service still needs the same smoke |
| Smoke: agent restart without duplicate replay | Bridge treats the event cursor as process-local, ignores Matrix messages older than bridge startup, persists Matrix message IDs in `/data/shape-matrix-bridge-state.json`, saves final state on graceful SIGTERM/SIGINT shutdown, and live smoke restarts the bridge and checks private sentinel entry count | Verified live with smoke bot; startup guard unit-tested |
| Server image contains bridge artifact | `docker build -t teleport-router-shape-bridge:audit .`; packaged check confirms `/app/server/dist/shape-matrix-bridge.js` exists | Locally verified; registry push/deploy still required |
| Agent image carries Matrix boundary guard | `docker build -t teleport-router-agent-shape-boundary:audit ./agent -f agent/Dockerfile`; `router_event_worker.mjs` syntax check passes; `scripts/shape-agent-boundary-check.mjs` verifies the default-off guards are before Hermes calls; the built-image gate performs the same ordered guard check against `/app/router_event_worker.mjs` | Locally verified; registry push/deploy still required |
| CI blocks deploy on bridge/test/topology regression | `.github/workflows/build.yml` now runs `npm test`, `npm run build`, verifies `server/dist/shape-matrix-bridge.js`, validates compose topology and the source agent boundary, then pulls and checks generated deploy images for both `dist/shape-matrix-bridge.js` and the ordered `router-agent` Matrix boundary guard before `phala deploy` | Implemented locally; will apply on next CI run |
| Runbook documents config/secrets/key rotation/rollback/boundary | `docs/shape-rotator-private-matrix-runbook.md` | Done |

## Verified Commands

```bash
cd /Users/etherealmachine/teleport-router/server
npm run build
npx vitest run src/shape-matrix-bridge.test.ts
npm test
```

Latest result:

```text
shape-matrix-bridge.test.ts: 14 tests passed
platform/matrix.test.ts: 48 tests passed
18 test files passed
462 tests passed
16 skipped
```

```bash
cd /Users/etherealmachine/teleport-router
node scripts/shape-router-smoke.mjs
SHAPE_ROUTER_SECRET_KEY=<test key> node scripts/shape-router-smoke.mjs
SHAPE_PUBLIC_BOUNDARY_SENTINEL='Shape Matrix bridge smoke test' node scripts/shape-public-boundary-smoke.mjs
npm --prefix server run shape:readiness
npm --prefix server run shape:matrix-live-smoke
node scripts/shape-compose-boundary-check.mjs
node --check scripts/shape-deploy-gate.mjs
```

Latest result:

```text
/health ok
/api/server-info ok
/api ok
/api/me ok handle=@testbot
POST /api/entries ok
POST /api/entries/:id/publish ok
GET /api/entries ok
GET /api/entries/:id ok
DELETE /api/entries/:id ok
shape-public-boundary: checked 250 recent public entries; no boundary markers found
shape-compose-boundary: template/deploy files isolate Matrix/private Shape Router env to shape-matrix-bridge
shape-bridge-readiness with test key and Matrix access-token auth: private HTTP smoke, public boundary smoke, and bridge preflight pass
shape-matrix-live-smoke: Matrix DM save/search/summary ok; explicit room mention/search/save/summary ok; private entries containing sentinel=4; public boundary scan passed; restart duplicate check ok count=4
shape-deploy-gate full local gate: passed
```

The local live-smoke script is tightened so the Matrix search reply
must contain both the private search-results header and the smoke sentinel that
was saved immediately before the search. It also creates a separate non-DM
smoke room and sends explicit `@<bot> search <sentinel>`,
`@<bot> save <sentinel> ...`, and `@<bot> summarize this room ...` commands
there, so the deployed smoke can cover both DM commands and room mention/save/
summary flows. The
`MatrixPlatform` test suite now also covers this exact room shape: a
two-member room with an `m.space.parent` state event and structured
`m.mentions.user_ids` must be queued as `platform_mention` with `is_dm=false`.
`shape-matrix-bridge.test.ts` also stubs the Anthropic client and verifies that
LLM-backed summaries keep the original Matrix source messages in the saved
entry for deterministic audit/smoke assertions.
The live smoke fetches
matching private entry details via private search plus recent-entry fallback,
then verifies Matrix note/summary tags and provenance fields for both DM and
room entries, including the unique DM save text and unique room save text, and
requires at least four private entries containing the sentinel before the
restart duplicate-replay check. Reply waits are
now tied to the actual Matrix command event ID, with a send-time fallback if
`/messages` omits relation metadata. The stricter local-bridge live run passed;
the same script still needs to run in `SHAPE_MATRIX_SMOKE_RUNNING_BRIDGE=1`
mode after deployment.

Continuation verification in the current shell:

```bash
node scripts/shape-compose-boundary-check.mjs
node --check scripts/shape-router-smoke.mjs
node --check scripts/shape-public-boundary-smoke.mjs
node --check scripts/shape-bridge-readiness.mjs
node --check scripts/shape-matrix-live-smoke.mjs
node --check scripts/shape-deploy-gate.mjs
node --check scripts/shape-compose-boundary-check.mjs
node --check agent/router_event_worker.mjs
node scripts/shape-agent-boundary-check.mjs
# negative guard: run shape-compose-boundary-check against a temporary copy of
# docker-compose.template.yml with MATRIX_FRESH_CRYPTO=once added to the bridge
npm --prefix server run build
npm --prefix server test
node scripts/shape-router-smoke.mjs
node scripts/shape-public-boundary-smoke.mjs
npm --prefix server run shape:readiness
npm --prefix server run shape:deploy-gate
docker build -t teleport-router-shape-bridge:audit .
docker run --rm --entrypoint node teleport-router-shape-bridge:audit \
  -e 'const fs=require("fs"); const p="/app/server/dist/shape-matrix-bridge.js"; if (!fs.existsSync(p)) process.exit(1); console.log("bridge-present");'
node scripts/shape-compose-boundary-check.mjs --check-image /tmp/shape-compose-boundary-audit.yml
docker build -t teleport-router-agent-shape-boundary:audit ./agent -f agent/Dockerfile
git diff --check
```

Latest result:

```text
shape-compose-boundary: docker-compose.template.yml boundary ok
shape-compose-boundary: docker-compose.deploy.yml boundary ok
shape-compose-boundary negative guard rejects MATRIX_FRESH_CRYPTO in normal bridge compose
shape-compose-boundary --check-image rejects stale deploy snapshot with router-agent:latest
shape smoke scripts syntax ok
shape-agent-boundary: agent/router_event_worker.mjs Matrix handling is disabled by default before Hermes calls
agent/router_event_worker.mjs syntax ok
18 test files passed
462 tests passed
16 skipped
/health ok
/api/server-info ok
/api ok
SHAPE_ROUTER_SECRET_KEY not set; authenticated private write/read checks skipped
/api/entries reachable on public Router
SHAPE_PUBLIC_BOUNDARY_SENTINEL not set; strict raw-content boundary scan skipped
shape:readiness dry-run exits nonzero without secrets, after verifying compose
  boundary, public-agent Matrix boundary, and unauthenticated live Router checks; missing blockers:
  SHAPE_ROUTER_SECRET_KEY and MATRIX_BOT_SECRET_KEY or MATRIX_ACCESS_TOKEN
shape:deploy-gate dry-run exits nonzero before tests/image build/deploy without secrets;
  missing blockers: SHAPE_ROUTER_SECRET_KEY and MATRIX_BOT_SECRET_KEY or MATRIX_ACCESS_TOKEN
docker image id: sha256:cbae270dfe5e17e28c2f13bdea60a3670ebc7b930f651acff43def2e61fe0faf
bridge-present
shape-compose-boundary --check-image: image contains dist/shape-matrix-bridge.js
and router-agent image contains ordered Matrix boundary guard
agent docker image id: sha256:85e391389be33bd09044a982044d2cccc8fd5d5527767d7ff3e3a5f3df2d204f
deploy-gate server docker image id: sha256:792d5ada8c36e86b277fa309085f492eaab999317ef9daea40dd0ab5580c8c43
deploy-gate agent docker image id: sha256:c39a2209862c3e8ba1416f78f5befa1c338af0596ed789fabb4fd4f3c9d61adb
npm --prefix server run shape:deploy-gate passed end to end with:
  node --check for all shape scripts
  shape-agent-boundary source verifier
  npm --prefix server test: 18 files, 462 passed, 16 skipped
  npm --prefix server run build
  local server Docker build and bridge artifact check
  local agent Docker build and ordered Matrix boundary guard check
  shape:readiness with private Router auth and Matrix access-token auth
  live Matrix smoke with sentinel shape-matrix-live-smoke-mp93e3is
```

Live private Router HTTP smoke and bridge preflight were rerun with the test
private Router key. The old Matrix access token supplied for the previous
Phala homeserver returns `M_UNKNOWN_TOKEN` against `mtrx.shaperotator.xyz`, so
the tightened live Matrix smoke used a temporary Shape Matrix bridge account
created through the current signup API and the existing smoke sender credential
under `/tmp/shape-matrix-live-smoke/sender-credentials.json`. The full local
deploy gate then created a second temporary bridge account and passed with the
same private Router key and reusable smoke sender credentials.

```bash
docker compose -f docker-compose.template.yml config
docker compose -f docker-compose.deploy.yml config
GIT_SHA=ci IMAGE_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AGENT_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb docker compose -f docker-compose.template.yml config
```

Both compose files render successfully with a dedicated `shape-matrix-bridge`
service.

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/build.yml"); puts "build-yml-ok"'
# local sed fixture covers KEY=value, raw JSON, escaped JSON, and HTML-escaped JSON metadata redaction
```

Latest result:

```text
build-yml-ok
redaction-fixture-ok
compose-topology-ok
```

```bash
cd /Users/etherealmachine/router-teamwork
git pull --ff-only
git -C /Users/etherealmachine/shape-rotator-matrix rev-parse --short HEAD
```

Latest result:

```text
Already up to date.
shape-rotator-matrix: 47df6c5
```

```bash
cd /Users/etherealmachine/teleport-router/server
node dist/shape-matrix-bridge.js --preflight
```

Latest local result without secrets:

```text
Preflight starting for private Router https://shaperotator.teleport.computer
Error: SHAPE_ROUTER_SECRET_KEY is required
```

Earlier live-smoke secret availability:

```text
SHAPE_ROUTER_SECRET_KEY=was present in the earlier smoke session as a test key
MATRIX_SERVER_URL=defaults to https://mtrx.shaperotator.xyz
MATRIX_SERVER_NAME=defaults to mtrx.shaperotator.xyz
MATRIX_BOT_SECRET_KEY=was present for local smoke bot
MATRIX_BOT_HANDLE=shape-router-bridge for local smoke bot
MATRIX_SPACE_ROOM_ID=defaults to !4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g
```

```bash
SHAPE_ROUTER_SECRET_KEY=<test key> node server/dist/shape-matrix-bridge.js --preflight
```

Latest authenticated result:

```text
Private Router auth OK for @testbot
Private Router preset tags reachable
Private Router bot profile checked on https://shaperotator.teleport.computer
Private MCP connected with 12 tools
Private Router MCP search OK
```

```bash
SHAPE_ROUTER_SECRET_KEY=<test key> MATRIX_BOT_SECRET_KEY=<smoke bot secret> MATRIX_BOT_HANDLE=shape-router-bridge MATRIX_SMOKE_SIGNUP_CODE=<reserved smoke signup code> npm --prefix server run shape:matrix-live-smoke
```

Latest live Matrix result:

```text
sentinel=shape-matrix-live-smoke-mp93e3is
bot=@sr-bridge-gate-1778981046:mtrx.shaperotator.xyz
sender=@shape-router-smoke-mp904xk6:mtrx.shaperotator.xyz
Matrix save/reply ok
Matrix search/reply ok
Matrix explicit mention/search/reply ok
Matrix explicit room save/reply ok
Matrix explicit room summary/reply ok
Matrix summary/reply ok
private entries containing sentinel=4
public Router boundary: checked 250 recent public entries; no boundary markers found
restart duplicate check ok count=4
live Matrix smoke passed
```

## Remaining Gates

1. Push a new `generalsemantics/teleport-router` image containing
   `dist/shape-matrix-bridge.js`.
   - Local Docker build and packaged bridge artifact check are verified with
     `teleport-router-shape-bridge:audit`
     (`sha256:cbae270dfe5e17e28c2f13bdea60a3670ebc7b930f651acff43def2e61fe0faf`).
   - Local agent Docker build carrying the Matrix boundary guard is verified
     with `teleport-router-agent-shape-boundary:audit`
     (`sha256:85e391389be33bd09044a982044d2cccc8fd5d5527767d7ff3e3a5f3df2d204f`).
   - CI regenerates `docker-compose.deploy.yml` from
     `docker-compose.template.yml`; do not manually deploy the stale pinned
     compose snapshot unless its server image digest is confirmed to contain
     the bridge with
     `SHAPE_COMPOSE_CHECK_IMAGE=1 node scripts/shape-compose-boundary-check.mjs docker-compose.deploy.yml`.
2. Set encrypted production deployment env:
   - `SHAPE_ROUTER_SECRET_KEY`
   - `ANTHROPIC_API_KEY` (optional, enables LLM summaries instead of extractive captures)
   - `MATRIX_BOT_SECRET_KEY`
   - `MATRIX_BOT_HANDLE`
   - defaults cover `MATRIX_SERVER_URL`, `MATRIX_SERVER_NAME`, and `MATRIX_SPACE_ROOM_ID` for `mtrx.shaperotator.xyz`
3. Deploy the updated compose.
4. If the permanent production Matrix identity differs from the temporary gate
   identity, rerun the full pre-deploy gate locally with that production service
   identity:

   ```bash
   SHAPE_ROUTER_SECRET_KEY=<key> MATRIX_BOT_SECRET_KEY=<secret> MATRIX_BOT_HANDLE=<handle> MATRIX_SMOKE_SIGNUP_CODE=<code> npm --prefix server run shape:deploy-gate
   ```

5. After deployment, smoke the already-running bridge:

   ```bash
   SHAPE_MATRIX_SMOKE_RUNNING_BRIDGE=1 SHAPE_ROUTER_SECRET_KEY=<key> MATRIX_BOT_SECRET_KEY=<secret> MATRIX_BOT_HANDLE=<handle> MATRIX_SMOKE_SIGNUP_CODE=<code> npm --prefix server run shape:matrix-live-smoke
   ```

6. In Matrix, run:

   ```text
   @router search private router
   @router save <unique Matrix smoke phrase> Matrix bridge smoke test
   @router summarize this room 1h
   ```

7. Restart `shape-matrix-bridge`, then confirm old Matrix messages are not
   replayed into duplicate private Router entries.
8. Verify the public Router has no raw Shape Matrix artifacts after the test:

   ```bash
   SHAPE_PUBLIC_BOUNDARY_SENTINEL=<unique Matrix smoke phrase> node scripts/shape-public-boundary-smoke.mjs
   ```
