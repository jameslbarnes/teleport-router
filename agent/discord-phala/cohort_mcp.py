"""Read-only stdio tools for the research sources published with the newsletter."""
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cohort_archive import recent, sources
from discord_archive import load
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

server = MCPServer("cohort", instructions="Scaling Trust issues posted in #router-test and their public sources.")


def archive():
    try:
        return load(cache=Path(os.environ.get("COHORT_ARCHIVE", "/data/cohort.json")))
    except Exception:
        raise ToolError("The posted-issue archive is unavailable. Do not assume it is empty.") from None


@server.tool(description="List issues posted in #router-test in the last 1–90 days: issue id, dates, Discord link and full text.")
def recent_digests(days: int = 14) -> list[dict]:
    return recent(archive(), days)


@server.tool(description="Read the public sources behind a posted issue. Use an issue id from recent_digests. Without query returns an index; with query returns up to five matching abstracts/posts.")
def digest_sources(issue: str, query: str = "") -> dict:
    try:
        return sources(archive(), issue, query)
    except ValueError as exc:
        raise ToolError(str(exc)) from None


if __name__ == "__main__":
    server.run("stdio")
