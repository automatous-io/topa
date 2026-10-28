#!/usr/bin/env python3
#
# Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
#
"""Shrink a band or venue photo: JPEG, 900px max, upright, no GPS.

Usage:
    python3 scripts/photos.py --url https://github.com/user-attachments/assets/... --out community/photos/bands/x.jpg
    python3 scripts/photos.py --file ~/Pictures/harbor-lights.heic --out photos/venues/harbor-lights-tavern.jpg

Uses Pillow, or macOS's sips.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

LONGEST = 900  # pixels
QUALITY = 82
MAX_DOWNLOAD = 20 * 1024 * 1024  # 20 MB
USER_AGENT = "TOPA-local-music-finder/1.0 (+https://github.com/automatous-io/topa)"


def download(url, to):
    """Save an image someone attached to a GitHub form. Only GitHub's own image links are allowed."""
    if not url.startswith(("https://github.com/user-attachments/assets/", "https://user-images.githubusercontent.com/")):
        raise ValueError("not a GitHub image link")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        kind = response.headers.get("Content-Type", "")
        if not kind.startswith("image/"):
            raise ValueError(f"that link isn't an image ({kind or 'unknown type'})")
        data = response.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise ValueError("the photo is over 20 MB")
    with open(to, "wb") as f:
        f.write(data)


def shrink(src, out):
    """src (any common image type) -> out, a small JPEG with no hidden details."""
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    try:
        from PIL import Image, ImageOps
    except ImportError:
        Image = None
    if Image:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)  # apply the phone's rotation
            im.thumbnail((LONGEST, LONGEST))
            im.convert("RGB").save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)  # no exif = no GPS
        return
    if shutil.which("sips"):  # macOS
        size = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", src], capture_output=True, text=True)
        longest = max([int(n) for n in re.findall(r"pixel(?:Width|Height): (\d+)", size.stdout)] or [0])
        resize = ["-Z", str(LONGEST)] if longest > LONGEST else []  # only ever smaller
        subprocess.run(
            ["sips", *resize, "-s", "format", "jpeg", "-s", "formatOptions", str(QUALITY), src, "--out", out],
            check=True,
            capture_output=True,
        )
        # sips keeps the metadata; drop the GPS part
        for prop in ("GPS", "gpsInfo"):
            subprocess.run(["sips", "--deleteProperty", prop, out], capture_output=True)
        return
    raise RuntimeError("needs Pillow (pip install pillow) or macOS")


def main():
    args = argparse.ArgumentParser(description="Shrink a band or venue photo for TOPA")
    src = args.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="a GitHub image link from a form")
    src.add_argument("--file", help="a photo on this computer")
    args.add_argument("--out", required=True, help="where to save the JPEG")
    a = args.parse_args()
    try:
        if a.url:
            with tempfile.TemporaryDirectory() as tmp:
                raw = os.path.join(tmp, "photo")
                download(a.url, raw)
                shrink(raw, a.out)
        else:
            shrink(os.path.expanduser(a.file), a.out)
    except Exception as e:  # noqa: BLE001 - any failure is reported the same way
        print(f"couldn't use that photo: {e}", file=sys.stderr)
        return 1
    print(f"wrote {a.out} ({os.path.getsize(a.out) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
