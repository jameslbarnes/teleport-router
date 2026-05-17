# Shape Rotator Private Matrix Bridge Runbook

## Goal

Run the Shape Rotator Matrix bot as a bridge to the private Router instance at:

```text
https://shaperotator.teleport.computer
```

The public Router must not receive Shape Rotator notebook writes, searches, DMs,
room summaries, or raw Matrix transcript content. Public Router posting is a
separate broadcaster path.

## Architecture

```text
Shape Rotator Matrix server
  -> shape-matrix-bridge process
     -> Matrix E2EE transport from teleport-router/server/src/platform/matrix.ts
     -> private Router HTTP API for writes
     -> private Router MCP router_search for search
  -> https://shaperotator.teleport.computer
```

The bridge lives in `server/src/shape-matrix-bridge.ts`. It deliberately avoids
adding Matrix UI or platform code to `router-teamwork`.

## Required Secrets

Set these in the deployment env file:

```text
SHAPE_ROUTER_BASE_URL=https://shaperotator.teleport.computer
SHAPE_ROUTER_SECRET_KEY=<private Shape Router bot key>
ANTHROPIC_API_KEY=<optional, enables LLM room summaries>

MATRIX_SERVER_URL=https://mtrx.shaperotator.xyz
MATRIX_SERVER_NAME=mtrx.shaperotator.xyz
MATRIX_BOT_SECRET_KEY=<stable Matrix bot secret>
MATRIX_BOT_HANDLE=<bot localpart, usually router>
MATRIX_SPACE_ROOM_ID=!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g
MATRIX_REGISTRATION_TOKEN=<Shape Matrix signup code, first boot only if account does not exist>
MATRIX_SIGNUP_URL=https://mtrx.shaperotator.xyz/signup/api
```

`SHAPE_ROUTER_SECRET_KEY` must belong to a bot/service account in the Shape
Router instance. The bridge patches that profile on startup with
`stagingDelayMs=0` unless `SHAPE_ROUTER_CONFIGURE_BOT_PROFILE=0`.

Alternatively, use a pre-provisioned Matrix session instead of password/signup:

```text
MATRIX_ACCESS_TOKEN=<Matrix access token>
MATRIX_USER_ID=<optional if /account/whoami returns it>
MATRIX_DEVICE_ID=<optional if /account/whoami returns it>
MATRIX_CRYPTO_SECRET=<optional stable secret for crypto callbacks>
```

If both `MATRIX_ACCESS_TOKEN` and `MATRIX_BOT_SECRET_KEY` are present,
access-token mode wins. This lets a pre-provisioned production Matrix device
ignore stale password/signup env that may still exist in an encrypted deploy
environment.

The bridge defaults to the current Shape Rotator Matrix deployment:
`https://mtrx.shaperotator.xyz`,
`mtrx.shaperotator.xyz`, and the `#shape-rotator:mtrx.shaperotator.xyz`
space ID above. Startup ignores Matrix messages older than process start, and
bulk onboarding DMs are disabled by default with `SHAPE_MATRIX_ENABLE_ONBOARDING=0`.

The operational source of truth for the Matrix homeserver itself is the
`shape-rotator-matrix` repo. Keep a current checkout next to this repo:

```bash
git clone https://github.com/Account-Link/shape-rotator-matrix \
  /Users/etherealmachine/shape-rotator-matrix
git -C /Users/etherealmachine/shape-rotator-matrix pull --ff-only
```

Use its `README.md` and `STATE.md` for the current room layout, onboarding
flow, signup/knock code administration, and Matrix-side deployment details.
At the time this runbook was last audited, that repo identified the production
deployment as `https://mtrx.shaperotator.xyz`, space
`!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g`, and child rooms for General,
Announcements, and Bot Noise.

Current public Matrix entry points:

```text
Homeserver root: https://mtrx.shaperotator.xyz/
Agent signup:    https://mtrx.shaperotator.xyz/signup
Human join:      https://mtrx.shaperotator.xyz/join?code=<knock-join-code>
Space deep link: https://matrix.to/#/%23shape-rotator%3Amtrx.shaperotator.xyz
```

Do not commit live signup, knock-join, or smoke-test codes. Keep them in the
deployment secret store, local shell env, or the Matrix operator's password
manager. The live-smoke script reads the reserved smoke signup code from
`MATRIX_SMOKE_SIGNUP_CODE` and should not print its value.

## Deployment

Build the normal `teleport-router` server image. Before deploying, confirm the
image being pinned contains `dist/shape-matrix-bridge.js`; stale pinned deploy
snapshots from before this change will not.

For a generated or pinned deploy compose, run the artifact guard before manual
deployment:

```bash
SHAPE_COMPOSE_CHECK_IMAGE=1 \
  node scripts/shape-compose-boundary-check.mjs docker-compose.deploy.yml
```

Add `SHAPE_COMPOSE_PULL_IMAGE=1` if the pinned image is not already present in
the local Docker cache. The normal readiness check intentionally skips this pull
so CI and local checks do not accidentally validate an old generated snapshot.
The GitHub deploy workflow runs the same check with `SHAPE_COMPOSE_PULL_IMAGE=1`
after generating `docker-compose.deploy.yml` and before `phala deploy`.
When `--check-image` is enabled, the guard also rejects `:latest` image tags so
manual deployment must use immutable image references. The image check verifies
both that the server image contains `dist/shape-matrix-bridge.js` and that the
agent image contains the ordered `ROUTER_AGENT_HANDLES_MATRIX` boundary guard.

In compose, run a dedicated service:

```yaml
shape-matrix-bridge:
  image: docker.io/generalsemantics/teleport-router:${GIT_SHA}@${IMAGE_DIGEST}
  command: ["node", "dist/shape-matrix-bridge.js"]
  environment:
    - SHAPE_ROUTER_BASE_URL=https://shaperotator.teleport.computer
    - SHAPE_ROUTER_SECRET_KEY
    - ANTHROPIC_API_KEY
    - MATRIX_SERVER_URL=https://mtrx.shaperotator.xyz
    - MATRIX_SERVER_NAME=mtrx.shaperotator.xyz
    - MATRIX_BOT_SECRET_KEY
    - MATRIX_BOT_HANDLE
    - MATRIX_SPACE_ROOM_ID=!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g
    - MATRIX_SIGNUP_URL=https://mtrx.shaperotator.xyz/signup/api
    - SHAPE_MATRIX_ENABLE_ONBOARDING=0
    - SHAPE_MATRIX_STARTUP_EVENT_GRACE_MS=5000
  volumes:
    - shape-matrix-bridge-data:/data
```

Do not pass `MATRIX_*` env vars to the public Router server service or the
public `router-agent` service for this deployment. `router-agent` must keep
`ROUTER_ENABLE_GATEWAY=0`. Only the bridge should log into Matrix or handle raw
Shape Matrix events. The direct `router-agent` event worker also skips Matrix
events unless `ROUTER_AGENT_HANDLES_MATRIX` is explicitly enabled; this Shape
deployment intentionally leaves that variable unset.

## Matrix Commands

The bridge responds to Matrix DMs and mentions:

```text
help
search <query>
save <text>
sync <text>
record <text>
summarize this room
summarize this room 7d
```

`search` uses the private Shape Router MCP `router_search` tool over the
Streamable HTTP endpoint at `/mcp/`. The live `/api` listing still advertises
legacy SSE for compatibility, but the Shape setup UI exposes `/mcp/` for modern
clients.

`save` / `sync` / `record` create private Shape Router entries with provenance:
Matrix room or DM, room ID, Matrix event ID, organizer/sender, and capture time.

`summarize this room` reads Matrix room history visible to the bot and saves a
private context entry to the private Shape Router. When `ANTHROPIC_API_KEY` is
available it includes an LLM summary; otherwise it falls back to an extractive
capture. LLM-backed summary entries still include source messages after the
summary so smoke tests and audits can verify the exact Matrix context that was
captured. It does not write the raw context to the public Router.

## Private-To-Public Boundary

Allowed in this bridge:

- Matrix room/DM event handling
- Private Shape Router search
- Private Shape Router entry creation
- Matrix replies that point to private Shape Router entries

Not allowed in this bridge:

- Public Router notebook writes
- Public Router searches for Shape Rotator answers
- Raw private Matrix transcript publication
- Public broadcaster behavior

Any public output must use a separate broadcaster identity and prompt/policy.

## Smoke Test

Full pre-deploy gate:

```bash
SHAPE_ROUTER_SECRET_KEY=<private Shape Router bot key> \
MATRIX_BOT_SECRET_KEY=<stable Matrix bot secret> \
MATRIX_BOT_HANDLE=<bot localpart> \
MATRIX_SMOKE_SIGNUP_CODE=<reserved Shape Matrix signup code> \
  npm --prefix server run shape:deploy-gate
```

This runs script syntax checks, the server test suite, the TypeScript build, a
local Docker server-image build plus bridge artifact check, a local Docker agent
image build plus Matrix-boundary guard check, private Router readiness, and the
live Matrix command smoke. The agent boundary check verifies that the public
`router-agent` skips Matrix onboarding/mention events before any Hermes call
unless `ROUTER_AGENT_HANDLES_MATRIX` is explicitly enabled. By default the live
smoke starts a local bridge
process from the built artifact. Override the local image tags with
`SHAPE_DEPLOY_GATE_SERVER_IMAGE` and `SHAPE_DEPLOY_GATE_AGENT_IMAGE` if needed.

Readiness wrapper for deploy verification:

```bash
SHAPE_ROUTER_SECRET_KEY=<private Shape Router bot key> \
SHAPE_PUBLIC_BOUNDARY_SENTINEL=<unique Matrix smoke phrase> \
MATRIX_BOT_SECRET_KEY=<stable Matrix bot secret> \
MATRIX_BOT_HANDLE=<bot localpart> \
MATRIX_SPACE_ROOM_ID=<Shape Rotator space room id> \
  npm --prefix server run shape:readiness
```

This command prints only whether secret-bearing env vars are present. It renders
both compose files, verifies that Matrix/private Shape Router env is isolated to
the `shape-matrix-bridge` service, verifies the public `router-agent` Matrix
boundary guard, runs the private Router HTTP smoke, checks the public Router
boundary for the optional sentinel phrase, and runs the bridge preflight without
starting Matrix sync.

Live Matrix command smoke:

```bash
SHAPE_ROUTER_SECRET_KEY=<private Shape Router bot key> \
MATRIX_BOT_SECRET_KEY=<stable Matrix bot secret> \
MATRIX_BOT_HANDLE=<bot localpart> \
MATRIX_SMOKE_SIGNUP_CODE=<reserved Shape Matrix signup code> \
  npm --prefix server run shape:matrix-live-smoke
```

The live smoke starts the bridge, creates or reuses a separate Matrix smoke
sender, sends Matrix `save`, `search`, and `summarize this room` commands,
creates a separate non-DM smoke room for explicit `@<bot> search <sentinel>`,
`@<bot> save <sentinel> ...`, and `@<bot> summarize this room ...` commands,
verifies private Router entries from both DM and room contexts, scans the public
Router for the unique sentinel, restarts the bridge, and confirms the private
entry count did not increase from duplicate replay. It writes temporary Matrix
credentials under `/tmp` unless `SHAPE_MATRIX_SMOKE_WORKDIR` or credential paths
are overridden.

To smoke an already-deployed bridge instead of starting a local one, add:

```bash
SHAPE_MATRIX_SMOKE_RUNNING_BRIDGE=1
```

That mode still sends Matrix commands, verifies private Router entries, and runs
the public Router boundary scan. It skips local startup and restart checks
because it does not own the deployed process lifecycle.

Basic unauthenticated private Router checks:

```bash
node scripts/shape-router-smoke.mjs
```

Authenticated bot-account write/read checks:

```bash
SHAPE_ROUTER_SECRET_KEY=<private Shape Router bot key> \
  node scripts/shape-router-smoke.mjs
```

Bridge preflight inside the built server image/process:

```bash
SHAPE_ROUTER_SECRET_KEY=<private Shape Router bot key> \
  node server/dist/shape-matrix-bridge.js --preflight
```

The preflight verifies `/api/me`, `/api/preset-tags`, patches the bot profile,
connects to private Router MCP at `/mcp/`, and calls `router_search`. It does
not start Matrix sync.

Public Router boundary check:

```bash
SHAPE_PUBLIC_BOUNDARY_SENTINEL=<unique Matrix smoke phrase> \
  node scripts/shape-public-boundary-smoke.mjs
```

The boundary check scans recent entries on `https://router.teleport.computer`
by default and fails if the Matrix smoke sentinel appears there. Use a unique
sentinel in the Matrix save/summary smoke so this check can prove that raw
private Matrix content did not land in the public Router. `PUBLIC_ROUTER_BASE_URL`
and `PUBLIC_ROUTER_SECRET_KEY` can override the target and include authenticated
public visibility if needed.

1. Verify private Router:

   ```bash
   curl -sS https://shaperotator.teleport.computer/health
   curl -sS https://shaperotator.teleport.computer/api/server-info
   ```

2. Verify bot key:

   ```bash
   curl -sS "https://shaperotator.teleport.computer/api/me?key=$SHAPE_ROUTER_SECRET_KEY"
   ```

3. Verify direct private write:

   ```bash
   curl -sS -X POST "https://shaperotator.teleport.computer/api/entries?key=$SHAPE_ROUTER_SECRET_KEY" \
     -H "Content-Type: application/json" \
     -d '{"summary":"Matrix bridge smoke test","content":"private Shape Router write test","tags":["shape-rotator","matrix"]}'
   ```

4. In Matrix, mention the bot:

   ```text
   @router search router
   @router save <unique Matrix smoke phrase> bridge smoke test from Matrix
   @router summarize this room 1h
   ```

5. Confirm the new entries appear only on:

   ```text
   https://shaperotator.teleport.computer
   ```

   Then confirm the same unique phrase does not appear on the public Router:

   ```bash
   SHAPE_PUBLIC_BOUNDARY_SENTINEL=<unique Matrix smoke phrase> \
     node scripts/shape-public-boundary-smoke.mjs
   ```

6. Restart `shape-matrix-bridge` and repeat a Matrix mention. The old Matrix
   event must not be replayed into a duplicate entry, and the restarted process
   must answer the new mention immediately. The bridge stores handled Matrix
   event IDs for duplicate prevention, but intentionally resets its in-memory
   Router event cursor on every process start.

## Rollback

To stop ingestion without changing Matrix rooms:

```bash
docker compose stop shape-matrix-bridge
```

To rotate the private Router key:

1. Generate or provision a new Shape Router bot key.
2. Update `SHAPE_ROUTER_SECRET_KEY`.
3. Restart `shape-matrix-bridge`.
4. Revoke/delete the old bot key if appropriate.

To rotate the Matrix device after stale crypto state, use a one-off recovery
deploy or temporary local container override:

```text
MATRIX_FRESH_CRYPTO=once
```

Then restart the bridge once and remove the flag after the marker is written.
Do not commit this flag to `docker-compose.template.yml` or
`docker-compose.deploy.yml`; the compose boundary checker intentionally rejects
it in normal deploy compose so an ordinary deploy cannot reset Matrix crypto by
accident.
