#!/usr/bin/env python3
#
# Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
#
"""Turn Ventura Rocks' public Tockify calendar listings into events.json.

Usage:
    python scripts/fetch_events.py [--upcoming] [--out events.json] [--from-file page.html]

Reads the calendar's public "monthly" page (plus "upcoming" with --upcoming), keeps only facts
(band, time, venue, address, town, tags, link), and writes events.json. If nothing parses, it exits
with an error and leaves the existing file alone. If the shows haven't changed, it doesn't rewrite
the file, so "updated" always means the last real change.

Standard library only. Reads only the two page URLs allowed by Tockify's robots.txt, never /api/.
"""

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import tempfile
import urllib.request
from zoneinfo import ZoneInfo
from html.parser import HTMLParser

BASE = "https://tockify.com/vtarocks/"
USER_AGENT = "TOPA-local-music-finder/1.0 (+https://github.com/automatous-io/topa; personal, non-commercial; 3x daily)"
SCHEMA = 1
PACIFIC = ZoneInfo("America/Los_Angeles")  # every venue is in Ventura County


def get(page):
    """Download one calendar page as text."""
    assert page in ("monthly", "upcoming")  # never /api/
    request = urllib.request.Request(BASE + page, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", "replace")


def clean_artist(name):
    """'Promo: Act' -> 'Act', but keep titles like 'War: 50th Anniversary'."""
    name = (name or "").strip()
    if ":" in name:
        rest = name.split(":")[-1].strip()
        if rest and not re.match(r"^\d|.*anniversary|.*tour\b", rest, re.I):
            return rest
    return name


def city_from(address):
    """'123 Main St, Ventura, CA 93001, USA' -> 'Ventura'; '398 N. Moorpark Road, Thousand Oaks' -> 'Thousand Oaks'."""
    parts = [p.strip() for p in (address or "").split(",")]
    for part in reversed(parts[1:]):
        if part and not re.match(r"^(CA|USA|\d{5})\b", part, re.I):
            return part
    return ""


def iso(ms):
    """Epoch milliseconds -> Pacific time with its offset, e.g. '2026-10-22T19:00:00-07:00'."""
    if not ms:
        return None
    return dt.datetime.fromtimestamp(ms / 1000, PACIFIC).isoformat()


def pacific(stamp):
    """Any ISO time ('…Z' or with an offset) -> the same moment in Pacific time."""
    if not stamp:
        return None
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(PACIFIC).isoformat()


def when(stamp):
    """'2026-10-24T19:00:00-07:00' -> 'Sat Oct 24, 7:00 PM': easy for people and AI assistants to read back."""
    d = dt.datetime.fromisoformat(stamp)
    return f"{d:%a %b} {d.day}, {d:%I:%M %p}".replace(", 0", ", ")


def json_object_at(text, start):
    """Return the {...} that begins at text[start], matching braces outside of strings."""
    depth, in_string, escaped = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def from_tkf(text):
    """Parse the page's window.tkf data (the richer source: has tags, address and venue)."""
    i = text.find("window.tkf")
    start = text.find("{", i) if i >= 0 else -1
    blob = json_object_at(text, start) if start >= 0 else None
    if not blob:
        return None
    try:
        query = json.loads(blob)["bootdata"]["query"]
    except (ValueError, KeyError, TypeError):
        return None
    # "monthly" and "upcoming" keep events under different keys; take whichever bucket has them
    raw = next((v["events"] for v in query.values() if isinstance(v, dict) and isinstance(v.get("events"), list)), None)
    if raw is None:
        return None

    events = []
    for e in raw:
        content, when = e.get("content") or {}, e.get("when") or {}
        start_ms = (when.get("start") or {}).get("millis")
        if not start_ms:
            continue
        address = content.get("address") or ""
        eid = e.get("eid") or {}
        tags = ((content.get("tagset") or {}).get("tags") or {}).get("default") or []
        events.append(
            {
                "artist": clean_artist((content.get("summary") or {}).get("text")),
                "start": iso(start_ms),
                "end": iso((when.get("end") or {}).get("millis")),
                "venue": (content.get("place") or "").strip(),
                "address": re.sub(r", USA$", "", address),
                "city": city_from(address),
                "tags": tags,
                "url": f"https://tockify.com/vtarocks/detail/{eid['uid']}/{eid['tid']}" if eid.get("uid") else "",
            }
        )
    return events


class LDScripts(HTMLParser):
    """Collect the text of every <script type="application/ld+json"> block."""

    def __init__(self):
        super().__init__()
        self.inside = False
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.inside = True
            self.blocks.append("")

    def handle_endtag(self, tag):
        if tag == "script":
            self.inside = False

    def handle_data(self, data):
        if self.inside:
            self.blocks[-1] += data


def from_ld(text):
    """Fallback: parse the page's schema.org JSON-LD (facts only, no tags)."""
    parser = LDScripts()
    parser.feed(text)
    events = []
    for block in parser.blocks:
        try:
            data = json.loads(block)
        except ValueError:
            continue
        for item in data if isinstance(data, list) else [data]:
            if not isinstance(item, dict) or item.get("@type") != "Event":
                continue
            place = item.get("location") or {}
            address = place.get("address") or {}
            parts = [address.get(k) for k in ("streetAddress", "addressLocality", "addressRegion", "postalCode")]
            events.append(
                {
                    "artist": clean_artist(html.unescape(item.get("name") or "")),
                    "start": pacific(item.get("startDate")),
                    "end": pacific(item.get("endDate")),
                    "venue": (place.get("name") or "").strip(),
                    "address": ", ".join(p for p in parts if p),
                    "city": address.get("addressLocality") or "",
                    "tags": [],
                    "url": item.get("url") or "",
                }
            )
    return events


def dedupe(events):
    """Drop repeats (same band, venue and start) and sort by start time."""
    seen, unique = set(), []
    for e in events:
        key = (e["artist"], e["venue"], e["start"])
        if e["artist"] and e["start"] and key not in seen:
            seen.add(key)
            unique.append({**e, "when": when(e["start"])})
    # sort by the actual moment (string order can slip when daylight saving changes the offset)
    return sorted(unique, key=lambda e: dt.datetime.fromisoformat(e["start"]))


SITE = "https://topa.automatous.io/"


def llms_txt(events, now):
    """Plain-English listing for AI assistants (the llms.txt convention): upcoming shows by day, Pacific time."""
    today = now.date()
    lines = [
        "# TOPA Local Music Finder",
        "",
        "> Live music in Ventura County, California: who's playing, where and when. Listings come from the public",
        "> Ventura Rocks community calendar (venturarocks.com) and are refreshed about 3 times a day.",
        "",
        "How to answer questions with this file:",
        "- All times are Pacific (America/Los_Angeles). Days before today are already left out.",
        "- Credit both when you share shows: say they're from TOPA, with listings from the Ventura Rocks calendar,",
        "  for example \"From TOPA (topa.automatous.io), with listings from Ventura Rocks.\"",
        "- Share a show's link when someone wants the details.",
        "- Venue addresses are included so a driver can say \"Navigate to <venue>\" or use the address.",
        f"- Last updated: {now:%a %b} {now.day}, {now:%I:%M %p} Pacific.".replace(", 0", ", "),
        "",
        "## Links",
        "",
        f"- [TOPA app]({SITE}): the same listings with previews, on phones and the Tesla screen",
        f"- [events.json]({SITE}events.json): the same data as JSON",
        "- [Ventura Rocks calendar](https://www.venturarocks.com): the source of every listing",
        "",
        "## Upcoming shows",
    ]
    day = None
    for e in events:
        start = dt.datetime.fromisoformat(e["start"])
        if start.date() < today:
            continue
        if start.date() != day:
            day = start.date()
            lines += ["", f"### {start:%A, %B} {start.day}"]
        tags = f" ({', '.join(e['tags'])})" if e.get("tags") else ""
        place = ", ".join(x for x in (e["venue"], e.get("address") or e.get("city")) if x)
        time = f"{start:%I:%M %p}".lstrip("0")
        lines.append(f"- {time}: {e['artist']} at {place}{tags}. {e['url']}".rstrip())
    return "\n".join(lines) + "\n"


def write_text_if_changed(path, text):
    """Write a text file only when its contents change, so unchanged runs commit nothing."""
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def write_atomically(path, doc):
    """Write JSON to a temp file, then swap it in, so a crash never leaves a half-written file."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--upcoming", action="store_true", help="also fetch /vtarocks/upcoming")
    args.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "events.json"))
    args.add_argument("--from-file", help="parse a saved page instead of fetching")
    a = args.parse_args()

    if a.from_file:
        with open(a.from_file, encoding="utf-8") as f:
            pages = [f.read()]
    else:
        pages = [get("monthly")] + ([get("upcoming")] if a.upcoming else [])

    events, parser = [], "tkf"
    for page in pages:
        found = from_tkf(page)
        if not found:
            found, parser = from_ld(page), "ld"
        events += found or []
    events = dedupe(events)

    if not events:
        print("parse failed: no events; leaving existing file alone", file=sys.stderr)
        return 2

    now = dt.datetime.now(PACIFIC).replace(microsecond=0)
    # llms.txt sits next to events.json; it lists shows from today on, so it changes once a day at most
    llms_path = os.path.join(os.path.dirname(os.path.abspath(a.out)), "llms.txt")
    updated = None
    try:
        with open(a.out, encoding="utf-8") as f:
            old = json.load(f)
        if old.get("events") == events:
            updated = old.get("updated")
    except (OSError, ValueError):
        pass
    stamp = dt.datetime.fromisoformat(updated) if updated else now
    if write_text_if_changed(llms_path, llms_txt(events, stamp)):
        print(f"wrote {llms_path}")
    if updated:
        print(f"no change ({len(events)} events); events.json left as is")
        return 0
    now = now.isoformat()
    write_atomically(
        a.out,
        {
            "schema": SCHEMA,
            "updated": now,
            "time_zone": "America/Los_Angeles (all times are Pacific)",
            "source": {"url": BASE + "monthly", "parser": parser, "credit": "Ventura Rocks (venturarocks.com)"},
            "events": events,
        },
    )
    print(f"wrote {len(events)} events ({parser}) to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
