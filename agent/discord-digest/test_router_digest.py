import datetime as dt
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from pathlib import Path

import router_digest as digest

CONFIG = {"base_url": "https://router.example", "group_id": "test-group",
          "guild_id": "100000000000000001", "channel_id": "100000000000000002"}
ENTRY = {"id": "note-one", "version": "a" * 64, "audience": "group",
         "content": "RAW SOURCE BODY SHOULD NOT BE RETAINED", "timestamp": 1000}


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.entries = [ENTRY]

    def rpc(self, action, **body):
        self.calls.append(action)
        if action == "verify":
            self.assertEqual(body["sources"], [{"id": "note-one", "version": "a" * 64}] if self.entries else [])
            return {"verified": True}
        return {"groupId": "test-group", "audienceVersion": "v1", "entries": self.entries, **body}

    def compose(self, *args):
        self.calls.append("compose")
        return {"points": [{"text": "Alice proposed testing the revised joining flow.", "sources": ["note-one"]}]}, "test-model"

    def send(self, text):
        self.calls.append("send")
        return "message-one", "https://discord.example/message-one"

    def run_digest(self, **kw):
        options = {"rpc": self.rpc, "composer": self.compose, "send": self.send, **kw}
        return digest.run(self.root, "daily", "2026-11-20", CONFIG, "not-a-real-key", "not-a-real-key", **options)

    def test_exact_daily_and_weekly_periods_cross_month_boundary(self):
        for kind, days in [("daily", 1), ("weekly", 7)]:
            start, end = digest.window(kind, "2026-11-01")
            self.assertEqual(end - start, days * 86400000)
            self.assertEqual(dt.datetime.fromtimestamp(end / 1000, dt.timezone.utc).isoformat(), "2026-11-01T00:00:00+00:00")

    def test_composer_has_no_tools_and_maps_only_supplied_source_labels(self):
        client = MagicMock()
        client.__enter__.return_value = client
        response = SimpleNamespace(stop_reason="end_turn", model="test-model", content=[SimpleNamespace(type="text",
            text='{"points":[{"text":"A proposal","sources":["N1"]}]}')])
        client.messages.create.return_value = response
        with patch.dict("sys.modules", {"anthropic": SimpleNamespace(Anthropic=lambda **kwargs: client)}):
            summary, _ = digest.compose("daily", 0, 86400000, [ENTRY], "not-a-real-key")
            self.assertEqual(summary["points"][0]["sources"], ["note-one"])
            kwargs = client.messages.create.call_args.kwargs
            self.assertNotIn("tools", kwargs)
            self.assertEqual(json.loads(kwargs["messages"][0]["content"])["notes"][0]["id"], "N1")
            response.content[0].text = '{"points":[{"text":"A claim","sources":["N2"]}]}'
            with self.assertRaisesRegex(ValueError, "unknown source"):
                digest.compose("daily", 0, 86400000, [ENTRY], "not-a-real-key")

    def test_dry_run_has_real_source_links_no_send_no_raw_archive(self):
        result = self.run_digest()
        self.assertEqual(self.calls, ["read", "compose"])
        self.assertIn("[group note](<https://router.example/e/note-one>)", result["messages"][0])
        self.assertIn("2026-11-19 (UTC)", result["messages"][0])
        self.assertFalse((self.root / "digests" / "posted").exists())
        for file in self.root.rglob("*"):
            if file.is_file():
                self.assertNotIn(ENTRY["content"], file.read_text())

    def test_verify_precedes_send_and_rerun_is_noop(self):
        result = self.run_digest(post=True)
        self.assertEqual(self.calls, ["read", "compose", "verify", "send"])
        self.assertEqual(result["state"], "complete")
        self.run_digest(post=True)
        self.assertEqual(self.calls.count("send"), 1)
        self.assertEqual(self.calls.count("compose"), 1)

    def test_changed_or_deleted_source_aborts_delivery(self):
        def rpc(action, **body):
            if action == "verify":
                raise RuntimeError("source changed")
            return self.rpc(action, **body)
        with self.assertRaisesRegex(RuntimeError, "source changed"):
            self.run_digest(post=True, rpc=rpc)
        self.assertNotIn("send", self.calls)

    def test_empty_is_reported_but_read_failure_is_never_quiet_day(self):
        self.entries = []
        result = self.run_digest(post=True)
        self.assertIn("No new visible Router notes", result["messages"][0])
        self.assertNotIn("compose", self.calls)
        def broken(*args, **kw):
            raise RuntimeError("unavailable")
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            self.run_digest(rpc=broken)

    def test_unknown_send_outcome_blocks_retry(self):
        def broken(text):
            self.calls.append("send")
            raise TimeoutError("unknown outcome")
        with self.assertRaises(TimeoutError):
            self.run_digest(post=True, send=broken)
        with self.assertRaisesRegex(RuntimeError, "unknown outcome"):
            self.run_digest(post=True)
        self.assertEqual(self.calls.count("send"), 1)

    def test_unknown_sources_and_injected_urls_are_rejected(self):
        for point in [{"text": "A claim", "sources": ["made-up"]},
                      {"text": "Visit https://untrusted.example", "sources": ["note-one"]},
                      {"text": "<@everyone>", "sources": ["note-one"]}]:
            with self.assertRaises(ValueError):
                digest.render("daily", "2026-11-20", [ENTRY], {"points": [point]}, CONFIG["base_url"])

    def test_weekly_splits_at_paragraphs_and_reverifies_each_delivery(self):
        summary = {"points": [{"text": "A" * 550, "sources": ["note-one"]} for _ in range(6)]}
        messages = digest.render("weekly", "2026-11-20", [ENTRY], summary, CONFIG["base_url"])
        self.assertEqual(len(messages), 3)
        self.assertTrue(all(len(m) <= 1900 for m in messages))
        record = {"state": "ready", "sent": [], "messages": messages,
                  "proof": {"audienceVersion": "v1", "sources": [{"id": "note-one", "version": "a" * 64}]}}
        digest.deliver(record, self.root / "record.json", self.rpc, self.send)
        self.assertEqual(self.calls, ["verify", "send"] * 3)

    def test_destination_change_and_incomplete_read_are_rejected(self):
        self.run_digest(post=True)
        path = self.root / "digests" / "router" / "posted" / "daily-2026-11-20.json"
        record = json.loads(path.read_text())
        record["destination"]["channel_id"] = "different"
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "another destination"):
            self.run_digest(post=True)
        with self.assertRaisesRegex(ValueError, "incomplete coverage"):
            self.run_digest(rpc=lambda *args, **kwargs: {"entries": []})


if __name__ == "__main__":
    unittest.main()
