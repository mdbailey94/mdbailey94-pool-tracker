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
src/homography.js  corners → pool coordinates (pure, tested)
src/grid.js        camera frame → top-down lane grid; water background model (pure, tested)
src/tracker.js     swimmers per lane, frame to frame (pure, tested)
src/laps.js        turns, finishes, lengths (pure, tested)
src/strokes.js     stroke rate, family and count from splash (pure, tested)
src/session.js     whole pipeline, results, CSV (pure, tested)
src/capture.js     camera / video file frames
src/store.js       saved setup and sessions (localStorage)
src/app.js         UI
tests/             node:test suites; support/pool-sim.mjs renders synthetic pool video
```
