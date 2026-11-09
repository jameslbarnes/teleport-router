"""Portable, data-only view of the existing cohort MCP library.

Only posted issues, their sources and project display names are exported.
No roster, raw fetches, credentials, unpublished drafts or chat history.
"""
import datetime as dt
import json
import re
from pathlib import Path

ISSUE_ID = re.compile(r"^(weekly-)?\d{4}-\d{2}-\d{2}$")
KEEP = ("source", "kind", "subject", "subject_type", "date", "title", "authors", "venue",
        "abstract", "summary", "text", "quoted", "link", "url", "also_from")


def url_key(url):
    return re.sub(r"^https?://(www\.)?", "", url.strip().rstrip("/"), flags=re.I).lower()


def short_name(project):
    name = project.split(":")[0].strip()
    match = re.search(r"\(([A-Z][A-Za-z0-9&\-]{1,12})\)\s*$", name)
    return match.group(1) if match else name


def export_archive(root: Path):
    names = {}
    roster = json.loads((root / "roster/roster.json").read_text(encoding="utf-8"))
    for person in roster["people"]:
        if person.get("project_id") and person.get("project"):
            names.setdefault(person["project_id"], person["project"])
    names.setdefault("programme-team", "ARIA programme team")
    library = json.loads((root / "library/library.json").read_text(encoding="utf-8"))["records"]
    issues = {}
    for path in sorted((root / "digests/posted").glob("*.json")):
        issue = path.stem
        if not ISSUE_ID.fullmatch(issue):
            continue
        meta = json.loads(path.read_text(encoding="utf-8"))
        text = path.with_suffix(".md").read_text(encoding="utf-8")
        data = json.loads((root / "digests/inputs" / f"{issue}.json").read_text(encoding="utf-8"))
        cohort = []
        for item in data.get("items") or data.get("cohort") or []:
            entry = {k: item[k] for k in KEEP if item.get(k)}
            entry["project"] = ", ".join(short_name(names.get(pid, pid)) for pid in item.get("project_ids", []))
            cohort.append(entry)
        sections = {"cohort": cohort}
        if issue.startswith("weekly-"):
            linked = {url_key(u) for u in re.findall(r"\]\((https?://[^)\s]+)\)", text)}
            sections["citing"] = [{k: w.get(k) for k in ("title", "authors", "date", "url", "cites", "abstract")}
                                  for w in data["citing"]]
            sections["reading_list"] = [
                {"title": r["title"], "url": r["url"], "categories": r.get("categories"),
                 "about": "" if str(r.get("summary", "")).startswith("!") else r.get("summary", "")}
                for r in library if url_key(r["url"]) in linked]
        issues[issue] = {
            "kind": meta.get("kind", "daily"), "post_date": meta["post_date"],
            "covers": meta["covers"], "url": meta.get("url"),
            "text": re.sub(r"\n*<!-- message -->\n*", "\n\n", text).strip(), "sections": sections,
        }
    return {"version": 1, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "issues": issues}


def validate_archive(data):
    if not isinstance(data, dict) or set(data) != {"version", "updated_at", "issues"} or data["version"] != 1:
        raise ValueError("Invalid archive format")
    dt.datetime.fromisoformat(data["updated_at"])
    if not isinstance(data["issues"], dict) or len(data["issues"]) > 1000:
        raise ValueError("Invalid issues")
    for issue, entry in data["issues"].items():
        if not ISSUE_ID.fullmatch(issue) or not isinstance(entry, dict):
            raise ValueError("Invalid issue")
        if set(entry) != {"kind", "post_date", "covers", "url", "text", "sections"}:
            raise ValueError("Invalid issue fields")
        dt.date.fromisoformat(entry["post_date"])
        if entry["kind"] not in ("daily", "weekly") or not isinstance(entry["text"], str):
            raise ValueError("Invalid issue metadata")
        if len(entry["covers"]) != 2:
            raise ValueError("Invalid issue dates")
        for date in entry["covers"]:
            dt.date.fromisoformat(date)
        if not isinstance(entry["sections"], dict) or not set(entry["sections"]) <= {"cohort", "citing", "reading_list"}:
            raise ValueError("Invalid issue sections")
        for items in entry["sections"].values():
            if not isinstance(items, list) or len(items) > 5000 or any(not isinstance(i, dict) for i in items):
                raise ValueError("Invalid source items")
    return data


def index_entry(item):
    if item.get("subject"):
        who = f"{item['subject']} ({item.get('project', '')})".replace(" ()", "")
    else:
        authors = item.get("authors") or []
        who = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")
    entry = {"title": item.get("title") or (item.get("text") or "")[:120], "who": who,
             **{k: item.get(k) for k in ("date", "url", "source", "kind", "cites", "categories")}}
    return {k: v for k, v in entry.items() if v}


def full_entry(item):
    full = index_entry(item)
    for key in ("abstract", "summary", "text", "about"):
        if item.get(key):
            full[key] = item[key][:2000]
    if isinstance(item.get("quoted"), dict) and item["quoted"].get("text"):
        full["quoted_post"] = item["quoted"]
    return full


def recent(archive, days=14):
    cutoff = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=max(1, min(days, 90)))
    ordered = sorted(archive["issues"].items(), key=lambda kv: (kv[1]["post_date"], kv[1]["kind"] == "weekly"), reverse=True)
    return [{"issue": issue, "kind": d["kind"], "post_date": d["post_date"], "covers_from": d["covers"][0],
             "covers_through": (dt.date.fromisoformat(d["covers"][1]) - dt.timedelta(days=1)).isoformat(),
             "url": d["url"], "text": d["text"]} for issue, d in ordered if d["post_date"] >= cutoff.isoformat()]


def sources(archive, issue, query=""):
    issue = issue.strip()
    if not ISSUE_ID.fullmatch(issue) or issue not in archive["issues"]:
        raise ValueError("Use an issue id from recent_digests.")
    entry = archive["issues"][issue]
    out = {"issue": issue, "kind": entry["kind"]}
    words = query.casefold().split()
    if not words:
        out.update({name: [index_entry(i) for i in items] for name, items in entry["sections"].items()})
        out["note"] = "Short index. Call again with query for an item's full abstract or text."
    else:
        matches = [(name, i) for name, items in entry["sections"].items() for i in items
                   if all(w in json.dumps(i, ensure_ascii=False).casefold() for w in words)]
        out.update(matches=[{"section": name, **full_entry(i)} for name, i in matches[:5]], total_matches=len(matches))
    return out
