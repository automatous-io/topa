# Changelog

**[README](README.md)** · [Report an issue](../../issues/new)

Notable changes by version. Earlier releases are listed under [tags](../../tags).

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
