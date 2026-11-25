// Video in for Jump Height: the phone camera (ideally 60 fps) or a recorded
// file, delivered as the <video> element itself plus a per-frame timestamp in
// seconds. Jump height comes from flight time, so frame timing is the product.

// A file is measured by stepping through it: its frame rate is found by playing the
// first frames slowly and measuring the spacing of their timestamps, then the video
// is paused and moved to each frame in turn. Every frame is measured, in order, the
// same way every time. (Playing it through instead skipped frames unpredictably, so the
// same clip read differently from one run to the next.) Browsers without per-frame
// callbacks fall back to slow playback.
const PROBE_RATE = 0.2; // slow enough for anything up to 240 fps
const PROBE_FRAMES = 8;
const SAFE_FPS = 48; // frames presented per second of wall time, under 60 Hz
const fileRate = (fps) => Math.min(1, Math.max(0.1, SAFE_FPS / fps));

export function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export class VideoSource {
  constructor(video) {
    this.gen = 0;
    this.busy = false;
    this.gaps = [];
    this.onVisibility = null;
    this.video = video;
    this.stream = null;
    this.url = null;
    this.live = false;
    this.fps = null; // negotiated camera frame rate; null for files
    this.lens = 'standard'; // 'wide' when the rear 0.5x camera is in use
    this.hasWide = false; // whether this phone offers one
    this.running = false;
    this.onFrame = null;
    this.handle = null;
    this.lastT = -Infinity;
  }

  // facing: 'environment' (rear) | 'user' (front). Both are "ideal", so a
  // device without that camera still opens whatever it has.
  // wide: use the rear 0.5x wide camera when the phone has one. With the phone on the
  // ground it takes in the floor and the top of the jump at a much shallower tilt.
  async openCamera({ facing = 'environment', wide = true } = {}) {
    this.close();
    const gen = this.gen;
    const orphaned = (s) => {
      // close() or another open happened while this was waiting: the stream has no
      // owner, so stop it or the camera light stays on.
      if (gen === this.gen) return false;
      s.getTracks().forEach((t) => t.stop());
      throw Object.assign(new Error('Camera request was superseded'), { name: 'SupersededError' });
    };
    const want = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, ...want } });
    orphaned(stream);
    this.lens = 'standard';
    this.hasWide = false;
    // Camera names are only readable once permission is given, so the wide lens is
    // looked for now and, if wanted, swapped in. The back camera's 0.5x lens is a camera
    // of its own on iPhones; elsewhere, and for the front camera, zooming out is the way.
    let track = stream.getVideoTracks()[0];
    const ultra = facing === 'environment'
      ? findWideCamera(await navigator.mediaDevices.enumerateDevices().catch(() => [])) : undefined;
    const zoom = track.getCapabilities?.().zoom;
    const canZoomOut = Boolean(zoom && zoom.min < 1);
    this.hasWide = Boolean(ultra) || canZoomOut;
    if (wide && ultra && ultra.deviceId !== track.getSettings().deviceId) {
      let s2 = null;
      try {
        s2 = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: ultra.deviceId }, ...want } });
      } catch { /* keep the standard lens */ }
      if (s2) {
        stream.getTracks().forEach((t) => t.stop());
        stream = s2;
        track = stream.getVideoTracks()[0];
        this.lens = 'wide';
      }
    } else if (wide && ultra) {
      this.lens = 'wide';
    } else if (wide && canZoomOut) {
      try { await track.applyConstraints({ advanced: [{ zoom: zoom.min }] }); this.lens = 'wide'; } catch { /* keep 1x */ }
    }
    orphaned(stream);
    this.stream = stream;
    this.video.playbackRate = 1;
    this.live = true;
    this.fps = this.stream.getVideoTracks()[0]?.getSettings().frameRate ?? null;
    Object.assign(this.video, { muted: true, playsInline: true, loop: false, srcObject: this.stream });
    await this.video.play();
    return this.ready();
  }

  async openFile(file) {
    this.close();
    this.url = URL.createObjectURL(file);
    this.live = false;
    this.fps = null;
    Object.assign(this.video, { muted: true, playsInline: true, loop: false, srcObject: null, src: this.url });
    // Timing comes from mediaTime, so playback speed doesn't affect the result.
    this.video.playbackRate = PROBE_RATE;
    this.gaps = [];
    const info = await this.ready();
    // Show the first frame so the user can check the framing.
    this.video.currentTime = Math.min(0.1, this.video.duration || 0);
    return info;
  }

  ready() {
    const v = this.video;
    const info = () => ({ width: v.videoWidth, height: v.videoHeight, aspect: v.videoWidth / v.videoHeight });
    if (v.videoWidth) return Promise.resolve(info());
    return new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', () => resolve(info()), { once: true });
      v.addEventListener('error', () => reject(new Error('That video could not be opened. Try an MP4 or MOV file.')), { once: true });
    });
  }

  // Call onFrame(video, t) once per new video frame until stop(); t is seconds.
  // The next frame is requested only after onFrame returns, so slow pose
  // inference on a live camera makes us skip frames instead of queueing them.
  start(onFrame) {
    this.onFrame = onFrame;
    this.running = true;
    this.lastT = -Infinity;
    if (!this.live && this.video.requestVideoFrameCallback) {
      this.stepFile();
      return;
    }
    if (!this.live) {
      // openFile parks the video just past the start to show a frame; measure from the top.
      if (this.video.currentTime < 0.5) this.video.currentTime = 0;
      this.video.play().catch(() => {});
      // A hidden tab stops frame callbacks but not playback, which would skip
      // frames unseen: hold the file while hidden.
      this.onVisibility = () => {
        if (document.hidden) this.video.pause();
        else if (this.running && !this.busy && !this.video.ended) this.video.play().catch(() => {});
      };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.schedule();
  }

  schedule() {
    if (!this.running) return;
    const v = this.video;
    // Clocks: live frames use meta.captureTime (when the camera captured the
    // frame, performance.now() clock), which excludes decode/render latency;
    // if absent, expectedDisplayTime, then the callback's `now`. Files use
    // meta.mediaTime, the frame's position in the video, so playback jitter
    // doesn't matter. The non-rVFC fallback is rAF time / currentTime.
    if (v.requestVideoFrameCallback) {
      this.handle = v.requestVideoFrameCallback((now, meta) =>
        this.grab(this.live ? (meta.captureTime ?? meta.expectedDisplayTime ?? now) / 1000 : meta.mediaTime));
    } else {
      this.handle = requestAnimationFrame((now) => this.grab(this.live ? now / 1000 : v.currentTime));
    }
  }

  async grab(t) {
    if (!this.running) return;
    // Never emit a non-increasing t (repeated frame, seek back, clock quirk).
    if (t > this.lastT && this.video.readyState >= 2) {
      if (!this.live && this.fps == null && Number.isFinite(this.lastT)) this.probe(t - this.lastT);
      this.lastT = t;
      // A file is held on this frame while it is processed, so slow pose
      // inference costs time instead of frames: every frame of the clip is
      // measured. A live camera can't wait, so there frames are skipped.
      if (!this.live) this.video.pause();
      this.busy = true;
      try {
        await this.onFrame?.(this.video, t);
      } catch (e) {
        console.error(e);
      }
      this.busy = false;
      if (!this.live && this.running && !this.video.ended && !document.hidden) this.video.play().catch(() => {});
    }
    this.schedule();
  }

  // Works out a file's frame rate from the spacing of its first frames (the
  // median, so a variable-rate recording's odd gap doesn't matter), then sets
  // the playback speed to suit. source.fps stays null until this is known.
  // Plays the first frames slowly and sets this.fps from the spacing of their
  // timestamps (the median, so a variable-rate recording's odd gap doesn't matter).
  probeRate() {
    const v = this.video;
    return new Promise((resolve) => {
      const gaps = [];
      let last = null, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        v.pause();
        if (gaps.length) this.fps = Math.round(1 / [...gaps].sort((a, b) => a - b)[gaps.length >> 1]);
        resolve();
      };
      const tick = (now, meta) => {
        if (done) return;
        if (last != null && meta.mediaTime > last) gaps.push(meta.mediaTime - last);
        last = meta.mediaTime;
        if (gaps.length >= PROBE_FRAMES || !this.running) finish();
        else v.requestVideoFrameCallback(tick);
      };
      v.playbackRate = PROBE_RATE;
      v.currentTime = 0;
      v.requestVideoFrameCallback(tick);
      v.play().catch(finish);
      setTimeout(finish, 5000); // a clip too short to measure: fall back below
    });
  }

  // Moves a paused video to a time and waits until that frame is ready.
  seek(time) {
    const v = this.video;
    if (Math.abs(v.currentTime - time) < 1e-6 && v.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, 3000);
      function done() { clearTimeout(timer); v.removeEventListener('seeked', done); resolve(); }
      v.addEventListener('seeked', done);
      v.currentTime = time;
    });
  }

  async stepFile() {
    const v = this.video;
    if (this.fps == null) await this.probeRate();
    if (!this.running) return;
    const fps = this.fps || 30;
    v.pause();
    const n = Math.max(1, Math.floor((v.duration || 0) * fps + 1e-6));
    for (let i = 0; i < n; i++) {
      // The middle of each frame's display time, so rounding never lands on its neighbour.
      await this.seek(Math.min((i + 0.5) / fps, Math.max(0, v.duration - 1e-3)));
      if (!this.running) return;
      try {
        await this.onFrame?.(v, i / fps);
      } catch (e) {
        console.error(e);
      }
      if (!this.running) return;
    }
    this.running = false;
    v.dispatchEvent(new Event('ended')); // the same signal as a video played to its end
  }

  probe(gap) {
    this.gaps.push(gap);
    if (this.gaps.length < PROBE_FRAMES) return;
    const mid = [...this.gaps].sort((a, b) => a - b)[this.gaps.length >> 1];
    this.fps = Math.round(1 / mid);
    this.video.playbackRate = fileRate(this.fps);
  }

  stop() {
    this.running = false;
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.onVisibility = null;
    if (this.handle != null) {
      if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
      this.handle = null;
    }
    if (!this.live) this.video.pause();
  }

  get ended() {
    return !this.live && this.video.ended;
  }

  close() {
    this.gen++; // orphans any camera request still waiting on the user
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.fps = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.video.removeAttribute('src');
    this.video.srcObject = null;
  }
}

// The rear 0.5x camera, from the browser's device list, or undefined. iPhones call it
// "Back Ultra Wide Camera"; the combined "Dual Wide" and "Triple" cameras are not it.
export function findWideCamera(devices) {
  return (devices || []).find((d) => d.kind === 'videoinput' && d.deviceId
    && /ultra[\s-]*wide/i.test(d.label || '') && !/front|user|selfie/i.test(d.label || ''));
}

// Keep the screen on while tracking (where supported).
export async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return () => lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
