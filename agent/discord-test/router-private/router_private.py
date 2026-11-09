"""Scoped private notes. No personal identity keys, chat history, or note cache."""
import asyncio
import json
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class PrivateError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PrivateRouter:
    def __init__(self, settings, state_dir, bot_key, request=None):
        self.settings = settings
        self.scope = settings.get("scope", "channel")
        snowflake = lambda value: isinstance(value, str) and re.fullmatch(r"\d{16,22}", value)
        if (not snowflake(settings.get("guild_id")) or self.scope not in ("channel", "guild")
                or (self.scope == "channel" and not snowflake(settings.get("channel_id")))
                or (self.scope == "guild" and "channel_id" in settings)):
            raise ValueError("Choose one Discord channel or guild scope; a guild binding has no channel_id.")
        if (self.scope == "guild" or "group_id" in settings) and not re.fullmatch(
                r"[a-z0-9][a-z0-9-]{0,28}[a-z0-9]", str(settings.get("group_id", ""))):
            raise ValueError("Invalid private Router group ID.")
        self.state_dir = Path(state_dir)
        self.bot_key = bot_key
        self.lock = asyncio.Lock()
        self.request = request or self._http_request
        parsed = urllib.parse.urlsplit(settings["base_url"])
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost"))) or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("Router base URL must be HTTPS (or loopback for tests)")

    def actor(self, interaction):
        channel_id = str(interaction.channel_id or "")
        if (str(interaction.guild_id or "") != self.settings["guild_id"]
                or not re.fullmatch(r"\d{16,22}", channel_id)
                or (self.scope == "channel" and channel_id != self.settings["channel_id"])
                or getattr(interaction.user, "bot", True)):
            raise PrivateError("Private note commands are not connected to this Discord channel.")
        user_id = str(interaction.user.id)
        if not re.fullmatch(r"\d{16,22}", user_id):
            raise PrivateError("A Discord member account is required.")
        return {"guildId": self.settings["guild_id"], "channelId": channel_id, "discordUserId": user_id}

    def check_group(self, link):
        if self.settings.get("group_id") and link.get("groupId") != self.settings["group_id"]:
            raise PrivateError("This permission belongs to a different Router group. Link to this server's configured group first.")

    def _load(self):
        try:
            data = json.loads((self.state_dir / "links.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(data, dict):
            raise PrivateError("Private group links could not be loaded.")
        return data

    def _store(self, data):
        # StateHome is ACL-restricted on Windows; POSIX installations additionally get 0700/0600.
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.state_dir / ("links-" + secrets.token_hex(8) + ".tmp")
        try:
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.state_dir / "links.json")
        finally:
            temporary.unlink(missing_ok=True)

    async def _http_request(self, path, payload):
        if not self.bot_key:
            raise PrivateError("The Router bot connection is unavailable.")
        def call():
            req = urllib.request.Request(self.settings["base_url"].rstrip("/") + "/api/discord/" + path,
                data=json.dumps(payload).encode("utf-8"), method="POST",
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.bot_key})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            try:
                with opener.open(req, timeout=25) as response:
                    result = response.read(200000)
                    return json.loads(result)
            except urllib.error.HTTPError as exc:
                # Only the fixed Router API's bounded error message may reach Discord, never request details.
                try:
                    message = json.loads(exc.read(4096)).get("error", "Private group request failed.")
                except (ValueError, AttributeError):
                    message = "Private group request failed."
                if not isinstance(message, str) or len(message) > 300:
                    message = "Private group request failed."
                raise PrivateError(message) from None
            except (urllib.error.URLError, TimeoutError, ValueError):
                raise PrivateError("Router could not confirm the request. Please retry; no success is assumed.") from None
        return await asyncio.to_thread(call)

    async def link(self, interaction, code):
        actor = self.actor(interaction)
        if not re.fullmatch(r"RD-LINK-[A-Za-z0-9_-]{32}", code.strip()):
            raise PrivateError("Use the one-time linking code from your Router account, never an identity key.")
        # Serialize exchanges and file writes so concurrent links cannot replace each other's state.
        async with self.lock:
            result = await self.request("link/complete", {**actor, "code": code.strip()})
            if not isinstance(result.get("grant"), str) or not result["grant"].startswith("rdg1."):
                raise PrivateError("Router did not return a valid private group permission.")
            self.check_group(result)
            links = self._load()
            links[actor["discordUserId"]] = {key: result[key] for key in ("grant", "handle", "groupId", "expiresAt")}
            self._store(links)
        return {key: result[key] for key in ("handle", "groupId", "expiresAt")}

    async def begin_pair(self, interaction):
        actor = self.actor(interaction)
        group = self.settings.get("group_id")
        if not group:
            raise PrivateError("Your host needs to select this server's Router group before browser linking is available.")
        result = await self.request("pair/start", {**actor, "groupId": group,
            "displayName": str(getattr(interaction.user, "display_name", "Discord member"))[:100]})
        token = result.get("pairing", "")
        expected = self.settings["base_url"].rstrip("/") + "/group-setup?group=" + group + "#discord-pair=" + token
        if not re.fullmatch(r"RD-PAIR-[A-Za-z0-9_-]{32}", token) or result.get("url") != expected:
            raise PrivateError("Router did not return a valid account connection link.")
        return result

    async def wait_pair(self, interaction, pairing, timeout=560, poll_seconds=4):
        actor = self.actor(interaction)
        payload = {**actor, "groupId": self.settings.get("group_id"), "pairing": pairing}
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            result = await self.request("pair/poll", payload)
            if result.get("status") == "approved":
                if not isinstance(result.get("grant"), str) or not result["grant"].startswith("rdg1."):
                    raise PrivateError("Router did not return a valid private group permission.")
                self.check_group(result)
                # Acknowledge only after durable storage. A failed write leaves the exchange retriable.
                async with self.lock:
                    links = self._load()
                    links[actor["discordUserId"]] = {field: result[field] for field in ("grant", "handle", "groupId", "expiresAt")}
                    self._store(links)
                await self.request("pair/ack", payload)
                return {field: result[field] for field in ("handle", "groupId", "expiresAt")}
            if result.get("status") != "waiting":
                raise PrivateError("This connection has already finished. Use /router-status to check it.")
            await asyncio.sleep(min(poll_seconds, max(0, deadline - asyncio.get_running_loop().time())))
        raise PrivateError("The connection link expired. Use /router-link again when you are ready.")

    async def operate(self, interaction, action, **fields):
        actor = self.actor(interaction)
        async with self.lock:
            link = self._load().get(actor["discordUserId"])
        if not link:
            raise PrivateError("Link your Router account with /router-link before using private notes.")
        self.check_group(link)
        result = await self.request("operate", {**fields, **actor, "action": action, "grant": link["grant"]})
        # Older APIs confirm saves without returning the group. The grant used for this
        # operation already fixes it; do not turn a successful write into a retry prompt.
        if action == "save" and "groupId" not in result:
            result = {**result, "groupId": link["groupId"]}
        if action == "unlink":
            async with self.lock:
                links = self._load()
                if links.get(actor["discordUserId"], {}).get("grant") == link["grant"]:
                    links.pop(actor["discordUserId"], None)
                    self._store(links)
        return result

    async def save(self, interaction, note):
        return await self.operate(interaction, "save", content=note, interactionId=str(interaction.id))

    async def recall(self, interaction, query, summarize):
        found = await self.operate(interaction, "search", query=query)
        entries = found.get("entries", [])[:4]
        if not entries:
            return {"text": "No matching notes are currently available in this private group.", "entries": []}
        # Only the freshly authorized records enter the stateless model call. No Hermes history.
        text = await summarize(query, [{"number": i + 1, "author": e.get("handle") or e["pseudonym"],
            "content": e["content"][:5000]} for i, e in enumerate(entries)])
        # Check again after inference: membership/permissions or source records may have changed.
        for entry in entries:
            current = await self.operate(interaction, "read", entryId=entry["id"])
            if current.get("entry") != entry:
                raise PrivateError("The notes changed during recall. Please try again.")
        return {"text": text, "entries": entries}

    def source_url(self, entry):
        if not re.fullmatch(r"[\w-]{1,160}", str(entry.get("id", ""))):
            raise PrivateError("Invalid source reference.")
        # Construct citations locally; neither the model nor a note controls the destination URL.
        return self.settings["base_url"].rstrip("/") + "/e/" + entry["id"]
