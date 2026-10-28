#
# Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
#
"""Shows, weekly shows, bands and venues people add through TOPA's GitHub forms.

One JSON file per item under community/. Standard library only.
"""

import datetime as dt
import difflib
import json
import os
import re
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo("America/Los_Angeles")  # all venues are in Ventura County
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
FOLDERS = {"show": "shows", "weekly": "weekly", "band": "bands", "venue": "venues"}
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
WEEKLY_MAX_DAYS = 183  # weekly shows run up to ~6 months
SHOW_MAX_DAYS = 366  # one-off shows up to a year out
NOT_LISTED = "Not listed (add it first with Add or update a venue)"  # the last choice in the show forms' venue list
NEW_VENUE = "New venue (type its name below)"  # the first choice in the venue form's list
LINK_KEYS = ["website", "instagram", "facebook", "bandcamp", "spotify", "youtube", "soundcloud"]


# ---- small parsers (forgiving about how people type things) ----


def slug(text):
    """'The Tide Pool Ramblers' -> 'the-tide-pool-ramblers' (safe for a file name)."""
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower().replace("&", " and ")).strip("-")
    return s[:60].strip("-") or "item"


def parse_date(text, today):
    """'2026-11-07', '11/7/2026', '11/7/26' or '11/7' (the next Nov 7) -> date, or None."""
    t = (text or "").strip()
    no_year = False
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", t)
    if m:
        y, mo, d = map(int, m.groups())
    else:
        m = re.fullmatch(r"(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?", t)
        if not m:
            return None
        mo, d = int(m.group(1)), int(m.group(2))
        no_year = not m.group(3)
        y = today.year if no_year else int(m.group(3))
        if y < 100:
            y += 2000
    try:
        day = dt.date(y, mo, d)
        if no_year and day < today:
            day = day.replace(year=day.year + 1)  # "1/9" in December means next January
    except ValueError:
        return None
    return day


def parse_time(text):
    """'7pm', '7:30 PM', '19:00', 'noon' -> 'HH:MM' (24-hour), or None."""
    t = (text or "").strip().lower().replace(".", "")
    if t == "noon":
        return "12:00"
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?", t)
    if not m:
        return None
    h, mins, half = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if half:
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if half.startswith("p") else 0)
    elif m.group(2) is None:
        return None  # "7" alone could be morning or night
    if h > 23 or mins > 59:
        return None
    return f"{h:02d}:{mins:02d}"


def parse_list(text):
    """'rock, blues / 21+' -> ['rock', 'blues', '21+']."""
    return [x.strip() for x in re.split(r"[,;/\n]", text or "") if x.strip()]


def parse_link(text, key=""):
    """A link or Instagram @handle -> a full https link. '' when empty, None when it isn't a link."""
    t = (text or "").strip()
    if not t:
        return ""
    if key == "instagram" and re.fullmatch(r"@?[\w.]{1,30}", t):
        return "https://instagram.com/" + t.lstrip("@")
    if not re.match(r"^https?://", t, re.I) and re.match(r"^[\w-]+(\.[\w-]+)+(/\S*)?$", t):
        t = "https://" + t  # "tidepoolramblers.com" -> "https://tidepoolramblers.com"
    if not re.fullmatch(r"https?://[^\s\"'<>()\\]+", t, re.I):
        return None
    return re.sub(r"^http://", "https://", t, flags=re.I)


def parse_coords(text):
    """'34.24, -119.26' or a Google Maps link with '@34.24,-119.26' or 'q=34.24,-119.26' -> (lat, lng), or None."""
    m = re.search(r"(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)", text or "")
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    if not (18 <= lat <= 72 and -170 <= lng <= -65):  # roughly the United States
        return None
    return round(lat, 6), round(lng, 6)


def apple_id(text):
    """Apple Music artist link -> its id. 'none' turns previews off. None when it can't be read."""
    t = (text or "").strip()
    if not t:
        return ""
    if t.lower() in ("none", "no", "off"):
        return "none"
    m = (
        re.search(r"music\.apple\.com/(?:[a-z]{2}/)?artist/(?:[^/?#]+/)?(\d+)", t)
        or re.search(r"itunes\.apple\.com/.*?/id(\d+)", t)
        or re.fullmatch(r"(\d+)", t)
    )
    return m.group(1) if m else None


def photo_link(text):
    """The image link from a form's Photo box. '' when empty, None when there's no image."""
    t = (text or "").strip()
    if not t:
        return ""
    m = re.search(
        r"https://(?:github\.com/user-attachments/assets/[\w-]+|user-images\.githubusercontent\.com/[\w/.-]+)", t
    )
    return m.group(0) if m else None


def photo_path(kind, name):
    """Where a band's or venue's own photo is kept: community/photos/bands/the-tide-pool-ramblers.jpg."""
    return f"community/photos/{FOLDERS[kind]}/{slug(short_name(name))}.jpg"


def own_photo_path(kind, name):
    """Where TOPA's own photos go: photos/venues/harbor-lights-tavern.jpg."""
    return f"photos/{FOLDERS[kind]}/{slug(short_name(name))}.jpg"


# ---- venues TOPA already knows ----


def known_venues(root=ROOT):
    """Every venue name TOPA knows: data.js, community/venues/, and any venue in the current listings."""
    names = set()
    try:
        with open(os.path.join(root, "events.json"), encoding="utf-8") as f:
            names.update(e["venue"] for e in json.load(f).get("events") or [] if e.get("venue"))
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        with open(os.path.join(root, "data.js"), encoding="utf-8") as f:
            js = f.read()
        block = js[js.index("const KNOWN_VENUES = {") : js.index("\n};", js.index("const KNOWN_VENUES = {"))]
        for quoted, bare in re.findall(r'^\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*)):\s*\[', block, re.M):
            names.add(json.loads(f'"{quoted}"') if quoted else bare)
    except (OSError, ValueError):
        pass
    names.update(v["name"] for v in read_folder(root, "venue"))
    return names


def js_object(js, name):
    """One `const NAME = {...}` block from data.js -> a dict."""
    try:
        start = js.index(f"const {name} = {{")
        body = js[start : js.index("\n};", start)]
    except ValueError:
        return {}
    out = {}
    for quoted, bare, value in re.findall(r'^\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*)):\s*(.+?),?$', body, re.M):
        try:
            out[json.loads(f'"{quoted}"') if quoted else bare] = json.loads(value)
        except ValueError:
            pass
    return out


def builtin_venue(name, root=ROOT):
    """A built-in venue's current details: data.js plus the address from the listings."""
    try:
        with open(os.path.join(root, "data.js"), encoding="utf-8") as f:
            js = f.read()
    except OSError:
        js = ""
    spot = js_object(js, "KNOWN_VENUES").get(name)
    out = {
        "name": name,
        "lat": spot[0] if spot else None,
        "lng": spot[1] if spot else None,
        "phone": js_object(js, "VENUE_PHONES").get(name, ""),
        "website": js_object(js, "VENUE_SITES").get(name, ""),
    }
    try:
        with open(os.path.join(root, "events.json"), encoding="utf-8") as f:
            e = next((e for e in json.load(f).get("events") or [] if e.get("venue") == name and e.get("address")), {})
        out.update({"address": e.get("address", ""), "city": e.get("city", "")})
    except (OSError, ValueError):
        pass
    return {k: v for k, v in out.items() if v not in ("", None)} if len(out) > 1 else {}


def short_name(v):
    """The way the app shows a venue: 'Rosie's Corner (The Annex)' -> "Rosie's Corner"."""
    return re.sub(r"\s+", " ", re.sub(r"\s*\(.*?\)\s*", " ", v)).strip()


def match_venue(name, venues):
    """The venue someone typed, matched loosely. Returns (name, hints)."""
    n = (name or "").strip()
    if n in venues:
        return n, []
    low = {v.lower(): v for v in venues}
    short = {short_name(v).lower(): v for v in venues}
    hit = low.get(n.lower()) or short.get(short_name(n).lower())
    if hit:
        return hit, []
    return None, difflib.get_close_matches(n, sorted(venues), n=3, cutoff=0.5)


# ---- checking a record ----


def check(kind, r, today, venues):
    """What's wrong with a record, in plain English (an empty list means it's ready)."""
    problems = []
    need = lambda key, what: problems.append(f"Please add {what}.") if not r.get(key) else None
    bad = lambda key: key in r and r[key] is None  # filled in, but it didn't read right (blank is fine)

    if kind in ("show", "weekly"):
        need("band", "the band or artist name")
        if not r.get("venue"):
            problems.append("Please add the venue.")
        elif r["venue"] == NOT_LISTED:
            problems.append(
                "TOPA doesn't have this venue yet. Add it with the \u201cAdd or update a venue\u201d form first; "
                "once that's approved, edit this issue and pick the venue."
            )
        elif r["venue"] not in venues:
            hint = match_venue(r["venue"], venues)[1]
            problems.append(
                f"TOPA doesn't know the venue “{r['venue']}” yet."
                + (f" Did you mean {', '.join(chr(8220) + h + chr(8221) for h in hint)}?" if hint else "")
                + " If it's new, add it first with the “Add or update a venue” form."
            )
        if not r.get("start"):
            problems.append("Please add a start time like 7pm or 19:00.")
        if bad("link"):
            problems.append("The link doesn't look like a web address (it should start with https://).")
    if kind == "show":
        d = r.get("date")
        if not d:
            problems.append("Please add the date like 2026-11-07 or 11/7.")
        else:
            day = dt.date.fromisoformat(d)
            if day < today:
                problems.append(f"The date {d} has already passed.")
            elif (day - today).days > SHOW_MAX_DAYS:
                problems.append("TOPA lists shows up to a year ahead; please pick a closer date.")
    if kind == "weekly":
        if r.get("weekday") not in WEEKDAYS:
            problems.append("Please pick the day of the week.")
        first, until = r.get("first"), r.get("until")
        if not first:
            problems.append("Please add the first date like 2026-11-03.")
        if not until:
            problems.append("Please add the last date (weekly shows run up to 6 months, and you can renew them).")
        if first and until:
            a, b = dt.date.fromisoformat(first), dt.date.fromisoformat(until)
            if b < a:
                problems.append("The last date is before the first date.")
            elif b < today:
                problems.append("The last date has already passed.")
            elif (b - max(a, today)).days > WEEKLY_MAX_DAYS:
                problems.append("Weekly shows can run up to 6 months at a time; please pick an earlier last date.")
            if r.get("weekday") in WEEKDAYS and not any(
                (a + dt.timedelta(days=i)).weekday() == WEEKDAYS.index(r["weekday"])
                for i in range(min((b - a).days + 1, 7))
            ):
                problems.append(f"There's no {r['weekday']} between the first and last date.")
        if bad("skip"):
            problems.append("The skip dates should look like 2026-11-24, 12/29.")
    if kind == "band":
        need("name", "the band or artist name")
        links = r.get("links") or {}
        for key in LINK_KEYS:
            if key in links and links[key] is None:
                problems.append(f"The {key} link doesn't look like a web address.")
        if bad("apple"):
            problems.append(
                "The Apple Music link should look like https://music.apple.com/us/artist/name/12345 (or say none)."
            )
    if kind in ("band", "venue") and bad("photo_url"):
        problems.append("Couldn't find the photo. Drag the image file itself into the Photo box.")
    if kind == "venue":
        need("name", "the venue: pick it, or pick New venue and type its name")
        need("address", "the street address (needed for a new venue)")
        need("city", "the town (needed for a new venue)")
        # an existing venue is fine (it's an update)
        if bad("website"):
            problems.append("The website doesn't look like a web address.")
        if r.get("coords_text") and not r.get("lat"):
            problems.append("Couldn't read the map location; paste a Google Maps link or numbers like 34.24, -119.26.")
    return problems


def file_name(kind, r):
    """Where a record lives, e.g. community/shows/2026-11-07-<venue>-<band>.json."""
    if kind == "show":
        base = f"{r['date']}-{slug(short_name(r['venue']))}-{slug(r['band'])}"
    elif kind == "weekly":
        base = f"{slug(short_name(r['venue']))}-{slug(r['band'])}-{r['weekday'].lower()}"
    else:
        base = slug(r["name"])
    return f"community/{FOLDERS[kind]}/{base}.json"


# ---- the same show from two sources ----


def name_key(s):
    """For comparing band names: lowercase, letters and digits only, '&' = 'and', no leading 'the'."""
    s = re.sub(r"^the\s+", "", (s or "").lower().replace("&", " and ").strip())
    return re.sub(r"[^a-z0-9]", "", s)


def same_band(a, b):
    """'The Tide Pool Ramblers' ~ 'Tide Pool Ramblers w/ Friends' ~ 'The Tide Pool Ramblrs' (only within one venue
    and day)."""
    x, y = name_key(a), name_key(b)
    if not x or not y:
        return False
    if x == y:
        return True
    short, long = sorted((x, y), key=len)
    if len(short) >= 4 and long.startswith(short):
        return True  # one listing adds a guest or a tour name after the band
    return difflib.SequenceMatcher(None, x, y).ratio() >= 0.85  # typos


def same_show(a, b):
    """Same venue, day and band. The time can differ."""
    venue = lambda e: short_name(e["venue"]).lower()
    return venue(a) == venue(b) and a["start"][:10] == b["start"][:10] and same_band(a["artist"], b["artist"])


def merge(ranked):
    """Combine sources, best first. Drops shows a better source already has.
    Returns (shows, {source index: number dropped})."""
    merged, by_day, dropped = [], {}, {}
    for rank, events in enumerate(ranked):
        for e in events:
            day = e["start"][:10]
            if any(same_show(e, s) for s in by_day.get(day, []) if s["_rank"] < rank):
                dropped[rank] = dropped.get(rank, 0) + 1
                continue
            merged.append(e)
            by_day.setdefault(day, []).append({**e, "_rank": rank})
    return merged, dropped


# ---- reading every file and making events ----


def read_folder(root, kind):
    """Every record of one kind, each with the file it came from in '_file'. Unreadable files are skipped."""
    folder = os.path.join(root, "community", FOLDERS[kind])
    out = []
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            print(f"skipping unreadable community/{FOLDERS[kind]}/{name}")
            continue
        if isinstance(rec, dict):
            out.append({**rec, "_file": name})
    return out


def at(day, hhmm):
    """date + '19:00' -> that moment in Pacific time, as an aware datetime."""
    h, m = map(int, hhmm.split(":"))
    return dt.datetime(day.year, day.month, day.day, h, m, tzinfo=PACIFIC)


def event(r, day, venues, bands):
    """One community show on one day -> an event like the ones in events.json."""
    start = at(day, r["start"])
    end = None
    if r.get("end"):
        end = at(day, r["end"])
        if end <= start:
            end = at(day + dt.timedelta(days=1), r["end"])  # 9pm to 1am ends the next day
    v = venues.get(r["venue"]) or {}
    band = bands.get(r["band"]) or {}
    e = {
        "artist": r["band"],
        "start": start.isoformat(),
        "end": end.isoformat() if end else None,
        "venue": r["venue"],
        "address": v.get("address", ""),
        "city": v.get("city", ""),
        "tags": r.get("tags") or band.get("genres") or [],
        "url": r.get("link") or "",
        "source": "community",
    }
    if v.get("lat") is not None:
        e["lat"], e["lng"] = v["lat"], v["lng"]
    return e


def load(root=ROOT, today=None):
    """community/ -> (events, bands, venues). Skips past shows; weekly shows become one event per week."""
    today = today or dt.datetime.now(PACIFIC).date()
    venues = {}
    for v in read_folder(root, "venue"):
        if v.get("name"):
            keep = ("address", "city", "lat", "lng", "phone", "website", "photo")
            venues[v["name"]] = {k: v[k] for k in keep if v.get(k) not in (None, "")}
    bands = {}
    for b in read_folder(root, "band"):
        if b.get("name"):
            info = {k: b[k] for k in ("genres", "town", "apple", "photo") if b.get(k)}
            links = {k: u for k, u in (b.get("links") or {}).items() if u}
            if links:
                info["links"] = links
            bands[b["name"]] = info
            for alias in b.get("aliases") or []:
                bands.setdefault(alias, info)

    events = []
    for r in read_folder(root, "show"):
        try:
            day = dt.date.fromisoformat(r["date"])
            if day >= today - dt.timedelta(days=1):
                events.append(event(r, day, venues, bands))
        except (KeyError, ValueError, TypeError):
            print(f"skipping community/shows/{r['_file']}: missing or bad band, venue, date or start")
    for r in read_folder(root, "weekly"):
        try:
            first, until = dt.date.fromisoformat(r["first"]), dt.date.fromisoformat(r["until"])
            weekday = WEEKDAYS.index(r["weekday"])
            skip = set(r.get("skip") or [])
            day = max(first, today - dt.timedelta(days=1))
            last = min(until, today + dt.timedelta(days=WEEKLY_MAX_DAYS))
            while day <= last:
                if day.weekday() == weekday and day.isoformat() not in skip:
                    events.append(event(r, day, venues, bands))
                day += dt.timedelta(days=1)
        except (KeyError, ValueError, TypeError):
            print(f"skipping community/weekly/{r['_file']}: missing or bad fields")
    return events, bands, venues


def add_own_photos(venues, bands, events, root=ROOT):
    """Use TOPA's own photos (photos/) where a venue or band hasn't sent one."""
    for kind, details, names in (
        ("venue", venues, {e["venue"] for e in events if e.get("venue")}),
        ("band", bands, {e["artist"] for e in events if e.get("artist")}),
    ):
        for name in names:
            path = own_photo_path(kind, name)
            if not (details.get(name) or {}).get("photo") and os.path.exists(os.path.join(root, path)):
                details[name] = {**details.get(name, {}), "photo": path}
