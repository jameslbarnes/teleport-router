"""Exercise the actual stdio MCP transport with the runtime's pinned SDK."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

sys.path.insert(0, str(Path(__file__).parent))
from test_migration import fixture


class StdioTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_tools_start_and_return_sources_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "archive.json"
            data = fixture()
            data["issues"]["weekly-2026-11-08"]["post_date"] = dt.datetime.now(dt.timezone.utc).date().isoformat()
            cache.write_text(json.dumps(data), encoding="utf-8")
            params = StdioServerParameters(command=sys.executable,
                args=["-I", str(Path(__file__).parent / "cohort_mcp.py")], env={"COHORT_ARCHIVE": str(cache)})
            async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
                await session.initialize()
                self.assertEqual({t.name for t in (await session.list_tools()).tools}, {"recent_digests", "digest_sources"})
                recent = await session.call_tool("recent_digests", {"days": 90})
                self.assertFalse(recent.is_error)
                self.assertIn("A published issue", "\n".join(getattr(c, "text", "") for c in recent.content))
                source = await session.call_tool("digest_sources", {"issue": "weekly-2026-11-08", "query": "trust"})
                self.assertFalse(source.is_error)
                self.assertIn("Measured evidence", "\n".join(getattr(c, "text", "") for c in source.content))


if __name__ == "__main__":
    unittest.main()
