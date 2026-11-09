"""Prepare the immutable Discord profile, then replace this process with Hermes.

There is no management listener or state export. Stop the Tulip gateway before
deploying this service. Conversation history starts afresh; Discord backfill
provides recent context and never triggers a participation check by itself.
"""
import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent


def prepare(home: Path, env):
    home.mkdir(parents=True, exist_ok=True)
    for name in ("config.yaml", "SOUL.md"):
        (home / name).write_bytes((ROOT / name).read_bytes())
    plugins = home / "plugins"
    plugins.mkdir(exist_ok=True)
    for name in ("router-private", "router-participation"):
        dest = plugins / name
        expected = ROOT / "plugins" / name
        if dest.is_symlink() and dest.resolve() == expected.resolve():
            continue
        if dest.exists() or dest.is_symlink():
            raise ValueError("Unexpected mutable plugin directory")
        dest.symlink_to(expected, target_is_directory=True)
    # This optional one-time seed contains scoped author grants, never personal keys.
    # Existing links always win on later deploys; unlinking must stay unlinked.
    marker = home / ".links-seeded"
    seed = env.pop("DISCORD_INITIAL_LINKS_B64", "")
    if not marker.exists():
        target = home / "plugin-data/router-private/links.json"
        if seed and not target.exists():
            if len(seed) > 32000:
                raise ValueError("Link seed too large")
            data = json.loads(base64.b64decode(seed, validate=True))
            if not isinstance(data, dict):
                raise ValueError("Invalid link seed")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data), encoding="utf-8")
        if target.exists():
            marker.touch()
    aliases = {"DISCORD_MODEL_API_KEY": "ANTHROPIC_API_KEY",
               "DISCORD_PUBLIC_ROUTER_KEY": "ROUTER_SECRET_KEY",
               "DISCORD_PRIVATE_ROUTER_KEY": "ROUTER_PRIVATE_SECRET_KEY"}
    for source, dest in aliases.items():
        value = env.pop(source, "")
        if not value:
            raise ValueError("Missing bot credential")
        env[dest] = value
    if not env.get("DISCORD_BOT_TOKEN"):
        raise ValueError("Missing bot credential")
    # stdio MCP deliberately inherits a small environment. Give only the
    # Discord credential to this read-only attachment reader, not Router keys.
    token_file = home.parent / "cohort-discord.token"
    token_file.write_text(env["DISCORD_BOT_TOKEN"], encoding="utf-8")
    token_file.chmod(0o600)


def main():
    os.umask(0o077)
    env = dict(os.environ)
    prepare(Path(env["HERMES_HOME"]), env)
    command = ["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--external-supervisor"]
    os.execve(command[0], command, env)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Discord startup failed ({type(exc).__name__}); private details omitted.", file=sys.stderr)
        raise SystemExit(1) from None
