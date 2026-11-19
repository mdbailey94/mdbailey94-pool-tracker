// Jump Height UI: pick a video source, watch for jumps, keep a list, review sessions.

import { VideoSource, cameraSupported, keepAwake } from './capture.js';
import { JumpDetector } from './jump.js';
import {
  deleteSession, download, loadSessions, loadUnit, newSessionId, saveSession, saveUnit, sessionCSV,
} from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const homeEl = $('#home');
const liveEl = $('#live');
const panel = $('#panel');
const stage = $('#stage');
const video = $('#video');
const overlay = $('#overlay');
const loadingEl = $('#loading');
const ctx = overlay.getContext('2d');

const STATUS_TEXT = {
  'no-person': 'Step into view. Hips, legs and feet.',
  settling: 'Stand still…',
  ready: 'Ready. Jump!',
  airborne: 'In the air…',
};
const FEET = new Set([27, 28, 29, 30, 31, 32]);
const SPEEDS = [1, 2, 4]; // 120 fps footage saved at 60 or 30 fps
const LOW_FPS = 20;
const TOO_SLOW_FPS = 12; // below this the detector cannot learn the ground level or time a flight

const state = {
  mode: 'home',
  source: new VideoSource(video),
  unit: loadUnit(),
  detail: null,
  // live session
  fileMode: false,
  file: null,
  speed: 1,
  facing: 'environment',
  pose: null,
  detector: null,
  poseModule: null,
  running: false,
  id: null,
  startedAt: null,
  jumps: [], // { at, heightM, flightTime, confidence, notes }
  status: null,
  landmarks: null,
  fps: null,
  lastFrameAt: 0,
  lastFpsUi: 0,
  frames: 0,
  release: null,
  finished: false,
  audio: null,
};

// ----------------------------------------------------------------- helpers

const heightText = (m, unit = state.unit) => (unit === 'in' ? (m * 39.3701).toFixed(1) : (m * 100).toFixed(1));
const unitText = (unit = state.unit) => (unit === 'in' ? 'in' : 'cm');
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const best = (jumps) => jumps.reduce((b, j) => (!b || j.heightM > b.heightM ? j : b), null);

function setUnit(unit) {
  state.unit = unit;
  saveUnit(unit);
  if (state.mode === 'live') renderJumps();
  if (state.mode === 'detail') showDetail(state.detail);
}

const unitToggle = () => `<div class="seg" role="group" aria-label="Units">
  <button type="button" data-unit="cm" aria-pressed="${state.unit === 'cm'}">cm</button>
  <button type="button" data-unit="in" aria-pressed="${state.unit === 'in'}">in</button></div>`;

function bindUnitToggle(root) {
  root.querySelectorAll('[data-unit]').forEach((b) => {
    b.onclick = () => setUnit(b.dataset.unit);
  });
}

// Browsers (iOS above all) only let sound start from a tap, so the audio is
// set up when the user starts a session, not when the first jump lands.
function primeAudio() {
  try {
    state.audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (state.audio.state === 'suspended') state.audio.resume();
  } catch { /* no sound on this device */ }
}

function beep() {
  try {
    const a = state.audio;
    if (!a) return;
    if (a.state === 'suspended') a.resume();
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.25, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.18);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + 0.2);
  } catch { /* sound is optional */ }
  try { navigator.vibrate?.(80); } catch { /* optional */ }
}

// -------------------------------------------------------------------- home

function showHome(message = '') {
  state.mode = 'home';
  document.body.classList.remove('is-live');
  liveEl.hidden = true;
  homeEl.hidden = false;
  window.scrollTo(0, 0);
  const sessions = loadSessions();
  const camOk = cameraSupported();
  homeEl.innerHTML = `
    <section class="card">
      <h2>Measure your vertical jump</h2>
      <p>Prop up your phone, jump, and the app estimates how high you went from how long you were in the air.</p>
      <div class="actions">
        <button class="btn" id="use-camera" ${camOk ? '' : 'disabled'}>Start camera</button>
        <label class="btn secondary file-btn">Use a video<input type="file" id="open-file" accept="video/*"></label>
      </div>
      ${camOk ? '' : '<p class="muted small" style="margin-top:10px">The camera needs a secure page (https). You can still use a recorded video.</p>'}
      <p class="form-error" id="home-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
      <p class="muted small">Slow-motion clips are more accurate. If your phone saves slow motion as a slowed-down file, you can tell the app how much it was slowed.</p>
    </section>
    <section class="card">
      <h3>Setting up</h3>
      <ol class="steps">
        <li>Prop the phone so it stays still.</li>
        <li>Keep your hips, legs and feet in view, from the front or the side, about 2 to 4 m away.</li>
        <li>Stand still until it says ready.</li>
        <li>Jump and land on the same spot, with your legs as straight as they were at takeoff.</li>
      </ol>
    </section>
    ${sessions.length ? `<section class="card">
      <h3>Recent sessions</h3>
      <ul class="plain history">${sessions.slice(0, 10).map((s) => {
    const b = best(s.jumps);
    return `<li><div><b>${esc(when(s.startedAt))}</b><br>
        <span class="muted small">${s.jumps.length} jump${s.jumps.length === 1 ? '' : 's'}${b ? ` · best ${heightText(b.heightM)} ${unitText()}` : ''}</span></div>
        <button class="btn secondary small-btn" data-view="${esc(s.id)}">View</button></li>`;
  }).join('')}</ul>
    </section>` : ''}`;

  $('#use-camera').onclick = () => startCamera('environment');
  $('#open-file').onchange = (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) startFile(file);
  };
  homeEl.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => showDetail(b.dataset.view);
  });
}

function homeError(msg) {
  const el = $('#home-error');
  if (!el) { showHome(msg); return; }
  el.textContent = msg;
  el.hidden = false;
}

function cameraMessage(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
    return 'The camera is blocked. Allow camera access in your browser settings, then try again.';
  }
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (e?.name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return e?.message || 'The camera could not be started.';
}

// ----------------------------------------------------------------- session detail

function showDetail(id) {
  const rec = loadSessions().find((s) => s.id === id);
  if (!rec) { showHome(); return; }
  state.mode = 'detail';
  state.detail = id;
  const b = best(rec.jumps);
  const avg = rec.jumps.reduce((n, j) => n + j.heightM, 0) / (rec.jumps.length || 1);
  homeEl.innerHTML = `
    <section class="card">
      <h2>${esc(when(rec.startedAt))}</h2>
      <div class="bar">${unitToggle()}</div>
      <div class="stats">
        <div><b>${rec.jumps.length}</b><span>jumps</span></div>
        <div><b>${b ? heightText(b.heightM) : '–'}</b><span>best (${unitText()})</span></div>
        <div><b>${rec.jumps.length ? heightText(avg) : '–'}</b><span>average (${unitText()})</span></div>
      </div>
      <ul class="jumps">${rec.jumps.map((j, i) => `<li class="${j === b ? 'best' : ''}">
        <div><b>${heightText(j.heightM)} ${unitText()}</b>${j === b ? '<span class="badge">Best</span>' : ''}<br>
        <span class="muted small">#${i + 1} · ${Math.round(j.flightTime * 1000)} ms · ${esc(j.confidence)} confidence</span></div></li>`).join('')}</ul>
      <div class="actions">
        <button class="btn" id="d-csv">Export CSV</button>
        <button class="btn secondary" id="d-back">Back</button>
        <button class="btn secondary danger" id="d-del">Delete session</button>
      </div>
    </section>`;
  bindUnitToggle(homeEl);
  $('#d-back').onclick = () => showHome();
  $('#d-csv').onclick = () => download(`jump-height-${rec.startedAt.slice(0, 16).replace(/[:T]/g, '-')}.csv`, sessionCSV(rec));
  $('#d-del').onclick = () => {
    if (confirm('Delete this session?')) { deleteSession(rec.id); showHome(); }
  };
  window.scrollTo(0, 0);
}

// -------------------------------------------------------------------- live

async function startCamera(facing) {
  if (state.opening) return; // a second tap while the permission prompt is up
  state.opening = true;
  primeAudio();
  state.fileMode = false;
  state.file = null;
  state.facing = facing;
  try {
    const info = await state.source.openCamera({ facing });
    state.opening = false;
    await enterLive(info);
  } catch (e) {
    state.source.close();
    homeError(cameraMessage(e));
  } finally {
    state.opening = false;
  }
}

async function startFile(file) {
  if (state.opening) return;
  state.opening = true;
  state.fileMode = true;
  state.file = file;
  state.speed = 1;
  try {
    const info = await state.source.openFile(file);
    state.opening = false;
    await enterLive(info);
  } catch (e) {
    state.source.close();
    homeError(e.message || 'That video could not be opened.');
  } finally {
    state.opening = false;
  }
}

function sizeStage(info) {
  const aspect = info?.aspect || state.aspect || 16 / 9;
  state.aspect = aspect;
  liveEl.style.setProperty('--aspect', aspect.toFixed(4));
  stage.classList.toggle('mirror', !state.fileMode && state.facing === 'user');
  sizeOverlay();
}

function sizeOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.max(1, Math.round(stage.clientWidth * dpr));
  overlay.height = Math.max(1, Math.round(stage.clientHeight * dpr));
  drawPose();
}
new ResizeObserver(sizeOverlay).observe(stage);

function resetRun() {
  state.jumps = [];
  state.status = null;
  state.landmarks = null;
  state.fps = null;
  state.lastFrameAt = 0;
  state.frames = 0;
  state.finished = false;
  state.id = newSessionId();
  state.startedAt = new Date().toISOString();
  state.detector = new JumpDetector();
}

async function enterLive(info) {
  state.mode = 'live';
  document.body.classList.add('is-live');
  homeEl.hidden = true;
  liveEl.hidden = false;
  window.scrollTo(0, 0);
  resetRun();
  buildPanel();
  sizeStage(info);
  if (!state.fileMode) {
    const release = await keepAwake();
    if (state.mode !== 'live') { release(); return; } // Done was tapped meanwhile
    state.release = release;
  }
  await ensurePose();
  if (state.mode !== 'live') return;
  if (state.pose && !state.fileMode) beginRun();
  else if (state.pose) updateFileControls();
}

async function ensurePose() {
  if (state.pose) return;
  loadingEl.hidden = false;
  setError('');
  try {
    state.poseModule ||= await import('./pose.js');
    state.pose = await state.poseModule.createPoseTracker();
  } catch (e) {
    setError(`The pose model could not be loaded. ${e?.message || ''} Check your connection and try again.`, true);
  } finally {
    loadingEl.hidden = true;
  }
}

function beginRun() {
  state.running = true;
  state.finished = false;
  state.lastFrameAt = 0;
  state.detector.reset();
  setError('');
  state.source.start(onFrame);
  setStatus(null);
  updateFileControls();
}

function onFrame(v, t) {
  const now = performance.now();
  if (state.lastFrameAt) {
    const inst = 1000 / Math.max(1, now - state.lastFrameAt);
    state.fps = state.fps == null ? inst : state.fps * 0.9 + inst * 0.1;
  }
  state.lastFrameAt = now;
  state.frames += 1;
  try {
    const { landmarks, sample } = state.pose.detect(v, t);
    state.landmarks = landmarks;
    // The detector works in real-world time; slow-motion files are scaled back.
    const rt = state.fileMode ? t / state.speed : t;
    const { status, jump } = state.detector.push({ ...sample, t: rt });
    drawPose();
    setStatus(status);
    if (jump) addJump(jump);
  } catch (e) {
    state.source.stop();
    state.running = false;
    setError(`Something went wrong while tracking. ${e?.message || ''}`, true);
    return;
  }
  if (now - state.lastFpsUi > 500) { state.lastFpsUi = now; renderFps(); }
}

function addJump(j) {
  state.jumps.push({
    at: Date.now(), heightM: j.heightM, flightTime: j.flightTime, confidence: j.confidence, notes: j.notes || [],
  });
  state.latest = state.jumps[state.jumps.length - 1];
  persist();
  renderJumps();
  beep();
}

function persist() {
  saveSession({
    id: state.id,
    startedAt: state.startedAt,
    jumps: state.jumps.map(({ at, heightM, flightTime, confidence }) => ({ at, heightM, flightTime, confidence })),
  });
}

function deleteJump(i) {
  const [gone] = state.jumps.splice(i, 1);
  if (state.latest === gone) state.latest = state.jumps[state.jumps.length - 1] || null;
  persist();
  renderJumps();
}

// ----------------------------------------------------------- live rendering

function buildPanel() {
  state.latest = null;
  panel.innerHTML = `
    <div class="status" id="status" role="status" aria-live="polite">Getting ready…</div>
    <p class="form-error" id="live-error" role="alert" hidden></p>
    <section class="card result-card" id="result-card"></section>
    <p class="notice small" id="fps-warn" hidden>The phone is processing few frames per second, so results will be less precise.</p>
    <section class="card" id="file-card" ${state.fileMode ? '' : 'hidden'}>
      <label class="field">Recorded in slow motion
        <select id="speed">${SPEEDS.map((s) => `<option value="${s}">${s === 1 ? 'No, normal speed' : `${s}× slower`}</option>`).join('')}</select>
      </label>
      <p class="muted small">Choose this before the video is processed. Changing it later restarts the video.</p>
      <div class="actions"><button class="btn" id="file-go" disabled>Start</button></div>
    </section>
    <section class="card">
      <div class="bar"><h3 style="margin:0">This session</h3>${unitToggle()}</div>
      <ul class="jumps" id="jumps"></ul>
      <p class="fps" id="fps"></p>
    </section>
    <div class="bar">
      ${state.fileMode ? '' : '<button class="btn secondary" id="flip">Flip camera</button>'}
      <button class="btn" id="done">Done</button>
    </div>`;
  bindUnitToggle(panel);
  $('#done').onclick = finish;
  const flip = $('#flip');
  if (flip) flip.onclick = flipCamera;
  if (state.fileMode) {
    $('#speed').onchange = (ev) => changeSpeed(Number(ev.target.value));
    $('#file-go').onclick = runFile;
  }
  renderJumps();
  renderFps();
}

function setStatus(status) {
  if (status === state.status) return;
  state.status = status;
  const el = $('#status');
  if (!el) return;
  el.className = `status ${status || ''}`;
  el.textContent = status ? STATUS_TEXT[status] || status : (state.running ? STATUS_TEXT['no-person'] : 'Getting ready…');
}

function setError(msg, retry = false) {
  const el = $('#live-error');
  if (!el) return;
  el.hidden = !msg;
  el.innerHTML = msg ? `${esc(msg)} ${retry ? '<button class="btn secondary small-btn" id="retry">Try again</button>' : ''}` : '';
  const r = $('#retry');
  if (r) {
    r.onclick = async () => {
      setError('');
      await ensurePose();
      if (!state.pose) return;
      if (state.fileMode) { await restartFile(); } else beginRun();
    };
  }
}

function renderJumps() {
  const list = $('#jumps');
  const card = $('#result-card');
  if (!list || !card) return;
  const b = best(state.jumps);
  const l = state.latest;
  const conf = l ? l.confidence : '';
  card.innerHTML = l ? `
    <div class="result" aria-label="Latest jump">${heightText(l.heightM)}<small>${unitText()}</small></div>
    <div class="result-meta">${Math.round(l.flightTime * 1000)} ms in the air ·
      <span class="conf ${esc(conf)}">${esc(conf)} confidence</span></div>
    ${conf !== 'high' && l.notes.length ? `<ul class="notes">${l.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
    : `<div class="result" aria-label="No jump yet">–<small>${unitText()}</small></div>
    <div class="result-meta">${state.jumps.length ? 'Latest jump deleted' : 'No jump yet'}</div>`;
  list.innerHTML = state.jumps.length ? state.jumps.map((j, i) => `
    <li class="${j === b ? 'best' : ''}">
      <div><b>${heightText(j.heightM)} ${unitText()}</b>${j === b ? '<span class="badge">Best</span>' : ''}<br>
        <span class="muted small">#${i + 1} · ${Math.round(j.flightTime * 1000)} ms · ${esc(j.confidence)}</span></div>
      <button class="icon-btn" data-del="${i}" aria-label="Delete jump ${i + 1}">✕</button>
    </li>`).reverse().join('') : '<li class="muted">Jumps you make will appear here.</li>';
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => deleteJump(Number(btn.dataset.del));
  });
  panel.querySelectorAll('[data-unit]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.unit === state.unit)));
}

function renderFps() {
  const el = $('#fps');
  const warn = $('#fps-warn');
  if (!el) return;
  // A file reports its own frame rate, which is what limits precision there;
  // for the camera it is how many frames the phone manages to process.
  const fileFps = state.fileMode && state.source.fps;
  el.textContent = state.fileMode
    ? (fileFps ? `Video: ${fileFps} frames per second${state.speed > 1 ? `, recorded at ${fileFps * state.speed}` : ''}` : '')
    : (state.fps ? `Processing ${state.fps.toFixed(0)} frames per second` : '');
  // Only the live camera is affected: a file is processed frame by frame at its own pace.
  if (warn) {
    warn.hidden = state.fileMode || !state.fps || state.frames < 15 || state.fps >= LOW_FPS;
    warn.textContent = state.fps < TOO_SLOW_FPS
      ? 'This device is processing too few frames per second to time a jump live. Record a video of the jump and use "Use a video" instead.'
      : 'The phone is processing few frames per second, so results will be less precise.';
  }
}

function updateFileControls() {
  if (!state.fileMode) return;
  const go = $('#file-go');
  if (!go) return;
  go.disabled = !state.pose || state.running;
  go.textContent = state.finished ? 'Run again' : 'Start';
  $('#speed').value = String(state.speed);
}

async function runFile() {
  primeAudio();
  if (state.finished || state.frames) await restartFile(); else beginRun();
}

async function restartFile() {
  state.source.stop();
  state.running = false;
  try {
    await state.source.openFile(state.file);
  } catch (e) {
    setError(e.message || 'That video could not be opened.');
    return;
  }
  // A re-run replaces the previous run's saved session; it must not leave a
  // duplicate, or a reading taken at the wrong slow-motion speed, in history.
  deleteSession(state.id);
  resetRun();
  renderJumps();
  setStatus(null);
  beginRun();
}

async function changeSpeed(speed) {
  state.speed = speed;
  // Re-run from the start if the video has already been processed.
  if (state.frames && state.pose) await restartFile();
  else updateFileControls();
}

async function flipCamera() {
  const next = state.facing === 'environment' ? 'user' : 'environment';
  const btn = $('#flip');
  btn.disabled = true;
  try {
    state.source.stop();
    const info = await state.source.openCamera({ facing: next });
    state.facing = next;
    state.detector.reset();
    state.landmarks = null;
    sizeStage(info);
    setStatus(null);
    state.lastFrameAt = 0;
    state.fps = null;
    // If the model is still loading, enterLive starts the frames when it is ready.
    if (state.pose) { state.source.start(onFrame); state.running = true; }
  } catch (e) {
    if (e?.name === 'SupersededError' || state.mode !== 'live') return; // Done was tapped mid-flip
    setError(cameraMessage(e));
    try {
      await state.source.openCamera({ facing: state.facing });
      if (state.pose) { state.source.start(onFrame); state.running = true; }
    } catch { /* leave the error showing */ }
  }
  btn.disabled = false;
}

function videoFinished() {
  if (state.mode !== 'live' || !state.fileMode || !state.running) return;
  state.running = false;
  state.finished = true;
  state.source.stop();
  // A jump that landed in the clip's last moments is still waiting to be scored.
  const last = state.detector.flush();
  if (last) addJump(last);
  const n = state.jumps.length;
  const el = $('#status');
  el.className = 'status';
  el.textContent = n ? `Video finished. ${n} jump${n === 1 ? '' : 's'} found.` : 'Video finished. No jump found.';
  state.status = 'finished';
  if (!n) {
    $('#result-card').insertAdjacentHTML('beforeend', `<ul class="notes">
      <li>Keep hips, legs and feet in view for the whole jump.</li>
      <li>Start with a second or two of standing still.</li>
      <li>If this was a slow-motion clip, set the slow-motion speed and run it again.</li></ul>`);
  }
  updateFileControls();
}
video.addEventListener('ended', videoFinished);

// ---------------------------------------------------------------- drawing

function drawPose() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const lm = state.landmarks;
  const mod = state.poseModule;
  if (!lm || !mod) return;
  const W = overlay.width;
  const H = overlay.height;
  const dpr = window.devicePixelRatio || 1;
  const ok = (p) => p && (p.visibility ?? 1) > 0.15; // matches the far-leg threshold in pose.js
  ctx.lineCap = 'round';
  for (const [i, j] of mod.POSE_CONNECTIONS || []) {
    if (i < 23 || j < 23) continue;
    const a = lm[i];
    const b = lm[j];
    if (!ok(a) || !ok(b)) continue;
    const foot = FEET.has(i) && FEET.has(j);
    ctx.strokeStyle = foot ? '#ffcf33' : 'rgba(255,255,255,.85)';
    ctx.lineWidth = (foot ? 5 : 3) * dpr;
    ctx.beginPath();
    ctx.moveTo(a.x * W, a.y * H);
    ctx.lineTo(b.x * W, b.y * H);
    ctx.stroke();
  }
  lm.forEach((p, i) => {
    if (!ok(p) || i < 23) return; // legs only: that is all the measurement uses
    const foot = FEET.has(i);
    ctx.fillStyle = foot ? '#ffcf33' : '#4cc9f0';
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, (foot ? 7 : 4) * dpr, 0, Math.PI * 2);
    ctx.fill();
    if (foot) { ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
  });
}

// ------------------------------------------------------------------ leaving

function finish() {
  if (state.running) { const last = state.detector?.flush(); if (last) addJump(last); }
  state.running = false;
  state.source.close();
  state.pose?.close();
  state.pose = null;
  state.release?.();
  state.release = null;
  state.landmarks = null;
  state.fps = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const id = state.id;
  const saved = state.jumps.length > 0;
  showHome();
  if (saved) showDetail(id);
}

document.addEventListener('visibilitychange', async () => {
  if (state.mode === 'live' && !state.fileMode && document.visibilityState === 'visible') {
    state.release?.();
    state.release = await keepAwake();
  }
});
window.addEventListener('pagehide', () => state.release?.());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

showHome();
