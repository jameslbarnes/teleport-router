> Archived 2026-11-10. This is a historical design note and no longer describes how Router works. The current description is [DOCS.md](../../DOCS.md).

# Router Identity Model

Design conversation captured January 2026.

## Core Decisions

### Identity
- **Twitter model**: Everyone picks a handle to write. No anonymous mode.
- **Pseudonymous**: Handles don't have to be real names (@whatever is fine)
- **Multiple alts**: New key = new handle if you want
- **Profiles**: Handle, display name, bio, external links, follower/following counts

### Following
- **Claude-managed**: Claude follows people autonomously based on conversation relevance
- **Ambient**: No permission needed, just happens in background
- **In tool description**: Claude sees who you follow + their recent activity summaries
- **Tools**: `follow(handle)`, `unfollow(handle)`, `get_profile(handle)`

### Groups (Later)
- **Routing, not privacy**: Groups help Claude know where to search for topics
- **Emergent descriptions**: Auto-summarize what group members write about
- **Human seed + AI summary**: Creator sets intent, activity fills in the rest
- **Built on following**: Can derive from follow patterns

### Visibility
- **Everything public**: Following and groups are about relevance, not access control
- **Twitter got this right**: No need to reinvent

### Messaging
- **Email-native**: Messages delivered via email, reply to respond
- **Deep links optional**: "Discuss with Claude" links for richer interaction
- **Triggered by content**: Often sparked by seeing someone's public entry

## The Client (Email-First)

### Morning Digest
- AI-generated daily newsletter
- Personalized to your social graph
- Summarizes network activity overnight
- Deep links into Claude/ChatGPT for each item
- **The email IS the product**

### Deep Links
- Each digest item links to Claude with pre-loaded prompt
- "Discuss with Claude" opens conversation with full context
- Prompts as capability tokens (different prompts = different permissions)

### Why Email
- Universal (everyone has it)
- No app to build initially
- Notifications solved
- Messaging solved (reply to email)
- Deep links handle AI interactions

## New MCP Tools

```
follow(handle)        — Follow someone (Claude uses autonomously)
unfollow(handle)      — Unfollow someone
get_profile(handle)   — View someone's profile, bio, recent activity
```

## Modified Tools

- `search_notebook` — Results annotated with relationship (★ = you follow)
- `write_*` — Entries attributed to @handle
- Tool descriptions include: who you follow, their recent summaries

## User Stories

1. **Claiming handle**: Pick @name at setup, that's your identity
2. **Ambient following**: Claude follows relevant people without asking
3. **Morning digest**: Email arrives, deep links into Claude for each item
4. **Discovering connections**: Claude notices @andrew on Router = Andrew you mentioned
5. **Messaging from search**: See interesting entry, message the author
6. **Alts**: New key, new handle if you want separation

## Open Questions

- Twitter cross-posting? (Curated @router_ing account vs user opt-in)
- Follow limits? (Solve when it's a problem)
- Email deliverability / reply parsing (execution risk)
- Deep link format for Claude/ChatGPT

## Priority Order

1. Identity (handles, profiles)
2. Following (Claude-managed)
3. Email digest (morning newsletter)
4. Messaging (email-native)
5. Groups (later, routing layer on following)
