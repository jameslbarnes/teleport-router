"""Attach the read-only research archive to the existing #router-test newsletter.

Default: prepare a private local JSON file and print metadata for review.
--apply replaces only our archive attachment on the fixed bot-owned message.
It never changes the newsletter text or reads participants' messages.
"""
import argparse
import json
import secrets
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent/discord-phala"))
from cohort_archive import export_archive, validate_archive
from discord_archive import API, BOT, CHANNEL, MESSAGE, FILENAME, MAX_ARCHIVE, UA, NoRedirect, digest


def bot_token(path):
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.startswith("DISCORD_BOT_TOKEN="):
            token = line.partition("=")[2].strip().strip("\"'")
            if token and not any(c.isspace() for c in token):
                return token
    raise ValueError("Bot token missing")


def publish(data, token, opener=None):
    payload = json.dumps(validate_archive(data), ensure_ascii=False).encode()
    if len(payload) > MAX_ARCHIVE:
        raise ValueError("Archive exceeds attachment limit")
    filename = f"router-cohort-v1-{digest(data)}.json"
    opener = opener or urllib.request.build_opener(NoRedirect)
    url = f"{API}/channels/{CHANNEL}/messages/{MESSAGE}"
    headers = {"Authorization": "Bot " + token, "User-Agent": UA}
    with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
        message = json.load(response)
    if message.get("author", {}).get("id") != BOT or message.get("id") != MESSAGE or message.get("channel_id") != CHANNEL:
        raise ValueError("Wrong archive publisher")
    previous = message.get("attachments", [])
    if any(a.get("filename") == filename for a in previous):
        return {"changed": False, "issues": len(data["issues"])}
    retained = [{"id": a["id"], "filename": a["filename"]} for a in previous if not FILENAME.fullmatch(a.get("filename", ""))]
    retained.append({"id": 0, "filename": filename, "description": "Public research sources behind the Scaling Trust issues; no roster or chat history."})
    meta = json.dumps({"attachments": retained, "allowed_mentions": {"parse": []}}).encode()
    boundary = "router" + secrets.token_hex(16)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n".encode()
            + meta + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"{filename}\"\r\nContent-Type: application/json\r\n\r\n".encode()
            + payload + f"\r\n--{boundary}--\r\n".encode())
    headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    with opener.open(urllib.request.Request(url, data=body, method="PATCH", headers=headers), timeout=30) as response:
        updated = json.load(response)
    if updated.get("content") != message.get("content") or not any(a.get("filename") == filename for a in updated.get("attachments", [])):
        raise ValueError("Attachment update did not verify")
    return {"changed": True, "issues": len(data["issues"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cohort-root", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--bot-env", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    data = validate_archive(export_archive(args.cohort_root))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    if args.apply:
        if not args.bot_env:
            parser.error("--apply requires --bot-env")
        print(json.dumps(publish(data, bot_token(args.bot_env))))
    else:
        print(json.dumps({"prepared": True, "issues": len(data["issues"]), "bytes": len(json.dumps(data).encode()), "sha256": digest(data)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Archive preparation/update failed ({type(exc).__name__}); private details omitted.", file=sys.stderr)
        raise SystemExit(1) from None
