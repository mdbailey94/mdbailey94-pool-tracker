// Video in: the rear camera or a recorded file, delivered frame by frame as
// small RGBA images with a timestamp in seconds.

const PROCESS_WIDTH = 480; // px; enough detail for 8–10 lanes, cheap to scan

export function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export class VideoSource {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.url = null;
    this.live = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.onFrame = null;
    this.handle = null;
    this.lastTime = -1;
  }

  async openCamera() {
    this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    this.live = true;
    Object.assign(this.video, { muted: true, playsInline: true, loop: false, srcObject: this.stream });
    await this.video.play();
    await this.ready();
  }

  async openFile(file) {
    this.close();
    this.url = URL.createObjectURL(file);
    this.live = false;
    Object.assign(this.video, { muted: true, playsInline: true, loop: false, srcObject: null, src: this.url });
    await this.ready();
    // Show the first frame for setting up the corners.
    this.video.currentTime = Math.min(0.1, this.video.duration || 0);
  }

  ready() {
    const v = this.video;
    if (v.videoWidth) return this.sizeCanvas();
    return new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', () => resolve(this.sizeCanvas()), { once: true });
      v.addEventListener('error', () => reject(new Error('That video could not be opened. Try an MP4 or MOV file.')), { once: true });
    });
  }

  sizeCanvas() {
    const { videoWidth: w, videoHeight: h } = this.video;
    this.canvas.width = Math.min(PROCESS_WIDTH, w);
    this.canvas.height = Math.round((this.canvas.width * h) / w);
    return { width: this.canvas.width, height: this.canvas.height, aspect: w / h };
  }

  get size() {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  // Call onFrame(rgba, t) for every new video frame until stop().
  start(onFrame) {
    this.onFrame = onFrame;
    this.running = true;
    this.lastTime = -1;
    if (!this.live) this.video.play().catch(() => {});
    this.schedule();
  }

  schedule() {
    if (!this.running) return;
    const v = this.video;
    if (v.requestVideoFrameCallback) {
      // Camera frames carry the moment they were captured, which beats the
      // moment they reached the screen for timing.
      this.handle = v.requestVideoFrameCallback((now, meta) => this.grab(this.live ? (meta.captureTime ?? now) / 1000 : meta.mediaTime));
    } else {
      this.handle = requestAnimationFrame((now) => this.grab(this.live ? now / 1000 : v.currentTime));
    }
  }

  grab(t) {
    if (!this.running) return;
    const v = this.video;
    if (t !== this.lastTime && v.readyState >= 2) {
      this.lastTime = t;
      const { width, height } = this.canvas;
      this.ctx.drawImage(v, 0, 0, width, height);
      this.onFrame?.(this.ctx.getImageData(0, 0, width, height).data, t);
    }
    this.schedule();
  }

  stop() {
    this.running = false;
    if (!this.live) this.video.pause();
  }

  get ended() {
    return !this.live && this.video.ended;
  }

  close() {
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
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
