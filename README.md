# Pool Tracker

For the coach on deck: one phone or tablet watching the pool gives **split times, stroke rate and
stroke count for every lane**, from the camera alone. No install and no accounts: it's an installable
web app (PWA), and sessions stay on the device.

## Using it

1. **Camera up high at one end of the pool** (stand, balcony, tall tripod), both walls and every lane in view, kept still.
   A recorded video file works too.
2. **Line up the pool**: drag four dots onto the corners of the water (start wall ×2, turn wall ×2), set the pool
   length (m or yd), lanes in view and first lane number. Untick empty lanes, name swimmers, and optionally set the
   stroke or up to 4 swimmers per lane (circle swimming).
3. **Start tracking** before swimmers push off: it learns the empty water for 4 s. *Start race clock* times the first
   length from the start signal; otherwise it's estimated from the push-off.
4. **Finish** saves the session on the device; results export as CSV.

What each lane shows: current length and time, live stroke rate, and a table of lengths (split wall-to-wall,
running total, strokes, stroke rate) with pace per 100.

## How it works

- **Top-down grid** (`grid.js`): the four corners give a homography (`homography.js`), so every frame is sampled
  into cells of 0.25 m along each lane × 6 across, in metres rather than pixels. A per-cell background (median of
  the first 4 s, then a slow approximate median) with its normal flicker learns what water looks like; cells that
  differ in two frames running are "swimmer or splash" (one-frame sun sparkles are dropped).
- **Tracking** (`tracker.js`): per lane, strong stretches of foreground are swimmers; each is followed with an
  alpha-beta filter. Out-of-sight swimmers (underwater glide) coast at their last speed and bounce off walls; two
  swimmers passing in a lane both coast through the overlap so they don't swap.
- **Walls and lengths** (`laps.js`): a length ends when the swimmer reaches a wall and comes back (turn) or stays
  (finish, >3 s). The touch time is the first moment at the wall, corrected for approach speed; the same rule at
  every wall keeps split times consistent.
- **Strokes** (`strokes.js`): each hand entry throws up splash, so splash energy around the swimmer pulses once per
  arm stroke; autocorrelation gives the period. In free/back the splash also swaps sides every stroke, which tells
  alternating strokes (Free/Back) from simultaneous ones (Fly/Breast) and so turns pulses into **cycles per minute**.
  Stroke count = hand entries (free/back) or cycles (fly/breast) from breakout to touch.

Tested end to end on a synthetic pool video (perspective, ripples, glare, lane ropes, glides, turns, splashes):
splits within ~0.3 s, stroke rate within ~1 cycle/min, stroke count ±1–2, in 25 m and 50 m pools, 15–30 fps, and two
swimmers sharing a lane. Real footage adds things the simulator can't (people on deck, heavy waves, camera shake),
so check a session against a stopwatch before relying on it. Limits: freestyle vs backstroke (and fly vs breast)
can't be told apart automatically; set the stroke per lane for exact labels. Keep crowded lanes to 1–2 swimmers
for reliable identities.

## Practice Writer

`practice.html` (linked from the top bar) writes a swim group's practices from the season plan, a gear chart
and the coach's own blocks, and learns from what happens on deck.

- **Gears.** G1 recovery … G6 max speed, with half gears. A gear is the pace a swimmer could hold for a set
  time (by default G2 four hours, G3 one hour, G4 fifteen minutes, G5 five, G6 two), from a Riegel fatigue curve:
  `pace = T/d × 100 × (T_gear / T)^((F − 1)/F)`. Groups are defined by a 1650 time or a G3 pace per 100, plus
  an optional 400 IM time for IM paces. Rest grows with the gear and the rep (`swim × ratio × (swim/60)^k`).
  The built-in constants are generic placeholders (Riegel's F = 1.06, round rest ratios and CNS rates); every
  one is editable on the Season tab, and a coach's own chart is kept in their private data, not in this repo.
- **Set notation.** Blocks are written the way coaches write them (made-up examples): `36 min FL/free switch`,
  `6 x 50 FL, G2 → G5 by 25   :53 | :56 | :59 | 1:02`, `:15 REST`, `3 rounds:`, odds/evens, reference rows
  (`G3 pace 1:02 | 1:05 | …`) and group adjustments (`1:08 - 2 x 300 (start on #2)`). The app reads them,
  times them for every group, and fills in missing send-offs per group.
- **Style learning.** From the coach's own blocks the app learns how long send-offs are relative to each
  group's G3 pace for each kind of line, the usual rest line and rounds, and uses that to write new blocks and
  the cuts slower groups take to finish on time.
- **Planning the season together.** The first time the app opens (and from Season), it walks the coach
  through the season step by step: major meets and how much each matters (A taper, B short rest, C train
  through), the training week, their philosophy, key skills and the equipment the team has. It then drafts
  the phases back from the A meets (or Claude shapes them from the answers) and asks what each phase is for.
  A coach who already has a plan gets the same steps filled in from it; mid-season, the phases already swum
  stay as they are and only what is still to come is re-drafted. The gear chart, groups and formatting are
  kept. The coach chat reads the philosophy, skills, equipment and the current phase's description.
- **Season.** AM and PM sessions per weekday (doubles), phases with a focus per session, meets (no practice;
  the day before sharpens), weekday themes, a hard week's yards and each phase's gear-band and kick targets.
- **Week.** The lead coach's planning board: every session Monday to Sunday with its focus, gears, minutes and
  status (open, written, swum, debriefed), meets and pre-meet days; write, ask the coach, view, edit or debrief
  any session from it; the week's yards, gear bands and kick against the phase targets, where it is off, and
  CNS load day by day; and a first draft of every open session, saved only once the coach ticks them.
- **Google Doc.** In the claude.ai version, written sessions go into the week's Google Doc ("Week 3 B2", named
  after the phase and its week) in the coach's layout: day headings, "Block - N min" headings, send-offs
  tab-aligned in one column, reference rows and group notes in italics. The doc is found in Drive by its
  title or created in the practice folder; a doc can also be linked by URL. It uses the viewer's own Google
  Drive and Google Docs connectors, appends at the end of the doc guarded by the revision it read, and never
  repeats a write whose outcome is unknown. Add from the Week card, a Log entry, or "Save and add" in Build.
  "Fill in from the doc" on the Week card reads a doc the coach already wrote into: it finds the day
  headings and block headings, matches each block to the library by its lines or name, and lists what it
  found to review first — keep or replace practices the app already has, and add blocks it doesn't
  recognise to the library (with a guessed category, a name and an optional sub-category). A bold line
  taken for a new block by mistake can be joined back to the block above. Filled-in sessions are marked
  as in the doc.
- **Sub-categories.** A block can carry its own label within its category ("Socks", "Underwater"); the
  library groups each category by it, search finds it, and the coach chat sees it.
- **Idea blocks.** A block can be saved as an idea rather than a fixed set: its description is the
  mechanism, its lines one way to swim it, and a note for each phase of the season says what changes
  (e.g. "P2: last 25% without the snorkel"). Each time it goes into a practice it is written fresh: reps,
  distances and rounds split differently for about the same yards, unlike the last time it was swum,
  with send-offs for each group, and the phase's note printed with it. "Another version" in Build
  writes it again; the coach chat is told to vary it the same way.
- **Today.** The day's sessions with a few questions (time, how the group is, equipment, focus) → a suggested
  practice with group send-off columns, notes from past debriefs and the CNS load.
- **Coach.** In the claude.ai version of the page, a chat where the coach can text requests ("write today's
  PM, 20 minutes, legs are tired") and get practices back in their notation, built from the library, gear
  chart, recent practices and debriefs. Offline, pasting a set saves it as a block.
- **Build.** Order blocks, blend some into a circuit, choose how rounds differ (even, descending,
  ascending, build a gear each round, hard last round), save to the log. Each block has a description for
  that practice (cues, focus), filled from the library block's and saved with the practice; "Save to the
  block" makes it the library block's own.
- **Blocks.** The library: search names, descriptions and lines; list the blocks with no description yet and
  write one in place; edit a block line by line or save a variant as a copy. Descriptions print under the
  block in the practice, its text, the debrief and the Google Doc (in italics), and the coach chat sees them.
- **Debrief.** Per section: good / mixed / bad and why, what changed, intervals (too easy / right / too hard),
  made the send-offs, goal times, drills working. Debriefs move send-offs per gear and stroke, raise or lower
  blocks in suggestions, and bring notes back the next time a block comes up.

Data lives on the device (localStorage) or, in the claude.ai Artifact version, in the artifact's private
database (readable and writable by its owner and the people they make Editors, e.g. the lead coach). `node scripts/build-artifact.mjs` builds that version.

## Running it

The camera needs HTTPS (or `localhost`).

```sh
npm start          # serves on http://localhost:8080
npm test           # unit + end-to-end tests on synthetic pool video (Node 20+, no dependencies)
```

To use it at the pool, publish the folder to any static HTTPS host. The included workflow publishes to
**GitHub Pages** on every push to `main`: enable it once under *Settings → Pages → Source: GitHub
Actions*, then open the URL on the phone or tablet and "Add to Home Screen".

## Layout

```
index.html, pool.css, sw.js, manifest.webmanifest, icon.svg
practice.html, practice*.css  Practice Writer page
src/homography.js  corners → pool coordinates (pure, tested)
src/grid.js        camera frame → top-down lane grid; water background model (pure, tested)
src/tracker.js     swimmers per lane, frame to frame (pure, tested)
src/laps.js        turns, finishes, lengths (pure, tested)
src/strokes.js     stroke rate, family and count from splash (pure, tested)
src/session.js     whole pipeline, results, CSV (pure, tested)
src/capture.js     camera / video file frames
src/store.js       saved setup and sessions (localStorage)
src/app.js         UI
src/practice.js    blocks, season plan, sessions, meets, suggestions, circuits (pure, tested)
src/gears.js       gear paces, rest, send-offs, CNS load (pure, tested)
src/setlang.js     set notation: parse, time, write, learn style, generate (pure, tested)
src/learn.js       debriefs and what they teach (pure, tested)
src/coach.js       prompts and replies for the coach chat (pure, tested)
src/week.js        the week: session status, totals vs phase targets, drafts (pure, tested)
src/gdoc.js        a session → Google Doc paragraphs and the batchUpdate that appends them (pure, tested)
src/docscan.js     a week's Google Doc → the sessions and blocks written in it (pure, tested)
src/ideas.js       idea blocks: a fresh version for each practice, the note for the phase (pure, tested)
src/practice-store.js  storage: artifact database or localStorage
src/pw/            Practice Writer UI (app shell, views/, shared rendering)
scripts/build-artifact.mjs  builds the claude.ai Artifact version
tests/             node:test suites; support/pool-sim.mjs renders synthetic pool video
```
