"""The door to the server. Only people whose Discord account is linked to the Router group hold the
member role, and the server shows its channels to that role alone. Someone who has just joined sees the
welcome channel, is told to run /router-link there, and gets the role when the link completes.

This keeps the server tidy; it is not the privacy check. Router itself reads who can see a channel
before any group note is used, and refuses if one of them is not linked.
"""
import datetime
import logging
import time

log = logging.getLogger(__name__)


class Gate:
    def __init__(self, role_id, membership, list_members, add_role, remove_role, greet,
                 now=time.time, recheck_s=300, greet_window_s=900):
        self.role_id = str(role_id)
        self.membership, self.list_members = membership, list_members
        self.add_role, self.remove_role, self.greet = add_role, remove_role, greet
        self.now, self.recheck_s, self.greet_window_s = now, recheck_s, greet_window_s
        self.known = {}      # Discord user ID -> (time asked, linked?)
        self.greeted = set()

    async def admit(self, user_id):
        """A link has just completed."""
        self.known[str(user_id)] = (self.now(), True)
        await self._change(self.add_role, user_id)

    async def dismiss(self, user_id):
        """A person has just withdrawn their link."""
        self.known[str(user_id)] = (self.now(), False)
        await self._change(self.remove_role, user_id)

    async def _change(self, action, user_id):
        try:
            await action(str(user_id))
            return True
        except Exception as exc:
            # Usually a missing Manage Roles permission, or the member role sitting above the bot's own.
            log.warning("The member role could not be changed (%s); no account details logged.", type(exc).__name__)
            return False

    async def _linked(self, user_id):
        asked = self.known.get(user_id)
        if asked and self.now() - asked[0] < self.recheck_s:
            return asked[1]
        try:
            linked = await self.membership(user_id)
        except Exception as exc:
            log.warning("A link could not be checked (%s); no account details logged.", type(exc).__name__)
            linked = None
        if linked is None:
            # Router did not answer. Keep nothing, change nothing, ask again on the next pass.
            self.known.pop(user_id, None)
        else:
            self.known[user_id] = (self.now(), linked)
        return linked

    def _just_joined(self, member):
        try:
            joined = datetime.datetime.fromisoformat(str(member.get("joined_at")).replace("Z", "+00:00"))
            return 0 <= self.now() - joined.timestamp() < self.greet_window_s
        except (TypeError, ValueError):
            return False

    async def sweep(self):
        """One pass over the server: give the role to linked people, take it from the rest, greet arrivals."""
        present = set()
        for member in await self.list_members():
            user = member.get("user") or {}
            user_id = str(user.get("id") or "")
            if not user_id or user.get("bot"):
                continue
            present.add(user_id)
            has_role = self.role_id in [str(r) for r in member.get("roles") or []]
            linked = await self._linked(user_id)
            if linked is True and not has_role:
                await self._change(self.add_role, user_id)
            elif linked is False and has_role:
                await self._change(self.remove_role, user_id)
            elif linked is False and user_id not in self.greeted and self._just_joined(member):
                self.greeted.add(user_id)
                try:
                    await self.greet(user_id)
                except Exception as exc:
                    log.warning("A welcome could not be posted (%s); no account details logged.", type(exc).__name__)
        for gone in [u for u in self.known if u not in present]:
            del self.known[gone]
        self.greeted &= present
