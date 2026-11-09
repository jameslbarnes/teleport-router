"""Fetch the published research archive attached to the bot's existing newsletter.

No human messages are scanned. Only the fixed bot-authored message and its
one checksummed JSON attachment are read. Discord already hosts the newsletter;
this keeps the producer on Tulip without opening an admin port on Phala.
"""
import hashlib
import json
import os
import re
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from cohort_archive import validate_archive

CHANNEL = "1568051571751788644"
MESSAGE = "1568776784294576190"
BOT = "1568056630380200118"
API = "https://discord.com/api/v10"
UA = "DiscordBot (https://github.com/jameslbarnes/teleport-router, 0.2)"
FILENAME = re.compile(r"^router-cohort-v1-([0-9a-f]{64})\.json$")
MAX_ARCHIVE = 8 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, limit, token=None):
    headers = {"User-Agent": UA}
    if token:
        headers["Authorization"] = "Bot " + token
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        content = response.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Response too large")
        return content


def attachment(message):
    if (message.get("id") != MESSAGE or message.get("channel_id") != CHANNEL
            or message.get("author", {}).get("id") != BOT):
        raise ValueError("Wrong archive publisher")
    matches = [a for a in message.get("attachments", []) if FILENAME.fullmatch(a.get("filename", ""))]
    if len(matches) != 1:
        raise ValueError("Archive attachment is missing or ambiguous")
    item = matches[0]
    if not isinstance(item.get("size"), int) or not 0 < item["size"] <= MAX_ARCHIVE:
        raise ValueError("Invalid archive size")
    url = urllib.parse.urlsplit(item["url"])
    if (url.scheme != "https" or url.hostname != "cdn.discordapp.com" or url.port is not None
            or url.username or url.password or url.fragment
            or not url.path.startswith(f"/attachments/{CHANNEL}/")):
        raise ValueError("Invalid attachment URL")
    return item, FILENAME.fullmatch(item["filename"]).group(1)


def digest(data):
    # The export time can change without any sources changing.
    body = json.dumps(data["issues"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(body).hexdigest()


def load(cache=Path("/data/cohort.json"), token_file=Path("/data/cohort-discord.token"), fetcher=fetch):
    if cache.exists() and 0 <= time.time() - cache.stat().st_mtime < 60:
        return validate_archive(json.loads(cache.read_text(encoding="utf-8")))
    token = token_file.read_text(encoding="utf-8").strip()
    message = json.loads(fetcher(f"{API}/channels/{CHANNEL}/messages/{MESSAGE}", 512 * 1024, token))
    item, expected = attachment(message)
    # Fetch the CDN URL without the bot credential and without following redirects.
    payload = fetcher(item["url"], MAX_ARCHIVE)
    if len(payload) != item["size"]:
        raise ValueError("Incomplete archive")
    data = validate_archive(json.loads(payload))
    if digest(data) != expected:
        raise ValueError("Archive checksum mismatch")
    cache.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".cohort-", dir=cache.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False)
        os.replace(temporary, cache)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return data
