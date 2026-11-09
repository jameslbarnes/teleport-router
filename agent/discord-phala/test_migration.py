import base64
import copy
import datetime as dt
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import cohort_archive as archive
import discord_archive as remote
import entrypoint
import health


def fixture():
    return {"version": 1, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "issues": {
        "weekly-2026-11-08": {"kind": "weekly", "post_date": "2026-11-08", "covers": ["2026-11-01", "2026-11-08"],
                              "url": "https://discord.com/example", "text": "A published issue", "sections": {
                                  "cohort": [{"title": "Trust study", "authors": ["Ada"], "abstract": "Measured evidence", "url": "https://example.org/paper"}]}}}}


def message(data):
    payload = json.dumps(data).encode()
    return {"id": remote.MESSAGE, "channel_id": remote.CHANNEL, "author": {"id": remote.BOT}, "attachments": [{
        "filename": f"router-cohort-v1-{remote.digest(data)}.json", "size": len(payload),
        "url": f"https://cdn.discordapp.com/attachments/{remote.CHANNEL}/123/archive.json?ex=signed"}]}


class ArchiveTests(unittest.TestCase):
    def test_export_only_posted_sources_no_roster_or_unpublished_drafts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for folder in ("roster", "library", "digests/posted", "digests/inputs"):
                (root / folder).mkdir(parents=True)
            def write(name, value):
                (root / name).write_text(json.dumps(value), encoding="utf-8")
            write("roster/roster.json", {"people": [{"project_id": "test", "project": "Testing: A study", "email": "ROSTER_SECRET"}]})
            write("library/library.json", {"records": []})
            write("digests/posted/2026-11-07.json", {"post_date": "2026-11-07", "covers": ["2026-11-06", "2026-11-07"]})
            (root / "digests/posted/2026-11-07.md").write_text("Posted", encoding="utf-8")
            write("digests/inputs/2026-11-07.json", {"items": [{"title": "Paper", "project_ids": ["test"], "raw_secret": "EXCLUDED"}]})
            write("digests/inputs/2026-11-09.json", {"items": [{"title": "UNPUBLISHED"}]})
            data = archive.validate_archive(archive.export_archive(root))
            text = json.dumps(data)
            for excluded in ("ROSTER_SECRET", "EXCLUDED", "UNPUBLISHED", "project_ids", "email"):
                self.assertNotIn(excluded, text)
            self.assertEqual(data["issues"]["2026-11-07"]["sections"]["cohort"][0]["project"], "Testing")

    def test_tool_results_and_invalid_issue(self):
        data = fixture()
        self.assertEqual(archive.sources(data, "weekly-2026-11-08", "trust")["matches"][0]["abstract"], "Measured evidence")
        self.assertNotIn("abstract", archive.sources(data, "weekly-2026-11-08")["cohort"][0])
        with self.assertRaises(ValueError):
            archive.sources(data, "../../secret")

    def test_wrong_author_host_channel_and_size_are_denied(self):
        original = message(fixture())
        for change in (lambda m: m["author"].update(id="other"), lambda m: m.update(channel_id="other"),
                       lambda m: m["attachments"][0].update(url="https://evil.example/steal"),
                       lambda m: m["attachments"][0].update(size=remote.MAX_ARCHIVE + 1),
                       lambda m: m["attachments"][0].update(url=f"https://cdn.discordapp.com/attachments/other/secret")):
            item = copy.deepcopy(original)
            change(item)
            with self.assertRaises(ValueError):
                remote.attachment(item)

    def test_download_verifies_checksum_and_never_sends_token_to_cdn(self):
        data = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            cache, token = Path(tmp) / "cache.json", Path(tmp) / "token"
            token.write_text("synthetic-token")
            calls = []
            def fetch(url, limit, credential=None):
                calls.append((url, credential))
                return json.dumps(message(data) if url.startswith(remote.API) else data).encode()
            self.assertEqual(remote.load(cache, token, fetch), data)
            self.assertEqual([c[1] for c in calls], ["synthetic-token", None])
            self.assertEqual(remote.load(cache, token, lambda *a: self.fail("fresh cache must not fetch")), data)
            cache.unlink()
            def bad(url, limit, credential=None):
                result = message(data)
                if credential:
                    result["attachments"][0]["filename"] = "router-cohort-v1-" + "0" * 64 + ".json"
                    return json.dumps(result).encode()
                return json.dumps(data).encode()
            with self.assertRaises(ValueError):
                remote.load(cache, token, bad)
            self.assertFalse(cache.exists())

    def test_expired_cache_does_not_hide_a_failed_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, token = Path(tmp) / "cache", Path(tmp) / "token"
            cache.write_text(json.dumps(fixture()))
            os.utime(cache, (0, 0))
            token.write_text("synthetic")
            with self.assertRaises(OSError):
                remote.load(cache, token, lambda *a: (_ for _ in ()).throw(OSError("unavailable")))


class StartupTests(unittest.TestCase):
    def test_shipped_private_destination_accepts_topic_channels_but_rejects_old_group_grants(self):
        root = Path(__file__).parent
        module_file = root / "plugins/router-private/router_private.py"
        if not module_file.exists():
            module_file = root.parent / "discord-test/router-private/router_private.py"
        spec = importlib.util.spec_from_file_location("shipped_private_destination", module_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        settings = json.loads((root / "private.json").read_text())
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            router = module.PrivateRouter(settings, tmp, "synthetic")
            for channel in (1568051571751788644, 1568051146172403816):
                interaction = SimpleNamespace(guild_id=1568051145551650858, channel_id=channel,
                    user=SimpleNamespace(id=1568048209002111017, bot=False))
                self.assertEqual(router.actor(interaction)["channelId"], str(channel))
            router.check_group({"groupId": "router-working-group"})
            with self.assertRaises(module.PrivateError):
                router.check_group({"groupId": "discord-router-test"})
            interaction.guild_id = 1568051145551650899
            with self.assertRaises(module.PrivateError):
                router.actor(interaction)

    def test_link_seed_preserved_once_and_not_restored_after_unlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, home = Path(tmp) / "code", Path(tmp) / "data/hermes"
            root.mkdir()
            for name in ("config.yaml", "SOUL.md"):
                (root / name).write_text("fixture")
            for name in ("router-private", "router-participation"):
                (root / "plugins" / name).mkdir(parents=True)
            initial = {"scope:user": {"grantToken": "synthetic"}}
            def env():
                return {"DISCORD_MODEL_API_KEY": "synthetic-model", "DISCORD_PUBLIC_ROUTER_KEY": "synthetic-public",
                        "DISCORD_PRIVATE_ROUTER_KEY": "synthetic-private", "DISCORD_BOT_TOKEN": "synthetic-discord",
                        "DISCORD_INITIAL_LINKS_B64": base64.b64encode(json.dumps(initial).encode()).decode()}
            values = env()
            with patch.object(entrypoint, "ROOT", root):
                missing = env()
                missing.pop("DISCORD_INITIAL_LINKS_B64")
                entrypoint.prepare(home, missing)
                self.assertFalse((home / ".links-seeded").exists(), "An absent seed must remain retryable")
                entrypoint.prepare(home, values)
                links = home / "plugin-data/router-private/links.json"
                self.assertEqual(json.loads(links.read_text()), initial)
                self.assertNotIn("DISCORD_INITIAL_LINKS_B64", values)
                self.assertEqual(values["ROUTER_SECRET_KEY"], "synthetic-public")
                self.assertEqual(values["ROUTER_PRIVATE_SECRET_KEY"], "synthetic-private")
                links.write_text("{}")
                entrypoint.prepare(home, env())
                self.assertEqual(json.loads(links.read_text()), {})
                self.assertTrue((home / "plugins/router-private").is_symlink())

    def test_health_requires_fresh_connected_matching_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            state = {"pid": os.getpid(), "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                     "gateway_state": "running", "platforms": {"discord": {"state": "connected"}},
                     "code_sha": "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19"}
            path = home / "gateway_state.json"
            path.write_text(json.dumps(state))
            self.assertTrue(health.healthy(home))
            state["updated_at"] = "2020-01-01T00:00:00+00:00"
            path.write_text(json.dumps(state))
            self.assertFalse(health.healthy(home))


class PublisherTests(unittest.TestCase):
    def test_preserves_text_and_other_files_and_does_not_ping(self):
        source = Path(__file__).parents[2] / "scripts/discord-cohort-publish.py"
        if not source.exists():
            self.skipTest("Operator script is outside the runtime image")
        spec = importlib.util.spec_from_file_location("publisher", source)
        publisher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(publisher)
        data = fixture()
        original = message(data)
        original.update(content="Keep newsletter text", attachments=[{"id": "7", "filename": "another.pdf"}])
        calls = []
        class Opener:
            def open(self, req, timeout):
                calls.append(req)
                result = original if req.get_method() == "GET" else {**message(data), "content": original["content"]}
                return io.BytesIO(json.dumps(result).encode())
        result = publisher.publish(data, "synthetic", Opener())
        self.assertTrue(result["changed"])
        body = calls[1].data.decode()
        self.assertIn('"filename": "another.pdf"', body)
        self.assertIn('"allowed_mentions": {"parse": []}', body)
        self.assertNotIn('"content":', body)
        self.assertNotIn("synthetic", body)


if __name__ == "__main__":
    unittest.main()
