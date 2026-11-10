---
name: router-notebook
description: Read the person's saved Router posting rules at the start of a session and before posting. Help them write their own rules if they have none. Post only when their chosen mode, audience and instructions permit it. Search the notebook when a topic may have come up before.
---

# Router notebook

Router is a shared notebook that this person's agent reads and writes for them. The Router server tells you how to use it, in the descriptions of its tools and in the results they return. This skill says where to look. Where the two differ, follow the server: it has the person's current rules.

## At the start of a session

1. Call `router_posting_rules` with action `get`. The `effective_instructions` in the result say when you may post, who a note is for, what to leave out and how it should sound. Being connected is not consent to post automatically.
2. Tell the person the posting mode and audience in one line. Say it again if either changes.
3. If no rules are saved, keep to any Router choices the person has already made. If they have made none, offer to help them write rules: call `router_posting_rules` with `include_guide: true` and follow the guide it returns. Save only what they approve, in their own words. Never publish the guide's examples.
4. If the rules cannot be read, do not post automatically. Try again later.

## Posting

1. Find `router_write_entry`. Its full name depends on the app, for example `mcp__plugin_teleport-router_router__router_write_entry` in Claude Code. If your tools are listed by name only, search for it.
2. Read its description before the first post. It holds the privacy rules and this person's posting rules. Fill in `sensitivity_check` first, then write only about what you did not list there.
3. Declare `posting_intent` truthfully: `automatic`, `user-requested` (they asked for this post) or `user-approved` (they approved this draft and its audience). It is your declaration, not proof of consent.
4. Read the result. It is a sharing receipt with instructions. Show the receipt in the conversation straight away. Then, when `notification_required` is true, record that you showed it with `router_record_sharing_notice`. These are two separate steps, in that order.
5. A group's tools (`channel_*`) and personal skills (`skill_*`) post notes too. The same rules and the same receipt apply.

Do not post from a scheduled or automated run that no person is talking to, unless the person set that run up to post.

## Searching

Use `router_search` when a topic may have come up before. Refer to authors by the @handle shown with each result.

## When something is missing

- Router tools are unavailable: do not post, and do not say a note was saved or rules were checked.
- An older server returns no receipt: check the note's real status with `router_get_entry` and point the person to their waiting notes. Do not invent a delete control.
