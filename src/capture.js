// Video in for Jump Height: the phone camera (ideally 60 fps) or a recorded
// file, delivered as the <video> element itself plus a per-frame timestamp in
// seconds. Jump height comes from flight time, so frame timing is the product.

// Frame callbacks fire at most once per screen refresh, so a file must be played
// slowly enough that each of its frames gets its own refresh. Its frame rate is
// not known up front, so the first frames are played very slowly while the
// spacing of their timestamps is measured; playback then runs as fast as that
// frame rate allows on a 60 Hz screen, with a little margin.
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
    if (facing === 'environment') {
      // Camera names are only readable once permission is given, so the wide lens is
      // looked for now and, if wanted, swapped in.
      let track = stream.getVideoTracks()[0];
      const ultra = findWideCamera(await navigator.mediaDevices.enumerateDevices().catch(() => []));
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
        // Phones that present their rear lenses as one camera: zoom out as far as it goes.
        try { await track.applyConstraints({ advanced: [{ zoom: zoom.min }] }); this.lens = 'wide'; } catch { /* keep 1x */ }
      }
      orphaned(stream);
    }
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
