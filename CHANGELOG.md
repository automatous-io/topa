# Changelog

**[README](README.md)** · [Report an issue](../../issues/new)

Notable changes by version. Earlier releases are listed under [tags](../../tags).

---

## 2.5.0

**One logo everywhere, and a better fit on smaller phones.**

- The logo is the same on the splash, About, the phone top bar and the car sidebar: the ridge, TOPA, then LOCAL MUSIC /
  FINDER. The ridge line is the same weight everywhere.
- Bands shows its full title on smaller phones; Soonest moved under the filter, like on Venues.
- A day name too long for the phone shortens, so Wednesday becomes Wed.
- The venue link on a show page is easier to tap.
- Tests now check every screen on eight phone sizes, from a small iPhone SE to an iPhone Pro Max.

---

## 2.4.0

**A new About page.**

- About opens with a big TOPA header, then two buttons: Add to TOPA and Get the app. Where shows come from and the
  fine print sit below.
- Add to TOPA is its own page with a teal header: four tiles (show, weekly show, band, venue), what to do if you're
  already listed, and how it works in three steps.
- Close and back stay at the top while you scroll.
- The opening splash's "Local Music Finder" matches About: coral capitals.
- Same look on phones and in the car.

---

## 2.3.1

**Venue details come only from venue profiles.**

- Map spots, phone numbers and websites now come only from each venue's profile in `community/`. The old built-in venue
  list is gone.
- Eight more venues have a phone number from their own website or social pages.
- Venues that don't publish a phone number show a dimmed Call button until one is added.

---

## 2.3.0

**Band and venue profiles, and Instagram on venue pages.**

- 85 local bands have a profile with their Instagram, and Apple Music previews now play the right artist for bands with
  a common name.
- 96 venues have a profile with their address, map spot, website, phone and Instagram where known. Venue pages show an
  Instagram button under the venue's buttons.
- A venue TOPA hasn't seen before gets its map spot from its address automatically.
- The venue form asks for the venue's Instagram.

---

## 2.2.1

**Fixes.**

- No more empty strip under the tab bar when TOPA is opened from an iPhone home screen, and the tab bar is a bit
  shorter.
- Show pages: the time at the top is in capitals like everywhere else, and the distance lines up when there's no ▶.

---

## 2.2.0

**Band links on show pages, a Share button, and matching stars.**

- Show pages list the band's links (Instagram, Bandcamp, Spotify and the rest) as a row of icons, then the venue's buttons.
  Band pages use the same row.
- The venue's Maps button is now Share: the phone's share menu, or "Link copied" where there isn't one. No Share in the car.
- Where a show came from is a small line at the bottom of its page.
- Fave stars are one size everywhere and drawn the same on and off.
- New screenshots.

---

## 2.1.0

**An opening splash.**

- Sound bars settle into the Topa Topa ridge, then TOPA rises. About a second and a half, on phones and the Tesla.
- Plays once each time the app opens. A tap skips it. Skipped for reduced motion and for links straight to a page.
- `?splash=1` plays it every time, for testing.

---

## 2.0.0

**A new look on phones and the Tesla.**

- Dusk purple and sunset coral, with Oswald for names and times and Figtree for the rest. Both fonts ship with the app.
- Phones: a top bar with the TOPA logo (opens About), Ventura County, and a search box that slides out. Four tabs; About
  moved to the logo.
- Shows: the title is just the weekday, so Play all stays put. Days are tiles, filters are outlined, and each row has
  a round ▶.
- Starred shows move up to My Faves and aren't listed again below.
- The @ / calendar icon sits after the time, with a key under each list.
- Full-screen player: tap the mini player for big art, where and when the band plays, and directions.
- Venue and show pages: Directions, Call, Website and Maps buttons.
- The Tesla gets the same design at full and half screen.
- New app icons, About wording, and screenshots.
- Tested on a phone, the Tesla at full and half screen, and in headless Chrome (`npm test`).
