# Pool Tracker

For the coach on deck: one phone or tablet watching the pool times swimmers from the camera alone —
**single-lap finish times** that go straight into a Google Sheet, or **split times, stroke rate and stroke count
for every length**. No install and no accounts: it's an installable
web app (PWA), and sessions stay on the device.

It has two modes, picked on the home screen:

- **One lap to a finish** (single-lap timer): press Start on the signal, and each lane stops by itself when the
  swimmer touches the wall or crosses a line. Times are saved on the device and added to a **Google Sheet**.
- **Every length of a session**: splits, stroke rate and stroke count for every length (below).

## Single-lap timer

1. **Camera**: either behind the finish wall looking up the pool (swimmers coming towards you), or side on, level
   with the finish (swimmers crossing the picture; the higher the better). Keep it still. A recorded video works too.
2. **Mark the finish**: choose the view and the finish (*touch on the wall* or *crossing a line*), then drag four
   dots: 1–2 on the finish, 3–4 on a parallel line a few metres back (the backstroke flags are handy, 5 m), and enter
   that distance. Set the lanes in view, untick empty ones, and name swimmers. Distance, stroke and event name go
   with the times.
3. **Ready** a couple of seconds before the start (it learns the empty water), then **Start** (or the space bar)
   on the signal. Finishes in the first few seconds are ignored (adjustable).
4. Each lane shows its time as the swimmer finishes. When every lane is in, the heat is saved and sent to the sheet.
   If the camera misses one, **Tap finish** records it by hand; **Clear** throws away a wrong one (the sheet is
   corrected too). **Next heat** goes again with the same setup.

### Google Sheet

Set up once on the home screen (*Google Sheet → Set it up*): make a sheet, paste the script the app shows into
*Extensions → Apps Script*, deploy it as a web app (execute as *Me*, access *Anyone*), and paste the web-app URL into
the app. Each finished swimmer becomes a row: date, time of day, event, heat, lane, swimmer, distance, stroke, time,
seconds, timing (camera / manual) and an ID. No Google sign-in or API keys are involved; anyone with the URL could
add rows, so keep it private. Times taken without signal wait on the device and go when it's back; rows are matched
on their ID, so resending never duplicates, and corrections replace the row. *Send all to the sheet* uploads every
past heat (e.g. after connecting a sheet later).

### How the finish is detected (`finish.js`)

The band between the dots is sampled into a top-down grid (0.1 m along, 12 strips per lane) with the same
homography and water-background model as the lap tracker. In each lane the nearest swimmer-sized patch of
"not water" gives the swimmer's **leading edge**, in metres from the line.

- **Touch**: the hand stops dead on the wall, so the touch is called when the edge has come in close and stopped,
  and timed where the approach meets that resting place. The visible edge is always a little behind the fingertips
  (a thin hand barely shows), but it's behind by the same amount moving or stopped, so that cancels out.
- **Line**: the time the edge reaches the line, from a straight-line fit of the approach.
- A finish only counts after the swimmer is seen closing in by at least a metre, so a swimmer resting at the wall,
  a kickboard or splash from the next lane doesn't trigger it.

On synthetic video (perspective, ripples, glare, lane ropes, stroke splash; also through the real browser on
VP9-encoded files): **touches within ~0.05 s** in both views at 25–30 fps. Line finishes trigger on the first
clearly visible part of the swimmer: within ~0.1 s in near lanes, up to ~0.25 s late in a far lane seen side on at
low resolution (there the head leads, as arms are under a pixel wide). Live camera times use the frame's capture
time where the browser provides it; check a few heats against a stopwatch before relying on it.

## Every length of a session

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
src/finish.js      single-lap finish detection, heat records, CSV (pure, tested)
src/sheets.js      Google Sheet sync queue and the Apps Script (tested against a fake Sheets service)
src/capture.js     camera / video file frames
src/store.js       saved setup and sessions (localStorage)
src/app.js         UI (home, session tracking)
src/race-ui.js     single-lap timer UI
tests/             node:test suites; support/pool-sim.mjs and race-sim.mjs render synthetic pool video
```
