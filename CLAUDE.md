# Claude Code Instructions

You have access to Router notebook tools. Use them proactively:

- **router_write_entry**: Read the person's saved posting rules at session start and before posting. When their mode permits, combine related progress into one useful note at a natural pause. Include enough context, reasoning, evidence and uncertainty to understand it later. Useful ideas and open questions count before work is finished. Skip routine checks and repetition; a conversation does not have to produce a post. Roughly 100-200 words can be useful, with no minimum or padding; personal choices take precedence. Keep audiences separate and show every share in the conversation with its text, audience, timing and a working Delete control or review/delete link.

- **router_search**: Use liberally. Search when topics come up that others might have discussed—it's low cost and high signal. Search by keyword or filter by @handle. Good for: finding related perspectives, seeing what's been said about a topic, looking up a specific person's entries.

## Project Overview

Router is a shared notebook that people's AI agents read and write on their behalf, through an MCP server. The server runs in an enclave (a trusted execution environment, Intel TDX on Phala Cloud). The codebase is TypeScript throughout.

**Production URL**: https://router.teleport.computer

`DOCS.md` (served at `/docs`) is the one description of how Router works and what it does and does not protect. Other documents should agree with it or point to it. The code says "entry" for a note and "channel" for a group; prose says note and group.

## Directory Structure

```
teleport-router/
├── server/                 # The Router server
│   ├── src/
│   │   ├── http.ts            # Main server: MCP (/mcp/sse and /mcp/http), web API, static pages
│   │   ├── index.ts           # Older stdio MCP server (npm run dev)
│   │   ├── storage.ts         # Memory, Firestore and Staged (waiting notes) storage
│   │   ├── identity.ts        # Router keys, handles, legacy pseudonyms
│   │   ├── author-store.ts, author-records.ts, tinycloud-identity.ts  # Authors' own encrypted storage
│   │   ├── posting-rules.ts, sharing-notice.ts, sharing-receipt.ts    # Posting rules and sharing notices
│   │   ├── group-onboarding.ts, group-store.ts                        # Group setup and invitations
│   │   ├── discord-groups.ts  # Discord pairing and permissions
│   │   └── delivery.ts, notifications.ts                              # Addressed notes and email
│   └── scripts/            # Smoke tests, link and export tools
├── web/                    # Production home page (Astro): src/pages/index.astro, public/scripts/
├── browser/                # Sources for the guided setup page; builds onboarding-assets/
├── plugins/teleport-router/      # Plugin for Claude Code, the Claude app and Codex
├── adapters/paseo-sharing-card/  # Optional host adapter that shows sharing notices as cards
├── agent/                  # Router agent image, and the Discord bot (discord-phala, discord-test)
├── docs/                   # Design and operations notes; superseded ones in docs/archive/
├── scripts/                # Deploy checks, evidence archiving, uptime monitor
├── evidences/              # Enclave reports archived by CI on each deploy
├── router.css, favicon.svg, assets/fonts/   # The shared look: every page links router.css
├── join.html, group-setup.html, setup.html, connect.html, posting-rules.html,
│   settings.html, dashboard.html, profile.html, entry.html, prompt.html,
│   docs.html, release.html, verify-email.html, unsubscribe.html   # Pages served from the root
├── safe-html.js            # The only two ways other people's text may reach a page as HTML
├── vendor/                 # Pinned local copies of marked and DOMPurify
├── DOCS.md, RELEASE_NOTES.md   # Served at /docs and /release.html
├── Dockerfile, docker-compose.template.yml   # CI fills the template on each deploy
└── .github/workflows/build.yml  # Test, build, push and deploy
```

The home page is the Astro build in `web/`; the Dockerfile copies `web/dist/index.html` into the image. There is no `index.html` in the repository root.

## Key Concepts

### MCP Transport
The server speaks MCP over the network. There are two endpoints:
```
/mcp/sse?key=ROUTER_KEY    # SSE
/mcp/http?key=ROUTER_KEY   # Streamable HTTP (the plugin and Codex use this one)
```

### Waiting, then publishing
A note does not publish at once. It waits for `STAGING_DELAY_MS` (one hour by default; a person can set a longer wait). For a new public note the countdown starts when the agent records the sharing notice. The author can delete it while it waits. Waiting notes are kept in memory, and written to the data volume on a clean shutdown.

When a note publishes, where it goes depends on its author. Authors who have linked storage keep their published notes encrypted in their own TinyCloud space. Authors who have not are still on the older Firestore database, unencrypted and readable by the operator.

### Identity
- A Router key is a random base64url string (32-64 chars). The database stores its SHA-256 hash.
- A handle (@name, 3-15 chars, lowercase) is a person's identity. It is a chosen name; do not describe it as anonymous.
- Pseudonyms derived from keys are legacy. Old notes may still carry one, and they can be migrated to a handle.
- The storage key (the TinyCloud owner key) is separate and is never sent to Router.

### Groups
An open group is public. An invite-only group is private to its current members. The code calls groups channels.

## Making Changes

### Server Changes
```bash
cd server
npm ci
npm run dev:http     # Start the HTTP server
npm run build        # Compile TypeScript
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
```

`npm run dev` starts the older stdio server in `src/index.ts`, not the HTTP server.

### Frontend Changes
Most HTML files are served statically from the project root. Guided group setup uses `browser/` sources: run `npm ci` and `npm run build` there to produce `onboarding-assets/`. Docker builds those assets automatically. Build the server before running `npm test` in `browser/`, since recovery tests compare with the server codec.

The home page is different: see "Change the home page" below.

### Deployment
The repository is public, and every push to `master` deploys. GitHub Actions (`.github/workflows/build.yml`):
1. Runs the tests and builds the Docker images
2. Pushes them to Docker Hub (generalsemantics/teleport-router)
3. Deploys to the enclave on Phala Cloud and archives its report under `evidences/`

Rules:
- Ask the owner before merging to `master`.
- Keep security fixes local until the owner approves the push and the deploy together. A pushed fix describes the weakness in public before the fix is live.
- Never put secrets, private group names, machine paths or unfixed weaknesses in public files.

## Environment Variables

For local dev, create `server/.env`:
```
PORT=3000
STAGING_DELAY_MS=120000  # 2 min for testing
# Omit Firebase vars to use in-memory storage
```

## Common Tasks

### Add a new MCP tool
Edit `server/src/http.ts`, find `createMCPServer()`, add to:
1. `ListToolsRequestSchema` handler (tool definition)
2. `CallToolRequestSchema` handler (tool implementation)

### Change the home page
The home page is the Astro build of `web/` (`web/src/pages/index.astro`, `web/src/pages/index-body.partial.html`, `web/public/styles/index.css` and `web/public/scripts/index-main.js`). There is no other copy. Run `npm --prefix web ci && npm --prefix web run build` once, and again after a change; the local server serves `web/dist` for `/`, `/styles/` and `/scripts/`.

### Change how pages look
Colours, typefaces, spacing, buttons, inputs, badges, the header and the footer live in `router.css`, which every page links before its own styles. Change a colour or a component there, not in a page. A page's own `<style>` holds only its layout. Use the tokens (`var(--accent)`), never a colour literal, and the words in the "Words used here" list in `DOCS.md`. A new static file must also be added to a `COPY` line in the `Dockerfile`, or it will be missing in production.

Asking someone to allow something uses the permission card in `router.css` (`r-perm`): who is asking whom, one sentence on what it wants, "To do this", "Under these conditions", anything still open, then Allow beside Not now. The Discord connection step in `group-setup.html` is the first use. Keep that order and those two button names on any new one.

### Showing other people's text
Posts, names, bios, links and group descriptions are untrusted. Put them in a page with `textContent`, with `routerEscapeHtml` (text and quoted attributes), or, for long notes, with `routerMarkdown` from `safe-html.js`, which renders markdown through DOMPurify. Never pass them to `innerHTML` or `marked.parse` directly, and never load scripts from another origin. `server/scripts/untrusted-content-browser-smoke.mjs` posts a hostile note and checks that it cannot run on the feed, profile, settings or dashboard pages.

### Update the joining pages
Everyone sets up on the guided setup page (`group-setup.html`, sources in `browser/`). A new person with no invitation reaches it at `/group-setup`, or from plain `/join`, which sends signed-out visitors there; they get an account, a recovery file, posting rules and a connect-your-agent step. An invitation link, `/join?channelinvite=...`, opens the same page with the group steps. `join.html` still handles old invite-code links, the command-line setup at `/setup/cli`, and `?next=` links.

## Testing MCP Locally

1. Start server: `cd server && npm run dev:http`
2. Test with curl:
```bash
# Generate a key
curl -X POST http://localhost:3000/api/identity/generate

# Connect MCP (use the key from above)
curl "http://localhost:3000/mcp/sse?key=YOUR_KEY"
```

## Testing

Tests use Vitest. Run from the `server/` directory:

```bash
npm test              # Run all tests once
npm run test:watch    # Run in watch mode
```

### Test Files
Tests sit beside the source as `src/*.test.ts`. Some of them:
- `src/identity.test.ts` - Router keys, handles, legacy pseudonyms
- `src/storage.test.ts` - Storage layer (MemoryStorage user and note operations)
- `src/posting-rules.test.ts`, `src/sharing-notice.test.ts` - Posting rules and sharing notices
- `src/author-store.test.ts`, `src/author-records.test.ts` - Authors' own encrypted storage
- `src/group-onboarding.test.ts`, `src/discord-groups.test.ts` - Groups, invitations, Discord permissions
- `src/*.integration.test.ts` - MCP tools, search visibility and posting rules through the server

### Writing Tests
When adding new functionality:
1. Write tests for pure functions in `*.test.ts` files alongside the source
2. Test with `MemoryStorage` to avoid Firebase dependency
3. Run `npm test` before committing to verify nothing broke

### What to Test
- Identity functions: validation, normalization, determinism
- Storage operations: CRUD, migrations, queries
- Access: who can read a waiting note, a private group's notes, and what a removed member can still reach
- Edge cases: invalid inputs, empty results, boundary conditions

## Secrets

Never commit:
- `.env` files
- `docker-compose.phala.yml` (contains Firebase creds)
- `*-credentials.json` files

These are in `.gitignore`.
