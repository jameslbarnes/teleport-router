"""Local Docker health probe. Emits no messages, keys, account ids or transcripts."""
import datetime as dt
import json
import os
import sys
from pathlib import Path


def healthy(home):
    try:
        state = json.loads((home / "gateway_state.json").read_text())
        age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(state["updated_at"])).total_seconds()
        return (Path(f"/proc/{int(state['pid'])}").is_dir()
                and 0 <= age < 180 and state.get("gateway_state") == "running"
                and state.get("platforms", {}).get("discord", {}).get("state") == "connected"
                and state.get("code_sha") == "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19")
    except (OSError, ValueError, KeyError, TypeError):
        return False


if __name__ == "__main__":
    sys.exit(0 if healthy(Path(os.environ["HERMES_HOME"])) else 1)
