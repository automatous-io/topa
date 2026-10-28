#!/usr/bin/env python3
#
# Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
#
"""Turn a filled-in GitHub issue form (Add a show, a weekly show, a band, a venue) into a community file.

Usage:
    python scripts/submissions.py --body-file issue.md [--author octocat] [--issue 12] [--write]
                                  [--report report.md] [--github-output "$GITHUB_OUTPUT"]

Works out which form it is and checks it. --write saves the file under community/, --report writes the bot's note
(what to fix, or what the PR adds or changes), --github-output passes kind, ok, path, title and photo to the
workflow. Other issues are ignored. Standard library only.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys

import community as c

# each form's field labels, exactly as in .github/ISSUE_TEMPLATE/*.yml (a test keeps the two in sync)
FORMS = {
    "show": {
        "band": "Band or artist",
        "venue": "Venue",
        "date": "Date",
        "start": "Start time",
        "end": "End time",
        "tags": "Genres and tags",
        "link": "Link for the show",
        "notes": "Anything else?",
    },
    "weekly": {
        "band": "Band, artist or event",
        "venue": "Venue",
        "weekday": "Day of the week",
        "start": "Start time",
        "end": "End time",
        "first": "First date",
        "until": "Last date",
        "skip": "Skip these dates",
        "tags": "Genres and tags",
        "link": "Link for the show",
        "notes": "Anything else?",
    },
    "band": {
        "name": "Band or artist name",
        "aliases": "Other names it's listed under",
        "genres": "Genres",
        "town": "Hometown",
        "website": "Website",
        "instagram": "Instagram",
        "facebook": "Facebook",
        "bandcamp": "Bandcamp",
        "spotify": "Spotify",
        "youtube": "YouTube",
        "soundcloud": "SoundCloud",
        "apple": "Apple Music artist link",
        "photo": "Photo",
        "notes": "Anything else?",
    },
    "venue": {
        "pick": "Venue",
        "name": "Name of the new venue",
        "address": "Street address",
        "city": "Town",
        "coords": "Map location",
        "phone": "Phone",
        "website": "Website",
        "photo": "Photo",
        "notes": "Anything else?",
    },
}
# the one field that tells the forms apart
MARKERS = {"weekly": "Day of the week", "show": "Date", "band": "Band or artist name", "venue": "Name of the new venue"}
TITLES = {"show": "Add show", "weekly": "Add weekly show", "band": "Add band", "venue": "Add venue"}


def parse_form(body):
    """Issue form text ('### Label', then the answer) -> {label: answer}."""
    fields, label, lines = {}, None, []
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        if line.startswith("### "):
            if label is not None:
                fields[label] = "\n".join(lines).strip()
            label, lines = line[4:].strip(), []
        elif label is not None:
            lines.append(line)
    if label is not None:
        fields[label] = "\n".join(lines).strip()
    return {k: ("" if v == "_No response_" else v) for k, v in fields.items()}


def kind_of(fields):
    """Which form this is ('show', 'weekly', 'band', 'venue'), or '' for any other issue."""
    for kind, marker in MARKERS.items():
        if marker in fields:
            return kind
    return ""


def to_record(kind, fields, author, issue, today, venues):
    """Form answers -> the record saved under community/. Unreadable values become None."""
    f = {key: fields.get(label, "").strip() for key, label in FORMS[kind].items()}
    meta = {"submitted_by": author or "", "issue": issue or None}
    if kind in ("show", "weekly"):
        venue, _ = c.match_venue(f["venue"], venues)
        r = {
            "band": " ".join(f["band"].split()),
            "venue": venue or f["venue"],
            "start": c.parse_time(f["start"]),
            "end": c.parse_time(f["end"]) if f["end"] else "",
            "tags": c.parse_list(f["tags"]),
            "link": c.parse_link(f["link"]),
        }
        if kind == "show":
            day = c.parse_date(f["date"], today)
            r = {"band": r["band"], "venue": r["venue"], "date": day.isoformat() if day else None, **r}
        else:
            first, until = c.parse_date(f["first"], today), c.parse_date(f["until"], today)
            # dates have slashes; split on commas and spaces only
            skips = [c.parse_date(x, today) for x in re.split(r"[,;\s]+", f["skip"]) if x]
            r.update(
                {
                    "weekday": f["weekday"].title(),
                    "first": first.isoformat() if first else None,
                    "until": until.isoformat() if until else None,
                    "skip": None if None in skips else [d.isoformat() for d in skips],
                }
            )
        return {**r, **meta}
    photo = c.photo_link(f.get("photo"))
    name = " ".join(f["name"].split())
    if kind == "venue" and f.get("pick") and f["pick"] != c.NEW_VENUE:
        name = f["pick"]  # an existing venue, picked from the list
    pics = {"photo": c.photo_path(kind, name) if photo and name else "", "photo_url": photo}
    # "remove" clears a field on an update (see merge)
    gone = lambda key: f.get(key, "").lower() == "remove"
    keep = lambda key, value: CLEAR if gone(key) else value
    if kind == "band":
        return {
            "name": name,
            "aliases": keep("aliases", c.parse_list(f["aliases"])),
            "genres": keep("genres", [g.lower() for g in c.parse_list(f["genres"])]),
            "town": keep("town", f["town"]),
            "links": {k: keep(k, c.parse_link(f[k], k)) for k in c.LINK_KEYS},
            "apple": c.apple_id(f["apple"]),
            **pics,
            "maintainers": [author] if author else [],
            **meta,
        }
    coords = c.parse_coords(f["coords"])
    return {
        "name": name,
        "address": f["address"],
        "city": f["city"],
        "lat": coords[0] if coords else None,
        "lng": coords[1] if coords else None,
        "phone": keep("phone", f["phone"]),
        "website": keep("website", c.parse_link(f["website"])),
        **pics,
        "maintainers": [author] if author else [],
        **meta,
        "coords_text": f["coords"],
    }


CLEAR = "\0remove"  # a field someone typed "remove" in


def merge(old, new):
    """An update: blank answers keep what's there, "remove" clears, links merge one by one, and maintainers are only
    ever added."""
    if not old:
        return clean(new)
    out = dict(old)
    for key, value in new.items():
        if key == "links":
            links = dict(old.get("links") or {})
            for k, v in (value or {}).items():
                if v == CLEAR:
                    links.pop(k, None)
                elif v or v is None:  # None = not a link; kept so the check flags it
                    links[k] = v
            out["links"] = links
        elif key == "maintainers":
            out[key] = list(dict.fromkeys((old.get(key) or []) + (value or [])))
        elif value == CLEAR:
            out[key] = [] if isinstance(old.get(key), list) else ""
        elif value is None and key not in ("lat", "lng"):
            out[key] = None  # didn't read right; the check flags it
        elif value not in ("", [], {}, None):
            out[key] = value
    return clean(out)


def clean(r):
    """Turn leftover "remove" markers into empty values (for a new record)."""
    fix = lambda v: "" if v == CLEAR else v
    out = {k: fix(v) for k, v in r.items()}
    if isinstance(out.get("links"), dict):
        # drop blanks and "remove"s, keep bad links (None) for the check
        out["links"] = {k: v for k, v in out["links"].items() if v is None or (v and v != CLEAR)}
    return out


def changes(old, new):
    """What an update changes, one line each, for the PR."""
    skip = ("submitted_by", "issue", "maintainers", "photo_url", "coords_text")
    empty = lambda v: v in ("", [], {}, None)
    flat = lambda r: {
        **{k: v for k, v in r.items() if k not in skip and k != "links" and not empty(v)},
        **{f"links.{k}": v for k, v in (r.get("links") or {}).items() if not empty(v)},
    }
    a, b = flat(old), flat(new)
    show = lambda v: ", ".join(v) if isinstance(v, list) else str(v)
    return [f"- **{k}**: {show(a[k]) if k in a else '(new)'} → {show(b[k])}" for k in b if a.get(k) != b[k]] + [
        f"- **{k}**: {show(a[k])} → (removed)" for k in a if k not in b
    ]


def title(kind, r):
    """A short PR title: 'Add show: The Tide Pool Ramblers at Harbor Lights Tavern, Sat Nov 7'."""
    if kind == "show" and r.get("date"):
        d = dt.date.fromisoformat(r["date"])
        return f"{TITLES[kind]}: {r['band']} at {r['venue']}, {d:%a %b} {d.day}"
    if kind == "weekly":
        return f"{TITLES[kind]}: {r['band']} at {r['venue']}, {r.get('weekday')}s"
    return f"{TITLES[kind]}: {r.get('name') or r.get('band')}"


def report(kind, r, problems, path, notes, changed=None):
    """The bot's note: what to fix, or what the PR adds (just the changes, for an update)."""
    if problems:
        return (
            "Thanks for adding to TOPA! A few things need fixing before this can go live:\n\n"
            + "".join(f"- {p}\n" for p in problems)
            + "\nEdit this issue (the **⋯** menu on your post, then **Edit**) and I'll check it again."
        )
    shown = {
        k: v for k, v in r.items() if k not in ("submitted_by", "issue", "photo_url") and v not in ("", [], None, {})
    }
    pic = f"\n**Photo:** saved as `{r['photo']}`\n\n<img src=\"{r['photo_url']}\" width=\"240\">\n" if r.get("photo_url") else ""
    note = f"\n**Notes from the submitter:**\n\n> {notes}\n" if notes else ""
    hint = "" if kind != "venue" or r.get("lat") else "\nNo map location yet: add `lat` and `lng` before merging.\n"
    if changed is not None:
        what = "\n".join(changed) if changed else "Nothing changes."
        body = f"Updates `{path}` (from #{r.get('issue')} by @{r.get('submitted_by')}):\n\n{what}\n"
    else:
        body = f"Adds `{path}` (from #{r.get('issue')} by @{r.get('submitted_by')}).\n\n"
        body += f"```json\n{json.dumps(shown, indent=2, ensure_ascii=False)}\n```\n"
    return (
        f"{body}{pic}{note}{hint}\n"
        "Merge to publish it on TOPA; close to turn it down.\n"
    )


def existing(root, kind, r):
    """The band or venue file TOPA already has for this name, or {}."""
    if kind not in ("band", "venue") or not r.get("name"):
        return {}
    try:
        with open(os.path.join(root, c.file_name(kind, r)), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        # a built-in venue: compare with what TOPA shows now
        return c.builtin_venue(r["name"], root) if kind == "venue" else {}


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--body-file", required=True, help="the issue text ('-' reads stdin)")
    args.add_argument("--author", default="")
    args.add_argument("--issue", type=int)
    args.add_argument("--write", action="store_true", help="save the file under community/")
    args.add_argument("--report", help="write the bot's Markdown note here")
    args.add_argument("--github-output", help="append kind/ok/path/title for the workflow")
    args.add_argument("--today", help="pretend it's this date (YYYY-MM-DD), for testing")
    args.add_argument("--root", default=c.ROOT)
    a = args.parse_args()

    body = sys.stdin.read() if a.body_file == "-" else open(a.body_file, encoding="utf-8").read()
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(c.PACIFIC).date()
    fields = parse_form(body)
    kind = kind_of(fields)
    out = {"kind": kind, "ok": "false", "path": "", "title": "", "photo": "", "photo_url": ""}

    if kind:
        venues = c.known_venues(a.root)
        r = to_record(kind, fields, a.author, a.issue, today, venues)
        old = existing(a.root, kind, r)
        if kind in ("band", "venue"):
            r = merge(old, r)
        problems = c.check(kind, r, today, venues)
        r.pop("coords_text", None)
        photo_url = r.pop("photo_url", "") or ""
        if old and not photo_url and old.get("photo"):
            r["photo"] = old["photo"]  # no new photo: keep the one it has
        path = "" if problems else c.file_name(kind, r)
        one_line = " ".join(title(kind, r).split())[:120]
        out.update({"ok": "false" if problems else "true", "path": path, "title": one_line})
        if photo_url and not problems:
            out.update({"photo": r["photo"], "photo_url": photo_url})
        changed = changes(old, r) if old and kind in ("band", "venue") else None
        notes = fields.get(FORMS[kind]["notes"], "")
        text = report(kind, {**r, "photo_url": photo_url}, problems, path, notes, changed)
        print(text)
        if a.report:
            with open(a.report, "w", encoding="utf-8") as f:
                f.write(text)
        if a.write and not problems:
            full = os.path.join(a.root, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                json.dump(r, f, indent=2, ensure_ascii=False)
                f.write("\n")
            print(f"wrote {path}")
    else:
        print("not a TOPA submission form; nothing to do")

    if a.github_output:
        with open(a.github_output, "a", encoding="utf-8") as f:
            for k, v in out.items():
                f.write(f"{k}={v}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
