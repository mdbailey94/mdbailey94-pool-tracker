# Jump Height

Estimate your vertical jump with a phone camera. The app watches you jump, measures how long your feet are
off the ground, and turns that into a height. It runs in the browser, works offline once loaded, and keeps
sessions on your device only. There are no accounts and no uploads.

## Using it

1. Choose how many athletes (1 to 3) and which camera. The front camera is the default, so athletes can
   read their result; the app remembers the choice. Tap **Start camera**, or **Use a video** to analyse a
   recording.
2. Stand the phone on the ground on its side, 2 to 3 m away, tilted so the camera looks up about 15°
   (upright, about 45°). Prop it so it cannot move. The app uses the widest view the camera has (0.5×
   where there is one).
3. The picture fills the screen. Each athlete stands in their own section, on the marker. The label above it
   says what to fix (step back, come closer, move to the middle) and turns green when the athlete is placed
   well and standing still. If the phone's angle is off, a line at the bottom of the screen says which way
   to tilt it.
4. Jump, and land on the same spot with your legs as straight as they were at takeoff.
5. The height appears in large type over your section and stays up for 2 seconds; then the next jump is
   looked for. A jump made while a result is showing is not counted.
6. Tap anywhere on the screen to open the side panel: the latest jump's details, the session's jumps (each
   can be deleted), cm or inches, the camera and lens, the tilt gauge, and **Done**, which saves the session.
   Past sessions can be reviewed and exported as CSV, with a column for the athlete.

On phones with a motion sensor, the gauge in the panel shows how far the camera points up and whether the
phone is level. About 15° on its side (45° upright) is a starting point: the right angle depends on the lens
and the distance, so the stand-here prompts have the last word. If they say the feet are cut off, tilt the
camera down a little or move the phone back. On Android the app goes full screen; on an iPhone, add it to the
home screen for that.

### Using a video

A recorded video is more accurate than the live camera, because every frame is measured. There is nothing
to set: the app works out the video's frame rate and, for slow motion, how much it was slowed.

What works best:

- 120 frames per second. On an iPhone that is Slo-mo at 1080p, 120 fps. Ordinary 60 fps video is next best.
- The phone on the ground on its side, leaning back about 15°, filming at 0.5×, 2 to 3 m away. Propped still.
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

**Head rise** is shown as a second, independent measure when the head is in view: how far the head went above
its standing-tall level. It comes from the arc the head follows in flight (the arc's curvature gives the
picture's scale, so no body size is assumed) and ignores the feet and the landing altogether. It counts the
rise onto the toes before takeoff, so it normally reads a little higher than flight time. The two fail in
different ways, which is what makes comparing them useful: flight time is thrown by landing posture, head rise
by moving towards or away from the camera, and head rise needs you to stand tall and still before the jump.
It is also coarser, especially below 60 frames per second. The screen says when the two disagree.

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
- Head rise, on simulated jumps: within about 1 cm on average at 120 frames per second and 1.5 cm at 60,
  unaffected by a bent landing; about 2.5 cm high at 30. It reads 2 to 4 cm high if you land 10 cm nearer
  the camera. On one real side-on clip it read 54.7 cm where flight time read 53.5.
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
