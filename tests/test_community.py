#
# Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
#
"""Tests for community submissions: reading the GitHub forms, checking them, weekly shows, and merging sources.

Run: python3 -m unittest discover tests
"""

import datetime as dt
import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

import community as c  # noqa: E402
import submissions as s  # noqa: E402

TODAY = dt.date(2026, 10, 27)  # a Tuesday
VENUES = {"Harbor Lights Tavern", "Rosie's Corner (The Annex)", "Pier Street Brewing Co. (Pier Street downtown)"}


def form(**answers):
    """An issue body the way GitHub writes a form: '### Label', a blank line, the answer."""
    return "\n\n".join(f"### {label}\n\n{value or '_No response_'}" for label, value in answers.items())


def show_form(**over):
    answers = {
        "Band or artist": "The Tide Pool Ramblers",
        "Venue": "harbor lights tavern",
        "Date": "11/7",
        "Start time": "7pm",
        "End time": "10:30 PM",
        "Genres and tags": "rock, soul, 21+",
        "Link for the show": "tidepoolramblers.com/shows",
        "Anything else?": "",
        "Permission": "- [X] I'm with the band",
    }
    answers.update(over)
    return form(**answers)


def record(body, today=TODAY):
    fields = s.parse_form(body)
    kind = s.kind_of(fields)
    r = s.to_record(kind, fields, "octocat", 12, today, VENUES)
    return kind, r, c.check(kind, r, today, VENUES)


class Forms(unittest.TestCase):
    def test_labels_match_the_issue_templates(self):
        """The forms and FORMS must use the same labels."""
        folder = os.path.join(HERE, "..", ".github", "ISSUE_TEMPLATE")
        files = {"show": "add-show.yml", "weekly": "add-weekly-show.yml", "band": "add-band.yml", "venue": "add-venue.yml"}
        for kind, name in files.items():
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                labels = set(re.findall(r"^\s+label: (.+)$", f.read(), re.M))
            labels = {x.strip().strip('"') for x in labels} - {"Permission"}  # checkbox, not read
            self.assertEqual(labels, set(s.FORMS[kind].values()), name)

    def test_good_show(self):
        kind, r, problems = record(show_form())
        self.assertEqual(kind, "show")
        self.assertEqual(problems, [])
        self.assertEqual(r["venue"], "Harbor Lights Tavern")  # matched despite the lowercase
        self.assertEqual((r["date"], r["start"], r["end"]), ("2026-11-07", "19:00", "22:30"))
        self.assertEqual(r["tags"], ["rock", "soul", "21+"])
        self.assertEqual(r["link"], "https://tidepoolramblers.com/shows")
        self.assertEqual(c.file_name(kind, r), "community/shows/2026-11-07-harbor-lights-tavern-the-tide-pool-ramblers.json")

    def test_show_problems_are_explained(self):
        _, _, problems = record(show_form(**{"Date": "2026-10-01", "Venue": "Harbr Lights Tavern", "Start time": "7"}))
        text = " ".join(problems)
        self.assertIn("already passed", text)
        self.assertIn("Did you mean “Harbor Lights Tavern”", text)
        self.assertIn("start time", text)

    def test_short_venue_name_matches(self):
        _, r, problems = record(show_form(Venue="Rosie's Corner"))
        self.assertEqual((r["venue"], problems), ("Rosie's Corner (The Annex)", []))

    def test_other_issues_are_ignored(self):
        self.assertEqual(s.kind_of(s.parse_form("The map is wrong on my phone")), "")

    def test_weekly(self):
        body = form(
            **{
                "Band, artist or event": "Tuesday Open Mic",
                "Venue": "Harbor Lights Tavern",
                "Day of the week": "Tuesday",
                "Start time": "7pm",
                "End time": "",
                "First date": "11/3",
                "Last date": "2027-01-26",
                "Skip these dates": "11/24, 12/29",
                "Genres and tags": "open mic",
                "Link for the show": "",
                "Anything else?": "",
            }
        )
        kind, r, problems = record(body)
        self.assertEqual((kind, problems), ("weekly", []))
        self.assertEqual(r["skip"], ["2026-11-24", "2026-12-29"])
        too_long = record(body.replace("2027-01-26", "2027-09-01"))[2]
        self.assertTrue(any("6 months" in p for p in too_long))

    def test_band_and_venue(self):
        band = form(
            **{
                "Band or artist name": "The Tide Pool Ramblers",
                "Genres": "Rock, Soul",
                "Instagram": "@thetidepoolramblers",
                "Apple Music artist link": "https://music.apple.com/us/artist/the-tide-pool-ramblers/12345678",
                "Photo": '<img width="800" alt="band" src="https://github.com/user-attachments/assets/1b2c-3d4e" />',
            }
        )
        kind, r, problems = record(band)
        self.assertEqual((kind, problems), ("band", []))
        self.assertEqual(r["links"]["instagram"], "https://instagram.com/thetidepoolramblers")
        self.assertEqual((r["apple"], r["genres"], r["maintainers"]), ("12345678", ["rock", "soul"], ["octocat"]))
        self.assertEqual(r["photo"], "community/photos/bands/the-tide-pool-ramblers.jpg")
        self.assertEqual(r["photo_url"], "https://github.com/user-attachments/assets/1b2c-3d4e")
        self.assertIn("Drag the image", " ".join(record(band.replace("https://github.com", "http://x.co"))[2]))
        self.assertEqual(c.apple_id("https://itunes.apple.com/us/artist/the-tide-pool-ramblers/id12345678"), "12345678")
        self.assertEqual(c.apple_id("none"), "none")

        venue = form(
            **{
                "Venue": c.NEW_VENUE,
                "Name of the new venue": "The New Spot",
                "Street address": "1 Main St, Ojai, CA 93023",
                "Town": "Ojai",
                "Map location": "https://www.google.com/maps/place/x/@34.4480,-119.2430,17z",
            }
        )
        kind, r, problems = record(venue)
        self.assertEqual((kind, problems), ("venue", []))
        self.assertEqual((r["lat"], r["lng"]), (34.448, -119.243))
        self.assertIn("Couldn't read the map", " ".join(record(venue.replace("@34.4480,-119.2430", "x"))[2]))


class VenueDropdown(unittest.TestCase):
    def test_the_list_is_written_in_order_and_stays_put(self):
        import forms

        with tempfile.TemporaryDirectory() as root:
            folder = os.path.join(root, ".github", "ISSUE_TEMPLATE")
            os.makedirs(folder)
            path = os.path.join(folder, "add-show.yml")
            with open(path, "w") as f:
                f.write("body:\n  - type: input\n    id: band\n  # venues:start\n  # venues:end\n  - type: input\n")
            venues = {"The Lantern", "Harbor Lights Tavern", 'Sam\'s Place (The "Vine")'}
            self.assertEqual(forms.update(root, venues), ["add-show.yml"])
            self.assertEqual(forms.update(root, venues), [])  # nothing new: the file is left alone
            text = open(path).read()
            options = re.findall(r'^        - (".*")$', text, re.M)
            self.assertEqual(
                [json.loads(o) for o in options],
                ["Harbor Lights Tavern", "The Lantern", 'Sam\'s Place (The "Vine")', c.NOT_LISTED],  # A-Z, ignoring "The"
            )
            self.assertTrue(text.endswith("  # venues:end\n  - type: input\n"))

    def test_not_listed_says_what_to_do(self):
        _, _, problems = record(show_form(Venue=c.NOT_LISTED))
        self.assertIn("doesn't have this venue yet", " ".join(problems))


class Updates(unittest.TestCase):
    """Sending the band or venue form again changes only what's filled in."""

    OLD = {
        "name": "Saltgrass",
        "genres": ["surf"],
        "town": "Ventura",
        "links": {"website": "https://saltgrass.band", "facebook": "https://facebook.com/saltgrass"},
        "apple": "123",
        "photo": "community/photos/bands/saltgrass.jpg",
        "maintainers": ["first"],
    }

    def update(self, **answers):
        body = form(**{"Band or artist name": "Saltgrass", **answers})
        fields = s.parse_form(body)
        return s.merge(self.OLD, s.to_record("band", fields, "second", 9, TODAY, VENUES))

    def test_blank_answers_keep_what_is_there(self):
        r = self.update(Website="https://saltgrass.com")
        self.assertEqual(r["links"], {"website": "https://saltgrass.com", "facebook": "https://facebook.com/saltgrass"})
        self.assertEqual((r["genres"], r["town"], r["apple"]), (["surf"], "Ventura", "123"))
        self.assertEqual(r["photo"], "community/photos/bands/saltgrass.jpg")
        self.assertEqual(r["maintainers"], ["first", "second"])
        self.assertEqual(s.changes(self.OLD, r), ["- **links.website**: https://saltgrass.band → https://saltgrass.com"])

    def test_a_bad_link_in_an_update_is_still_caught(self):
        r = self.update(Bandcamp="not a link")
        self.assertEqual(c.check("band", r, TODAY, VENUES), ["The bandcamp link doesn't look like a web address."])

    def test_remove_clears_a_field(self):
        r = self.update(Facebook="remove", Hometown="REMOVE")
        self.assertEqual(r["links"], {"website": "https://saltgrass.band"})
        self.assertEqual(r["town"], "")

    def test_a_new_band_has_no_remove_markers(self):
        fields = s.parse_form(form(**{"Band or artist name": "New", "Facebook": "remove"}))
        r = s.merge({}, s.to_record("band", fields, "x", 1, TODAY, VENUES))
        self.assertEqual(r["links"], {})

    def test_a_built_in_venue_update_shows_only_the_change(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "data.js"), "w") as f:
                f.write('const KNOWN_VENUES = {\n  "Old Spot": [34.2, -119.2],\n};\n'
                        'const VENUE_PHONES = {\n  "Old Spot": "(805) 555-0100",\n};\n')
            with open(os.path.join(root, "events.json"), "w") as f:
                json.dump({"events": [{"venue": "Old Spot", "address": "1 Main St, Ojai", "city": "Ojai"}]}, f)
            body = form(**{"Venue": "Old Spot", "Name of the new venue": "", "Street address": "1 Main St, Ojai",
                           "Town": "Ojai", "Map location": "34.2, -119.2", "Phone": "(805) 555-0199"})
            r = s.to_record("venue", s.parse_form(body), "x", 1, TODAY, {"Old Spot"})
            old = s.existing(root, "venue", r)
            self.assertEqual(s.changes(old, s.merge(old, r)), ["- **phone**: (805) 555-0100 → (805) 555-0199"])

    def test_venue_update_needs_no_address(self):
        old = {"name": "The New Spot", "address": "1 Main St", "city": "Ojai", "lat": 34.4, "lng": -119.2}
        fields = s.parse_form(form(**{"Venue": "The New Spot", "Name of the new venue": "", "Phone": "(805) 555-0100"}))
        r = s.merge(old, s.to_record("venue", fields, "x", 1, TODAY, VENUES))
        self.assertEqual(c.check("venue", r, TODAY, VENUES), [])
        self.assertEqual((r["address"], r["lat"], r["phone"]), ("1 Main St", 34.4, "(805) 555-0100"))


class Loading(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, kind, name, rec):
        folder = os.path.join(self.root, "community", c.FOLDERS[kind])
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, name), "w", encoding="utf-8") as f:
            json.dump(rec, f)

    def test_weekly_shows_expand_across_daylight_saving(self):
        self.put(
            "weekly",
            "a.json",
            {"band": "Open Mic", "venue": "Harbor Lights Tavern", "weekday": "Sunday", "start": "19:00",
             "first": "2026-10-25", "until": "2026-11-15", "skip": ["2026-11-08"]},
        )
        events, _, _ = c.load(self.root, today=TODAY)
        self.assertEqual(
            [e["start"] for e in events],
            ["2026-11-01T19:00:00-08:00", "2026-11-15T19:00:00-08:00"],  # Nov 1 is after the clocks change
        )

    def test_shows_get_venue_and_band_details(self):
        self.put("venue", "v.json", {"name": "The New Spot", "address": "1 Main St, Ojai", "city": "Ojai",
                                     "lat": 34.448, "lng": -119.243})
        self.put("band", "b.json", {"name": "Saltgrass", "genres": ["surf"], "links": {"website": "https://saltgrass.band"}})
        self.put("show", "s.json", {"band": "Saltgrass", "venue": "The New Spot", "date": "2026-11-07",
                                    "start": "21:00", "end": "01:00", "tags": [], "link": ""})
        self.put("show", "old.json", {"band": "Saltgrass", "venue": "The New Spot", "date": "2026-10-01", "start": "21:00"})
        events, bands, venues = c.load(self.root, today=TODAY)
        self.assertEqual(len(events), 1)  # the October show is over
        e = events[0]
        self.assertEqual((e["city"], e["lat"], e["tags"], e["source"]), ("Ojai", 34.448, ["surf"], "community"))
        self.assertEqual(e["end"], "2026-11-08T01:00:00-08:00")  # past midnight
        self.assertEqual(bands["Saltgrass"]["links"], {"website": "https://saltgrass.band"})
        self.assertIn("The New Spot", c.known_venues(self.root))

    def test_other_names_point_to_the_band(self):
        self.put("band", "b.json", {"name": "Saltgrass", "aliases": ["The Saltgrass Band"], "genres": ["surf"]})
        _, bands, _ = c.load(self.root, today=TODAY)
        self.assertEqual(bands["The Saltgrass Band"]["alias_of"], "Saltgrass")
        self.assertNotIn("alias_of", bands["Saltgrass"])

    def test_own_photos_fill_in_but_a_venue_photo_wins(self):
        for path in ("photos/venues/the-new-spot.jpg", "photos/venues/harbor-lights-tavern.jpg"):
            os.makedirs(os.path.join(self.root, os.path.dirname(path)), exist_ok=True)
            open(os.path.join(self.root, path), "wb").close()
        venues = {"The New Spot": {"photo": "community/photos/venues/the-new-spot.jpg"}}
        events = [{"venue": "The New Spot", "artist": "A"}, {"venue": "Harbor Lights Tavern", "artist": "B"}]
        c.add_own_photos(venues, {}, events, self.root)
        self.assertEqual(venues["The New Spot"]["photo"], "community/photos/venues/the-new-spot.jpg")
        self.assertEqual(venues["Harbor Lights Tavern"]["photo"], "photos/venues/harbor-lights-tavern.jpg")


class Merging(unittest.TestCase):
    def ev(self, artist, venue, start, source):
        return {"artist": artist, "venue": venue, "start": start, "source": source}

    def test_better_source_wins(self):
        ours = [self.ev("Tide Pool Ramblers", "Harbor Lights Tavern", "2026-11-07T20:00:00-08:00", "community")]
        bot = [self.ev("The Tide Pool Ramblers w/ Friends", "Harbor Lights Tavern", "2026-11-07T19:30:00-08:00", "bot"),
               self.ev("Saltgrass", "Harbor Lights Tavern", "2026-11-08T19:00:00-08:00", "bot")]
        vr = [self.ev("The Tide Pool Ramblers", "Harbor Lights Tavern", "2026-11-07T19:00:00-08:00", "ventura-rocks"),
              self.ev("Saltgrass", "Harbor Lights Tavern", "2026-11-08T19:00:00-08:00", "ventura-rocks"),
              self.ev("The Tide Pool Ramblers", "Rosie's Corner (The Annex)", "2026-11-07T19:00:00-08:00", "ventura-rocks"),
              self.ev("Different Band", "Harbor Lights Tavern", "2026-11-07T22:00:00-08:00", "ventura-rocks")]
        merged, dropped = c.merge([ours, bot, vr])
        self.assertEqual(
            [(e["artist"], e["source"]) for e in merged],
            [("Tide Pool Ramblers", "community"), ("Saltgrass", "bot"),
             ("The Tide Pool Ramblers", "ventura-rocks"), ("Different Band", "ventura-rocks")],  # other venue, other band
        )
        self.assertEqual(dropped, {1: 1, 2: 2})

    def test_same_band(self):
        self.assertTrue(c.same_band("The Tide Pool Ramblers", "tide pool ramblers"))
        self.assertTrue(c.same_band("Wren & the Night Owls", "Wren and the Night Owls & Friends"))
        self.assertTrue(c.same_band("The Tide Pool Ramblers", "The Tide Pool Ramblrs"))
        self.assertFalse(c.same_band("Open Mic", "Jazz Night"))
        self.assertFalse(c.same_band("DJ", "DJ Shadow"))  # too short to count as a prefix


if __name__ == "__main__":
    unittest.main()
