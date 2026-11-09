"""Boot the actual immutable gateway, offline, under the Phala service's limits.

Synthetic credentials and no network: this tests packaging/startup/memory, not
a Discord reply. Native commands and model behavior have separate plugin tests.
"""
import json
import subprocess
import time

NAME = "router-discord-smoke"


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)


try:
    docker("create", "--name", NAME, "--network", "none", "--memory", "512m", "--memory-swap", "512m",
           "--cpus", "0.5", "--pids-limit", "128", "--read-only", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges", "--init", "--tmpfs", "/tmp:rw,size=64m,mode=1777", "--volume", "/data",
           "-e", "DISCORD_BOT_TOKEN=synthetic-discord", "-e", "DISCORD_MODEL_API_KEY=synthetic-model",
           "-e", "DISCORD_PUBLIC_ROUTER_KEY=synthetic-public", "-e", "DISCORD_PRIVATE_ROUTER_KEY=synthetic-private",
           "router-discord:ci")
    docker("start", NAME)
    state = None
    for attempt in range(60):
        time.sleep(2)
        container = json.loads(docker("inspect", NAME).stdout)[0]
        if container["State"]["OOMKilled"]:
            raise AssertionError("Gateway exceeded the 512 MB cap")
        if not container["State"]["Running"]:
            raise AssertionError("Gateway exited before offline startup could be checked")
        result = docker("exec", NAME, "cat", "/data/hermes/gateway_state.json", check=False)
        if result.returncode == 0:
            state = json.loads(result.stdout)
            if state.get("platforms", {}).get("discord"):
                break
    assert state and "discord" in state.get("platforms", {}), "Gateway did not attempt the Discord adapter"
    assert state.get("code_sha") == "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19", "Wrong Hermes release"
    peak = int(docker("exec", NAME, "cat", "/sys/fs/cgroup/memory.peak").stdout)
    assert peak < 512 * 1024 * 1024
    print(json.dumps({"offline_gateway_started": True, "peak_memory_mib": round(peak / 1024 / 1024, 1),
                      "discord_state": state["platforms"]["discord"]["state"], "real_discord_reply_tested": False}))
except Exception:
    # Credentials are synthetic; real deployment logs never flow through this test.
    print(docker("logs", "--tail", "100", NAME, check=False).stdout)
    print(docker("logs", "--tail", "100", NAME, check=False).stderr)
    raise
finally:
    docker("stop", "--time", "30", NAME, check=False)
    docker("rm", "-v", NAME, check=False)
