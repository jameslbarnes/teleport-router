"""
Repro user — registers/logs in on hs-b, accepts pending invites, syncs
continuously, and emits one JSON line per decrypted-or-failed encrypted
event seen.

Stdout protocol:
  {"event": "ready", "user_id": "..."}
  {"event": "invite", "room_id": "..."}            # pending invite seen
  {"event": "joined", "room_id": "..."}            # joined a room
  {"event": "decrypt_ok", "room_id": "...", "body": "..."}
  {"event": "decrypt_fail", "room_id": "...", "reason": "..."}
  {"event": "exit"}

Stdin protocol (one JSON object per line, optional driver control):
  {"cmd": "join", "room_id": "..."}                 # join a specific room (e.g. via invite alias)
  {"cmd": "exit"}

Run: pip install matrix-nio[e2e]; python user.py
Env:
  FED_REPRO_HS_B_URL   default http://localhost:8002
  FED_REPRO_USER       default repro-user-<pid>
  FED_REPRO_USER_PASS  default same-as-USER
  FED_REPRO_TOKEN      default fedrepro
"""
import asyncio, json, os, sys
from nio import (
    AsyncClient, AsyncClientConfig, LoginResponse, RoomMessageText,
    InviteMemberEvent, MegolmEvent, RegisterResponse,
)
import aiohttp

HS_URL  = os.environ.get("FED_REPRO_HS_B_URL", "http://localhost:8002")
USER    = os.environ.get("FED_REPRO_USER",    f"repro-user-{os.getpid()}")
PASS    = os.environ.get("FED_REPRO_USER_PASS", USER)
TOKEN   = os.environ.get("FED_REPRO_TOKEN",   "fedrepro")
STORE   = os.environ.get("FED_REPRO_USER_STORE", f"/tmp/fed-repro-user-{os.getpid()}")


def emit(obj):
    print(json.dumps(obj), flush=True)


async def register_or_login(hs_url: str, user: str, password: str, token: str) -> str | None:
    """Returns access_token via UI-auth registration with token, or login if user exists."""
    async with aiohttp.ClientSession() as s:
        # Try login first
        async with s.post(f"{hs_url}/_matrix/client/v3/login", json={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": user},
            "password": password,
        }) as r:
            if r.status == 200:
                return user  # login worked, fall through to nio login
        # Register via UIA registration_token
        async with s.post(f"{hs_url}/_matrix/client/v3/register", json={
            "username": user, "password": password,
        }) as r:
            init = await r.json()
        async with s.post(f"{hs_url}/_matrix/client/v3/register", json={
            "username": user, "password": password,
            "auth": {
                "type": "m.login.registration_token",
                "token": token,
                "session": init.get("session"),
            },
        }) as r:
            data = await r.json()
            if r.status != 200:
                emit({"event": "register_fail", "status": r.status, "body": data})
                return None
        return user


async def main():
    os.makedirs(STORE, exist_ok=True)
    await register_or_login(HS_URL, USER, PASS, TOKEN)

    config = AsyncClientConfig(
        store_sync_tokens=True,
        encryption_enabled=True,
    )
    client = AsyncClient(HS_URL, f"@{USER}:hs-b", store_path=STORE, config=config)
    resp = await client.login(PASS, device_name="fed-repro-user")
    if not isinstance(resp, LoginResponse):
        emit({"event": "login_fail", "resp": str(resp)})
        return
    emit({"event": "ready", "user_id": resp.user_id, "device_id": resp.device_id})

    if client.should_upload_keys:
        await client.keys_upload()

    async def on_invite(room, event):
        emit({"event": "invite", "room_id": room.room_id, "from": event.sender})
        # Auto-accept
        try:
            await client.join(room.room_id)
            emit({"event": "joined", "room_id": room.room_id})
        except Exception as e:
            emit({"event": "join_fail", "room_id": room.room_id, "err": str(e)})

    async def on_text(room, event):
        emit({"event": "decrypt_ok",
              "room_id": room.room_id,
              "body": event.body,
              "sender": event.sender,
              "event_id": event.event_id})

    async def on_megolm_undecryptable(room, event):
        emit({"event": "decrypt_fail",
              "room_id": room.room_id,
              "event_id": event.event_id,
              "sender": event.sender,
              "reason": "megolm — no session key"})

    client.add_event_callback(on_text, RoomMessageText)
    client.add_event_callback(on_megolm_undecryptable, MegolmEvent)
    client.add_event_callback(on_invite, InviteMemberEvent)

    await client.sync_forever(timeout=10000, full_state=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        emit({"event": "exit"})
