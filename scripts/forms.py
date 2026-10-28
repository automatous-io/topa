#!/usr/bin/env python3
#
# Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
#
"""Keep the forms' venue dropdowns (.github/ISSUE_TEMPLATE) in step with the venues TOPA knows.

Rewrites the list between "# venues:start" and "# venues:end". fetch_events.py runs it on every update.
Standard library only.
"""

import json
import os
import sys

import community as c

START, END = "  # venues:start", "  # venues:end"

# each form with a venue list: field id, the words above it, and the extra choices (first, last)
FORMS = {
    "add-show.yml": (
        "venue",
        "Pick the venue. Not listed? Add it first with **Add or update a venue**, then come back.",
        [],
        [c.NOT_LISTED],
    ),
    "add-weekly-show.yml": (
        "venue",
        "Pick the venue. Not listed? Add it first with **Add or update a venue**, then come back.",
        [],
        [c.NOT_LISTED],
    ),
    "add-venue.yml": (
        "pick",
        "Pick the venue to change it, or pick **New venue** and type its name below.",
        [c.NEW_VENUE],
        [],
    ),
}


def block(venues, form="add-show.yml"):
    """The dropdown as form YAML."""
    field, words, first, last = FORMS[form]
    # A-Z ignoring "The"; full name breaks ties
    options = sorted(set(venues), key=lambda v: (c.short_name(v).lower().removeprefix("the "), v))
    lines = [
        START,
        "  # written by scripts/forms.py; edits here get replaced",
        "  - type: dropdown",
        f"    id: {field}",
        "    attributes:",
        "      label: Venue",
        f"      description: {words}",
        "      options:",
        *[f"        - {json.dumps(v, ensure_ascii=False)}" for v in first + options + last],
        "    validations:",
        "      required: true",
        END,
    ]
    return "\n".join(lines)


def update(root, venues):
    """Rewrite the venue dropdown in each show form. Returns the forms that changed."""
    changed = []
    for name in FORMS:
        path = os.path.join(root, ".github", "ISSUE_TEMPLATE", name)
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        if START not in text or END not in text:
            print(f"{name}: no '# venues:start' / '# venues:end' lines; left alone")
            continue
        before, rest = text.split(START, 1)
        after = rest.split(END, 1)[1]
        new = before + block(venues, name) + after
        if new != text:
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)
            changed.append(name)
    return changed


def main():
    venues = c.known_venues()
    changed = update(c.ROOT, venues)
    print(f"{len(venues)} venues; " + (f"updated {', '.join(changed)}" if changed else "forms already up to date"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
