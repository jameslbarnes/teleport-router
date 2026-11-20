# Router activity in an existing Discord digest

`router_digest.run` prepares a daily or weekly section from published Router notes. It does not schedule itself. Call it at the start of the existing digest job, before fetching outside research or applying minimum-item thresholds. Supply `post=False` for a draft; scheduled delivery needs `post=True` and a `send(text)` function returning the Discord message ID and URL.

The configuration has `base_url`, `group_id`, `guild_id` and `channel_id`. Use the connected group's ordinary bot key. Keep credentials and real destinations outside this repository. The sender must target that exact channel, suppress link previews, and set `allowed_mentions.parse` to an empty list. Deploy the server endpoint before enabling the producer.

The daily period is the previous UTC calendar day; the weekly period is the previous seven days, ending at midnight on the issue date. The server permits only a bot that is currently a member and bound to that group. The channel must already be enabled for conversations or the group's feed, and every viewer except the bot must be a currently linked group member. Its checks use Discord's actual channel audience.

The writer uses Claude without tools and sees only the returned notes. It does not send private notes to web search. It links each point to supplied source IDs and verifies **all notes it read**, including uncited ones, immediately before each delivery. This checks source versions and access, not the truth of a model's paraphrase.

Drafts, summaries and source versions live under `<root>/digests/router/`. Keep that directory out of the public research archive and the outside-research composer's history. Raw note bodies are not saved. Completed editions are skipped on a rerun. A partially sent edition resumes only from messages whose successful sends were recorded. An uncertain send result stops: inspect Discord and reconcile the delivery record before retrying. A leftover `.lock` after a killed process likewise requires reconciliation before removal.

An empty successful read produces a short no-activity section. An unavailable read, changed source or changed audience stops delivery with an error. The server rejects periods exceeding its scan or note limits rather than claiming complete coverage. Discord keeps summaries already sent; later edits and deletions in Router do not remove those copies.

Run `python -m unittest -v test_router_digest` in this directory. Server access and source checks are covered in `server/src/discord-groups.test.ts`.
