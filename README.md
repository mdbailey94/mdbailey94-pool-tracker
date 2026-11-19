# Jump Height

Estimate your vertical jump with a phone camera. The app watches you jump, measures how long your feet are
off the ground, and turns that into a height. It runs in the browser, works offline once loaded, and keeps
sessions on your device only. There are no accounts and no uploads.

## Using it

1. Choose how many athletes (1 to 3), then tap **Start camera**, or **Use a video** to analyse a recording.
2. Put the phone on the ground, leaning back about 45°, so it looks up at the athletes from 2 to 3 m away.
   Prop it so it cannot move. With two or three athletes, turn it sideways.
3. Each athlete stands in their own section of the screen, on the marker. The marker and the label above it
   say what to fix (step back, come closer, move to the middle) and turn green when the athlete is placed well
   and standing still.
4. Jump, and land on the same spot with your legs as straight as they were at takeoff.
5. Each athlete's height appears in large type over their own section. Switch between cm and inches at any
   time. Delete a jump if it was misread.
6. Tap **Done** to save the session. Past sessions can be reviewed and exported as CSV, with a column for the
   athlete.

On phones with a motion sensor, a gauge shows how far the phone is leaning back and whether it is level.
About 45° is a starting point: the right angle depends on the lens and the distance, so the stand-here
prompts have the last word. If they say the feet are cut off, lean the phone forward a little or move it back.

### Using a video

A recorded video is more accurate than the live camera, because every frame is measured. There is nothing
to set: the app works out the video's frame rate and, for slow motion, how much it was slowed.

What works best:

- 120 frames per second. On an iPhone that is Slo-mo at 1080p, 120 fps. Ordinary 60 fps video is next best.
- The phone propped up or held very still, level with the hips, 2 to 4 m away.
- Hips, legs and feet in view for the whole jump, with room above the hips.
- About a second of standing still before the jump or after the landing. One of the two is enough.
- Take off and land on the same spot.

## How the measurement works

A pose model (MediaPipe Pose Landmarker, running on the phone) finds your body in each frame. Only the hips,
legs and feet are used. From the side, the far leg is hidden behind the near one for much of the jump; the
app then relies on the leg it can see. A detector watches your feet and hips to find the frame where you
leave the ground and the frame where you land.
The time between them is the flight time, T. A jump follows a simple arc, so the height is

    height = g * T^2 / 8

with g = 9.81 m/s^2. For example, 0.5 s in the air is about 31 cm.

A video is measured as a whole once it has been read, which gives it two advantages over the live camera.
Slow motion is recognised from gravity: in a clip slowed 4 times, the body falls 16 times too slowly for
its size, and only the true play rate gives a person-sized body. And because a jump looks the same played
backwards, the clip is also read in reverse, so standing still after the landing serves as well as standing
still before the jump.

Takeoff and landing usually fall between two frames. The detector estimates where between them, so the timing
is finer than the frame rate. More frames per second still helps.

Flight time gives the height exactly only if you take off and land in the same posture. The formula assumes
your body is in the same position at both moments. Two common departures are measured and allowed for:

- **Bent-knee landing.** Your feet touch down later than they would with straight legs, so the fall takes
  longer than the rise and flight time alone reads high. The app measures how much lower your hips are at
  landing than at takeoff and takes about a third of that off the height.
- **Knees tucked in the air.** The feet stop following a simple arc and the timing reads about a centimetre
  low, so a little is added back.

Each jump is shown with a **95% range**: the span the true height is expected to fall in 95 times out of
100. It is wider with fewer frames in the air, after a posture adjustment, and when you land somewhere other
than where you took off. When an adjustment was made, the screen also shows what flight time alone gives.
Each jump still gets a confidence rating, and the screen explains why when it is not high.

A jump that lands well away from the takeoff spot is not reported at all: the ground sits at a different
place in the picture and the timing cannot be trusted.

## Accuracy

Accuracy on real people has not been validated yet. Treat the numbers as an estimate. Before relying on
them, compare against a known measure, such as a jump mat or a wall reach test, and see how far apart they are.

What has been checked:

- The posture adjustments and the 95% range were tuned and tested on simulated jumps only (20 to 70 cm,
  30 to 120 frames per second, knee tucks up to 15 cm, bent landings up to 15 cm). There the true height
  fell inside the range in 98 to 99 jumps out of 100, and a 10 cm bent landing read 0.4 cm off where flight
  time alone read 4.4 cm high. How real bodies move may differ, so treat the range as a guide until it has
  been compared with measured jumps.
- Simulated jumps (15 to 80 cm, with landmark jitter, uneven frame timing and dropped frames): the average
  error is about 0.6 cm at 60 frames per second and 0.9 cm at 30, with worst cases of about 2 cm and 4 cm.
  Short jumps at low frame rates are the least precise.
- Test clips with a known flight time, run through the whole app with the real pose model: readings were
  between 0.1 cm low and 2.1 cm high. The clips are a photo of a person moved along a gravity arc, so they
  test timing but not real body movement.
- Below about 12 frames per second the app cannot time a jump live. Use a recorded video instead: a file
  is held on each frame while it is measured, however slow the device. The app works out a file's frame
  rate from its first frames, shows it, and sets the playback speed so that no frame is skipped (up to
  240 frames per second on a 60 Hz screen).
- One real side-on clip (60 frames per second): the app's takeoff and landing agree with the frames, read
  by eye, to within about one frame at each end.

Results are better with steady lighting, a still phone, a plain background, tight clothing and a high frame
rate. The app shows the frames per second it is processing and warns if that falls below about 20.

## Running locally

    npm start

Then open http://localhost:8080. The camera needs HTTPS or `localhost`, so to try it on a phone, use a
deployed copy (see below) or an HTTPS tunnel. There is nothing to build and no dependencies to install.

## Tests

    npm test

Runs the Node tests in `tests/`. They cover the jump detector, which has no browser dependencies.

## Deployment

Pushes to `main` publish the app to GitHub Pages through `.github/workflows/ci.yml`, after the tests pass.
Enable it once under Settings, Pages, Source: "GitHub Actions". All URLs are relative, so it works under a
sub-path. The model files in `vendor/mediapipe/` are about 15 MB. The service worker caches them on first use,
so later visits, and offline use, do not download them again.

## File layout

- `index.html`, `app.css`: page and styles.
- `src/app.js`: the screens (home, live camera, session detail).
- `src/capture.js`: camera and video file input, frame by frame.
- `src/lanes.js` (pure, tested): which athlete a tracked body belongs to, where to stand, and how the phone is tilted.
- `src/pose.js`: loads the pose model and finds body landmarks.
- `src/jump.js`: the detector that finds jumps and computes heights. Pure, so it is easy to test.
- `src/store.js`: sessions and settings in local storage, CSV export.
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline support and install.
- `vendor/mediapipe/`: the pose model and its runtime, served from the same site.
- `tests/`: Node tests.
