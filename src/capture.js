// Video in for Jump Height: the phone camera (ideally 60 fps) or a recorded
// file, delivered as the <video> element itself plus a per-frame timestamp in
// seconds. Jump height comes from flight time, so frame timing is the product.

// Video files are assumed to hold at most 120 frames per second.
const FILE_RATE = 0.5;

export function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export class VideoSource {
  constructor(video) {
    this.gen = 0;
    this.busy = false;
    this.onVisibility = null;
    this.video = video;
    this.stream = null;
    this.url = null;
    this.live = false;
    this.fps = null; // negotiated camera frame rate; null for files
    this.running = false;
    this.onFrame = null;
    this.handle = null;
    this.lastT = -Infinity;
  }

  // facing: 'environment' (rear) | 'user' (front). Both are "ideal", so a
  // device without that camera still opens whatever it has.
  async openCamera({ facing = 'environment' } = {}) {
    this.close();
    const gen = this.gen;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    });
    // close() or another open happened while the permission prompt was up:
    // this stream has no owner, so stop it or the camera light stays on.
    if (gen !== this.gen) {
      stream.getTracks().forEach((t) => t.stop());
      throw Object.assign(new Error('Camera request was superseded'), { name: 'SupersededError' });
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
    // Frame callbacks fire at most once per screen refresh, so a file is played
    // slowly enough that each of its frames gets its own refresh (up to 120 fps
    // on a 60 Hz screen). Timing comes from mediaTime, so speed doesn't affect it.
    this.video.playbackRate = FILE_RATE;
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

// Keep the screen on while tracking (where supported).
export async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return () => lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
