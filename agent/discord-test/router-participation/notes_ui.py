"""The Discord side of notes.py: the memo reaction, the direct message a person sees before a note
is posted for them, and the channel message for the bot's own note. No rules live here.

A person's draft is shown only to that person, in a direct message. The bot's own note is shown in
the channel it came from, to the same people who will be able to read it in the group.
"""
from __future__ import annotations

import discord

from .notes import NOTE_EMOJI, Draft, OwnNote

QUIET = discord.AllowedMentions.none()


class NotesUI:
    def __init__(self, native, base_url: str, group_id, delay_seconds: float):
        self.native, self.base_url, self._group_id, self.delay = native, base_url.rstrip("/"), group_id, delay_seconds
        self.taker = None  # set once the NoteTaker exists

    @property
    def group(self) -> str:
        return "#" + (self._group_id() or "the group")

    def url(self, entry: dict) -> str:
        return f"{self.base_url}/e/{entry['id']}"

    async def _channel(self, channel_id: int):
        return self.native.get_channel(channel_id) or await self.native.fetch_channel(channel_id)

    # The memo on the source message: the only thing the channel sees of a personal note.
    async def mark(self, channel_id: int, message_id: int) -> None:
        await (await self._channel(channel_id)).get_partial_message(message_id).add_reaction(NOTE_EMOJI)

    async def unmark(self, channel_id: int, message_id: int) -> None:
        await (await self._channel(channel_id)).get_partial_message(message_id).remove_reaction(NOTE_EMOJI, self.native.user)

    async def cannot_message(self, channel_id: int, user_id: int) -> None:
        await (await self._channel(channel_id)).send(
            f"<@{user_id}> I can't send you direct messages, so I won't write notes for you. "
            "Allow direct messages from this server and I'll show you each note before it is posted.",
            allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, replied_user=False,
                                                     users=[discord.Object(id=user_id)]), suppress_embeds=True)

    # A note for one person ------------------------------------------------------
    def _draft_message(self, draft: Draft, note: str | None) -> dict:
        who = f"As @{draft.handle} · to {self.group}"
        embed = discord.Embed(description=draft.text[:4000])
        if draft.state == "dropped":
            return {"content": note or "This note was not posted.", "embed": None, "view": None}
        if draft.state == "posted":
            embed.set_footer(text=who)
            return {"content": f"Posted for you. [Open note]({self.url(draft.entry)})", "embed": embed,
                    "view": DraftView(self, draft)}
        if draft.state == "asking":
            embed.set_footer(text=f"{who} · nothing is posted unless you say so")
            return {"content": f"Worth keeping? I'd post this for you from <#{draft.channel_id}>.", "embed": embed,
                    "view": DraftView(self, draft)}
        embed.set_footer(text=who)
        when = f"The group sees it <t:{int(draft.post_at)}:t>." if not draft.requested else "Posting it now, as you asked."
        return {"content": f"I wrote this for you from <#{draft.channel_id}>. {when}" + (f"\n{note}" if note else ""),
                "embed": embed, "view": DraftView(self, draft)}

    async def show_draft(self, draft: Draft):
        """Returns the direct message, or None when this person cannot be messaged."""
        user = self.native.get_user(draft.user_id) or await self.native.fetch_user(draft.user_id)
        try:
            return await user.send(**self._draft_message(draft, None), allowed_mentions=QUIET)
        except discord.Forbidden:
            return None

    async def update_draft(self, draft: Draft, note: str | None) -> None:
        if draft.shown is not None:
            await draft.shown.edit(**self._draft_message(draft, note), allowed_mentions=QUIET)

    # The bot's own note about a discussion --------------------------------------
    def _announcement(self, note: OwnNote, state: str | None) -> dict:
        if state == "withdrawn":
            return {"content": "I withdrew the note I wrote about this discussion.", "embed": None, "view": None}
        names = ", ".join(sorted(note.people.values())[:8])
        embed = discord.Embed(description=note.text[:4000])
        embed.set_footer(text=f"By the bot, under its own name · to {self.group}" + (f" · mentions {names}" if names else ""))
        if state == "settled":
            return {"content": f"I wrote up this discussion for the group. [Open note]({self.url(note.entry)})",
                    "embed": embed, "view": None}
        return {"content": f"I wrote up this discussion for the group, under my own name. The group sees it <t:{int(note.until)}:t>.",
                "embed": embed, "view": OwnNoteView(self, note)}

    async def announce(self, note: OwnNote):
        return await (await self._channel(note.channel_id)).send(**self._announcement(note, None), allowed_mentions=QUIET)

    async def update_announcement(self, note: OwnNote, state: str | None) -> None:
        if note.shown is not None:
            await note.shown.edit(**self._announcement(note, state), allowed_mentions=QUIET)


class DraftView(discord.ui.View):
    """Buttons under a person's draft. The NoteTaker checks that whoever presses one is the draft's owner."""

    def __init__(self, ui: NotesUI, draft: Draft):
        super().__init__(timeout=86400 if draft.state == "posted" else ui.delay + 900)
        self.ui, self.draft = ui, draft
        if draft.state == "asking":
            self._button("Post", discord.ButtonStyle.primary, self.post)
            self._button("Edit", discord.ButtonStyle.secondary, self.edit)
            self._button("Skip", discord.ButtonStyle.secondary, self.delete)
        elif draft.state == "waiting":
            self._button("Delete", discord.ButtonStyle.danger, self.delete)
            self._button("Edit", discord.ButtonStyle.secondary, self.edit)
            self._button("Post now", discord.ButtonStyle.secondary, self.post)
        elif draft.state == "posted":
            self._button("Delete", discord.ButtonStyle.danger, self.delete)

    def _button(self, label, style, handler) -> None:
        button = discord.ui.Button(label=label, style=style)
        button.callback = handler
        self.add_item(button)

    async def post(self, interaction) -> None:
        await interaction.response.defer()
        await self.ui.taker.post_now(self.draft.id, interaction.user.id)

    async def delete(self, interaction) -> None:
        await interaction.response.defer()
        await self.ui.taker.discard(self.draft.id, interaction.user.id)

    async def edit(self, interaction) -> None:
        await interaction.response.send_modal(EditNote(self.ui, self.draft))


class EditNote(discord.ui.Modal):
    def __init__(self, ui: NotesUI, draft: Draft):
        super().__init__(title="Edit this note")
        self.ui, self.draft = ui, draft
        self.text = discord.ui.TextInput(label="Your note", style=discord.TextStyle.paragraph,
                                         default=draft.text[:4000], max_length=4000)
        self.add_item(self.text)

    async def on_submit(self, interaction) -> None:
        await interaction.response.defer()
        await self.ui.taker.edit(self.draft.id, interaction.user.id, str(self.text.value))


class OwnNoteView(discord.ui.View):
    def __init__(self, ui: NotesUI, note: OwnNote):
        super().__init__(timeout=ui.delay + 900)
        self.ui, self.note = ui, note
        button = discord.ui.Button(label="Leave my part out", style=discord.ButtonStyle.secondary)
        button.callback = self.leave_out
        self.add_item(button)

    async def leave_out(self, interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        answer = await self.ui.taker.leave_out(self.note.id, interaction.user.id)
        await interaction.followup.send(answer, ephemeral=True, allowed_mentions=QUIET)
