# TOPA Local Music Finder

*A personal project by local music lovers who wanted to find live local music nearby, pick a show fast, and have their Tesla navigate there. The future is now!*

**What's playing tonight, and what does it sound like?** TOPA is a Spotify-style live music finder for Ventura County, designed first for a Tesla's touchscreen and then for phones. Open it, see upcoming shows, tap ▶ to hear a band, and go.

<img src="screenshots/tesla-11-player.png" alt="TOPA on a Tesla-sized screen with the preview player running" width="100%">

<table>
  <tr>
    <td width="33%"><img src="screenshots/phone-01-shows.png" alt="Today's shows on a phone, with faves pinned on top"></td>
    <td width="33%"><img src="screenshots/phone-07-venue-page.png" alt="A venue's lineup on a phone"></td>
    <td width="33%"><img src="screenshots/phone-09-faves.png" alt="Faved bands and venues on a phone"></td>
  </tr>
</table>

More in [`screenshots/`](screenshots/): every page at Tesla size (1920×1200) and phone size.

## What it does

- **Today first.** It opens on today's shows ("Today" until 4pm, then "Tonight") with big start times, then lets you pick
  another day, the weekend, or a genre. Each row shows the band, venue, town and distance.
- **Hear before you go.** Green ▶ buttons play 30-second song previews. "Play all" runs through a whole night's lineup like a radio, and the player shows where and when each band is playing.
- **Bands and venues.** Every band and venue has its own page: dates, lineup, call, website, and directions. The Venues
  tab is a list showing each venue's town, distance, show count and next show.
- **Faves.** Tap any star to fave a band or venue, on a row or right on a band's photo. When a fave is playing on the day
  you're looking at, it's pinned at the top of Shows, and shows at a faved venue are tagged "★ Fave venue". The Faves tab
  switches between your bands and venues.
- **Distance when you want it.** It shows every show by default. Pick 5, 10 or 25 miles to narrow it down. Distances only appear when the browser shares your location, so it never shows guessed ones.
- **Getting there.** Directions open Google Maps. In the car's own browser, show and venue pages also show the phrase to say
  ("Navigate to The Grape") and the address, since a map link in the browser may not start the car's navigation.
- **Works like an app.** You can add it to a phone's home screen (iPhone: Safari → Share → Add to Home Screen; Android:
  Chrome → ⋮ → Install app), it keeps working offline with the last listings, and the browser's back button (or swipe-back) moves through pages.
- **About.** Credits, how it works, and links to this repo live in an About popup, opened from the sidebar on the Tesla
  or the bottom bar on phones, so the main screens stay clean.

## Design decisions

Built for glancing at a car screen, then refined for phones:

- **Big targets, one tap.** Main buttons are 44–60px tall. Choices are buttons you can see, not dropdowns or sliders. Picking a distance is one tap and closes the panel, and every star faves in one tap without leaving the page.
- **The sidebar sits on the left on the Tesla.** It's the closest edge to the driver, it uses width (which the screen has plenty of) instead of height, and it keeps app buttons away from Tesla's own controls at the bottom. Phones get a bottom tab bar instead.
- **Fewer places to look.** Search sits in the Shows header instead of on its own tab, and there's no separate Home page. The menu is Shows · Bands · Venues · Faves.
- **Short headers.** Title, count, search and the main buttons share one row on the Tesla, so more shows fit on screen.
- **Rows that scroll sideways say so.** Day and genre rows fade at the edge and show ‹ › arrows on the Tesla when more chips
  are hidden. Phones show a cut-off chip and swipe instead.
- **Plain-English times.** "Today 1pm", "Tonight 8pm", or a date like "Sat 10/31" for anything later, and shows that
  already ended drop off.
- **No repeated information.** Single-day lists show only times, since the date is in the title. Band pages lead with the
  venue on each row, and a venue's page drops the venue line, since it's in the header. Each list shows one fave star per band.
- **Green means play or selected, yellow means fave.**

## How it works

No backend, no API keys, no cost. It's a static site on GitHub Pages plus a scheduled GitHub Action.

```
Ventura Rocks calendar (Tockify)
        │  scripts/fetch_events.py, run by GitHub Actions 3× a day
        ▼
   events.json  ──────────►  index.html + app.js (one page, no build step)
  (facts only)               ├─ loads events.json from the same site
                             ├─ Deezer API (JSONP): artist photos + 30s previews
                             └─ sw.js: offline cache
```

1. **Listings.** [`scripts/fetch_events.py`](scripts/fetch_events.py) (Python standard library only) reads the calendar's public
   `monthly` and `upcoming` pages, keeps only facts (band, time, venue, address, town, tags, link), merges and de-duplicates them,
   and writes `events.json`. If the page won't parse, it exits with an error and leaves the old file alone.
2. **Schedule.** [`.github/workflows/update-events.yml`](.github/workflows/update-events.yml) runs it around 7am, noon and 4pm Pacific
   and commits `events.json` only when the listings changed.
3. **The app.** `index.html` shows the last saved listings right away (so it opens instantly and works offline), then swaps in the
   latest `events.json`. If the scheduled fetch ever fails, the old file stays in place and the "Updated" date stops moving.
4. **Previews.** The app matches each band against Deezer's free API in the background, soonest shows first. A band only gets a
   ▶ when the name matches exactly and there are playable clips. Cover and tribute acts and generic listings ("Open Mic") are skipped,
   because they nearly always match the wrong artist. Matches are remembered on the device for 14 days.

## Run it locally

```sh
python3 scripts/fetch_events.py --upcoming   # refresh events.json
python3 -m http.server 8000                  # then open http://localhost:8000
```

Or double-click `serve.command` on a Mac. Location only works over `https://` or `localhost`.

The version lives at the top of `app.js` (`VERSION`) and shows in the About popup. Bumping it also gives the offline
cache a new name, so every phone and car picks up the new files.

Two address-bar switches help with testing: `?tesla=1` shows the car-only voice hint in any browser, and
`?now=2026-10-24T19:00` pins the date and time.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The page shell |
| `app.js` | The app: listings, pages, previews, player (sections marked inside) |
| `data.js` | Venue coordinates, phone numbers and websites, plus the genre map |
| `styles.css` | All styles; phone layout in the `max-width: 700px` block at the end |
| `events.json` | Current listings, written by the fetch script |
| `scripts/fetch_events.py` | Pulls and cleans the calendar |
| `.github/workflows/update-events.yml` | Runs the fetch on a schedule |
| `sw.js`, `manifest.json`, `icon-*.png` | Offline support and install icons |
| `screenshots/` | Tesla and phone screenshots |
| `.prettierrc.json` | Code formatting settings ([Prettier](https://prettier.io)) |
| `LICENSE` | All rights reserved; what is and isn't covered |

## Credits

- **Show listings** come from the [Ventura Rocks](https://www.venturarocks.com) public calendar.
- **Artist photos and previews** come from [Deezer](https://www.deezer.com) through its public API.

## License

Copyright 2026 [Automatous](https://github.com/automatous-io). All rights reserved. The code is public to read as a portfolio piece, not to reuse; see [LICENSE](LICENSE). All show listings are from the public Ventura Rocks calendar; artist photos and previews are from Deezer.
