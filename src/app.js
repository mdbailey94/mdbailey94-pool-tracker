// Jump Height UI: pick a video source, watch for jumps, keep a list, review sessions.

import { VideoSource, cameraSupported, keepAwake } from './capture.js';
import { JumpDetector, analyseLanes } from './jump.js';
import {
  GUIDE, MAX_ATHLETES, TILT, assignLanes, cameraElevation, cameraRoll, framingHint, laneBounds, placementAdvice,
} from './lanes.js';
import {
  deleteSession, download, loadAthletes, loadSessions, loadUnit, newSessionId, saveAthletes, saveSession, saveUnit,
  sessionCSV,
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

const lanesEl = $('#lanes');
const FEET = new Set([27, 28, 29, 30, 31, 32]);
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
  rate: null, // file mode: how many times slower than life the clip plays
  facing: 'environment',
  pose: null,
  athletes: loadAthletes(), // how many athletes share the screen, each in their own lane
  lanes: [], // per athlete: { detector, rec, status, hint, entry }
  tilt: null, // { elevation, roll } from the motion sensor, when available
  poseModule: null,
  running: false,
  id: null,
  startedAt: null,
  jumps: [], // { at, athlete, heightM, flightTime, confidence, notes }
  status: null,
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
const ofAthlete = (jumps, i) => jumps.filter((j) => (j.athlete || 0) === i);
// "49.8–55.0": the range the true height is 95% likely to be in (older records have none).
const rangeText = (j) => (Number.isFinite(j.lowM) && Number.isFinite(j.highM) ? `${heightText(j.lowM)}–${heightText(j.highM)}` : '');
// What was allowed for, beyond flight time alone.
function adjustText(j) {
  const parts = [];
  if (j.bentLandingM < 0) parts.push(`${heightText(-j.bentLandingM)} ${unitText()} taken off for a bent-knee landing`);
  if (j.tuckM > 0) parts.push(`${heightText(j.tuckM)} ${unitText()} added for knees tucked in the air`);
  return parts.length ? `${parts.join('; ')}. Flight time alone gives ${heightText(j.flightHeightM)} ${unitText()}.` : '';
}
const NO_BODY = { footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN, visible: false };
const mirrored = () => !state.fileMode && state.facing === 'user';

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
      <p>Set the phone down, jump, and the app estimates how high you went from how long you were in the air.</p>
      <div class="field-row">
        <span id="ath-label">Athletes</span>
        <div class="seg" role="group" aria-labelledby="ath-label">${Array.from({ length: MAX_ATHLETES }, (_, i) => `
          <button type="button" data-ath="${i + 1}" aria-pressed="${state.athletes === i + 1}">${i + 1}</button>`).join('')}</div>
      </div>
      <div class="actions">
        <button class="btn" id="use-camera" ${camOk ? '' : 'disabled'}>Start camera</button>
        <label class="btn secondary file-btn">Use a video<input type="file" id="open-file" accept="video/*"></label>
      </div>
      ${camOk ? '' : '<p class="muted small" style="margin-top:10px">The camera needs a secure page (https). You can still use a recorded video.</p>'}
      <p class="form-error" id="home-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
      <p class="muted small">A recorded video is more accurate than the live camera, most of all at 120 frames per second. Slow motion is fine: the app works out the frame rate and how much the clip was slowed.</p>
    </section>
    <section class="card">
      <h3>Setting up</h3>
      <div class="setup">
        <svg class="setup-pic" viewBox="0 0 220 120" role="img" aria-label="Phone on the ground leaning back about 45 degrees, pointing up at an athlete 2 to 3 metres away">
          <line x1="6" y1="104" x2="214" y2="104" class="pic-ground"/>
          <rect x="22" y="70" width="9" height="40" rx="2" transform="rotate(-45 26.5 104)" class="pic-phone"/>
          <path d="M40 92 L150 34 M40 92 L150 100" class="pic-view"/>
          <path d="M54 104 A26 26 0 0 0 49 87" class="pic-arc"/><text x="60" y="99" class="pic-text">45°</text>
          <circle cx="168" cy="30" r="7" class="pic-body"/>
          <path d="M168 37 V72 M168 72 L160 103 M168 72 L176 103 M168 46 L156 62 M168 46 L180 62" class="pic-body-line"/>
          <text x="84" y="116" class="pic-text">2 to 3 m</text>
        </svg>
        <ol class="steps">
          <li>Put the phone on the ground, leaning back about 45°, so it looks up at the athletes from 2 to 3 m away. Prop it so it cannot move.</li>
          <li>${state.athletes > 1 ? 'Turn it sideways. Each athlete stands in their own section of the screen.' : 'Upright or sideways both work; sideways gives more room.'}</li>
          <li>Stand on the marker until it turns green. Hips, legs and feet must stay in view for the whole jump.</li>
          <li>Jump and land on the same spot, with your legs as straight as they were at takeoff.</li>
        </ol>
      </div>
    </section>
    ${sessions.length ? `<section class="card">
      <h3>Recent sessions</h3>
      <ul class="plain history">${sessions.slice(0, 10).map((s) => {
    const b = best(s.jumps);
    return `<li><div><b>${esc(when(s.startedAt))}</b><br>
        <span class="muted small">${s.athletes > 1 ? `${s.athletes} athletes · ` : ''}${s.jumps.length} jump${s.jumps.length === 1 ? '' : 's'}${b ? ` · best ${heightText(b.heightM)} ${unitText()}` : ''}</span></div>
        <button class="btn secondary small-btn" data-view="${esc(s.id)}">View</button></li>`;
  }).join('')}</ul>
    </section>` : ''}`;

  homeEl.querySelectorAll('[data-ath]').forEach((b) => {
    b.onclick = () => { state.athletes = Number(b.dataset.ath); saveAthletes(state.athletes); showHome(); };
  });
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
  const many = Math.max(rec.athletes || 1, ...rec.jumps.map((j) => (j.athlete || 0) + 1));
  homeEl.innerHTML = `
    <section class="card">
      <h2>${esc(when(rec.startedAt))}</h2>
      <div class="bar">${unitToggle()}</div>
      <div class="stats">
        <div><b>${rec.jumps.length}</b><span>jumps</span></div>
        <div><b>${b ? heightText(b.heightM) : '–'}</b><span>best (${unitText()})</span></div>
        <div><b>${rec.jumps.length ? heightText(avg) : '–'}</b><span>average (${unitText()})</span></div>
      </div>
      ${many > 1 ? `<div class="tiles" style="--lanes:${many}">${Array.from({ length: many }, (_, k) => {
    const mine = ofAthlete(rec.jumps, k);
    const top = best(mine);
    return `<div class="tile"><span class="tile-name">Athlete ${k + 1}</span>
          <b>${top ? heightText(top.heightM) : '–'}<small>${unitText()}</small></b>
          <span class="muted small">best of ${mine.length}</span></div>`;
  }).join('')}</div>` : ''}
      <ul class="jumps">${rec.jumps.map((j, i) => `<li class="${j === b ? 'best' : ''}">
        <div><b>${heightText(j.heightM)} ${unitText()}</b>${j === b ? '<span class="badge">Best</span>' : ''}<br>
        <span class="muted small">${many > 1 ? `Athlete ${(j.athlete || 0) + 1} · ` : ''}#${i + 1} · ${rangeText(j) ? `95% range ${rangeText(j)} · ` : ''}${Math.round(j.flightTime * 1000)} ms · ${esc(j.confidence)} confidence</span></div></li>`).join('')}</ul>
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
  watchTilt();
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
  state.fps = null;
  state.lastFrameAt = 0;
  state.frames = 0;
  state.finished = false;
  state.id = newSessionId();
  state.startedAt = new Date().toISOString();
  state.lanes = Array.from({ length: state.athletes }, () => ({
    detector: new JumpDetector(), rec: [], status: null, hint: null, entry: null, shown: '',
  }));
  state.rate = null;
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
  if (state.pose) beginRun(); // a file starts by itself: there is nothing to choose first
}

async function ensurePose() {
  if (state.pose) return;
  loadingEl.hidden = false;
  setError('');
  try {
    state.poseModule ||= await import('./pose.js');
    state.pose = await state.poseModule.createPoseTracker({ numPoses: state.athletes });
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
  state.lanes.forEach((l) => l.detector.reset());
  setError('');
  state.source.start(onFrame);
  setStatus('');
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
    const { poses } = state.pose.detect(v, t);
    const n = state.lanes.length;
    const entries = assignLanes(poses, n, v.videoWidth / v.videoHeight || 1, mirrored());
    entries.forEach((entry, i) => {
      const lane = state.lanes[i];
      const sample = entry ? entry.sample : NO_BODY;
      lane.entry = entry;
      if (state.fileMode) {
        // A file is only recorded here; it is measured as a whole when it ends, which is
        // what lets the app work out the play rate and cope with a tightly trimmed clip.
        lane.rec.push({ ...sample, t });
      } else {
        const { status, jump } = lane.detector.push({ ...sample, t });
        lane.status = status;
        // Where to stand is only worth saying while the athlete is on the ground.
        lane.hint = status === 'airborne' ? null : framingHint(entry, i, n, mirrored());
        if (jump) addJump(jump, i);
      }
    });
    drawPose();
    if (state.fileMode) {
      const pct = v.duration ? Math.min(99, Math.round((100 * t) / v.duration)) : 0;
      setStatus(`Reading the video… ${pct}%`);
    } else {
      renderLanes();
    }
  } catch (e) {
    state.source.stop();
    state.running = false;
    setError(`Something went wrong while tracking. ${e?.message || ''}`, true);
    return;
  }
  if (now - state.lastFpsUi > 500) { state.lastFpsUi = now; renderFps(); }
}

function addJump(j, athlete = 0) {
  state.jumps.push({
    at: Date.now(), athlete, heightM: j.heightM, flightTime: j.flightTime, confidence: j.confidence, notes: j.notes || [],
    lowM: j.lowM, highM: j.highM, flightHeightM: j.flightHeightM, bentLandingM: j.bentLandingM, tuckM: j.tuckM,
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
    athletes: state.lanes.length,
    jumps: state.jumps.map(({ at, athlete, heightM, flightTime, confidence, lowM, highM, flightHeightM }) => ({
      at, athlete, heightM, flightTime, confidence, lowM, highM, flightHeightM,
    })),
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
  const n = state.lanes.length;
  panel.innerHTML = `
    <div class="status" id="status" role="status" aria-live="polite">Getting ready…</div>
    <p class="form-error" id="live-error" role="alert" hidden></p>
    <p class="notice small" id="turn" hidden>Turn the phone sideways so each athlete gets a wider section.</p>
    ${state.fileMode ? '' : `<div class="tilt" id="tilt">
      <div class="tilt-bar" aria-hidden="true"><i class="tilt-zone"></i><i class="tilt-mark" id="tilt-mark"></i></div>
      <span id="tilt-text">Phone on the ground, leaning back about ${TILT.target}°.</span>
    </div>`}
    <section class="card result-card" id="result-card"></section>
    <p class="notice small" id="fps-warn" hidden>The phone is processing few frames per second, so results will be less precise.</p>
    <section class="card" id="file-card" hidden>
      <div class="actions"><button class="btn secondary" id="file-go" disabled>Run again</button></div>
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
    $('#file-go').onclick = runFile;
  }
  // One readout per athlete, laid over their section of the picture.
  lanesEl.style.setProperty('--lanes', n);
  lanesEl.innerHTML = state.lanes.map((_, i) => `
    <div class="lane" data-lane="${i}">
      <div class="lane-chip"><b>${i + 1}</b><span class="lane-status"></span></div>
      <div class="lane-result" aria-label="Athlete ${i + 1}, latest jump"></div>
    </div>`).join('');
  lanesEl.classList.toggle('single', n === 1);
  renderLanes();
  renderJumps();
  renderFps();
  renderTilt();
  renderTurn();
}

const LANE_TEXT = { settling: 'Stand still…', ready: 'Ready. Jump!', airborne: 'In the air…' };

// What an athlete should read in their lane right now, and how it is coloured.
function laneState(lane) {
  if (lane.status === 'airborne') return { cls: 'airborne', text: LANE_TEXT.airborne };
  if (lane.hint) return { cls: lane.entry ? 'fix' : 'empty', text: lane.hint };
  if (lane.status === 'ready') return { cls: 'ready', text: LANE_TEXT.ready };
  return { cls: 'settling', text: LANE_TEXT.settling };
}

function renderLanes() {
  if (state.fileMode) return;
  let ready = 0;
  state.lanes.forEach((lane, i) => {
    const { cls, text } = laneState(lane);
    if (cls === 'ready' || cls === 'airborne') ready++;
    if (lane.shown === cls + text) return; // the picture updates far more often than the words
    lane.shown = cls + text;
    const el = lanesEl.children[i];
    if (!el) return;
    el.className = `lane ${cls}`;
    el.querySelector('.lane-status').textContent = text;
  });
  const n = state.lanes.length;
  if (n === 1) {
    const { cls, text } = laneState(state.lanes[0]);
    setStatus(text, cls);
  } else {
    setStatus(`${ready} of ${n} athletes ready`, ready === n ? 'ready' : 'settling');
  }
}

function setStatus(text, cls = '') {
  const key = cls + text;
  if (key === state.status) return;
  state.status = key;
  const el = $('#status');
  if (!el) return;
  el.className = `status ${cls}`;
  el.textContent = text || 'Getting ready…';
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
  const n = state.lanes.length;
  const bests = state.lanes.map((_, i) => best(ofAthlete(state.jumps, i))); // each athlete's own best
  const l = state.latest;
  const conf = l ? l.confidence : '';
  const meta = (j) => `${Math.round(j.flightTime * 1000)} ms in the air ·
      <span class="conf ${esc(j.confidence)}">${esc(j.confidence)} confidence</span>`;
  if (n === 1) {
    card.innerHTML = l ? `
    <div class="result" aria-label="Latest jump">${heightText(l.heightM)}<small>${unitText()}</small></div>
    <div class="result-meta">${rangeText(l) ? `<b>95% range ${rangeText(l)} ${unitText()}</b><br>` : ''}${meta(l)}</div>
    ${adjustText(l) ? `<p class="adjust">${esc(adjustText(l))}</p>` : ''}
    ${conf !== 'high' && l.notes.length ? `<ul class="notes">${l.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`
      : `<div class="result" aria-label="No jump yet">–<small>${unitText()}</small></div>
    <div class="result-meta">${state.jumps.length ? 'Latest jump deleted' : 'No jump yet'}</div>`;
  } else {
    // One tile per athlete: their latest jump, and their best so far.
    card.innerHTML = `<div class="tiles" style="--lanes:${n}">${state.lanes.map((_, i) => {
      const mine = ofAthlete(state.jumps, i);
      const last = mine[mine.length - 1];
      return `<div class="tile"><span class="tile-name">Athlete ${i + 1}</span>
        <b>${last ? heightText(last.heightM) : '–'}<small>${unitText()}</small></b>
        <span class="muted small">${last && rangeText(last) ? `${rangeText(last)} · ` : ''}${bests[i] ? `best ${heightText(bests[i].heightM)}` : 'no jump yet'}</span></div>`;
    }).join('')}</div>
    ${l && adjustText(l) ? `<p class="adjust"><b>Athlete ${l.athlete + 1}:</b> ${esc(adjustText(l))}</p>` : ''}
    ${l && conf !== 'high' && l.notes.length ? `<ul class="notes"><li><b>Athlete ${l.athlete + 1}:</b> ${esc(l.notes[0])}</li></ul>` : ''}`;
  }
  // The same numbers over the picture, where each athlete can read their own.
  state.lanes.forEach((_, i) => {
    const el = lanesEl.children[i]?.querySelector('.lane-result');
    if (!el) return;
    const mine = ofAthlete(state.jumps, i);
    const last = mine[mine.length - 1];
    el.innerHTML = last ? `${heightText(last.heightM)}<small>${unitText()}</small>${rangeText(last) ? `<span class="lane-range">${rangeText(last)}</span>` : ''}` : '';
  });
  list.innerHTML = state.jumps.length ? state.jumps.map((j, i) => `
    <li class="${j === bests[j.athlete] ? 'best' : ''}">
      <div><b>${heightText(j.heightM)} ${unitText()}</b>${j === bests[j.athlete] ? '<span class="badge">Best</span>' : ''}<br>
        <span class="muted small">${n > 1 ? `Athlete ${j.athlete + 1} · ` : ''}#${i + 1} · ${rangeText(j) ? `${rangeText(j)} · ` : ''}${Math.round(j.flightTime * 1000)} ms · ${esc(j.confidence)}</span></div>
      <button class="icon-btn" data-del="${i}" aria-label="Delete jump ${i + 1}">✕</button>
    </li>`).reverse().join('') : '<li class="muted">Jumps you make will appear here.</li>';
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => deleteJump(Number(btn.dataset.del));
  });
  panel.querySelectorAll('[data-unit]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.unit === state.unit)));
}

// ------------------------------------------------------------ phone placement

// The motion sensor says how the phone is leaning. iPhones ask for permission, and
// only from a tap, so this is called straight from the Start camera button.
function watchTilt() {
  if (state.tiltOn || typeof DeviceOrientationEvent === 'undefined') return;
  const listen = () => {
    state.tiltOn = true;
    window.addEventListener('deviceorientation', onTilt);
  };
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') listen(); }).catch(() => {});
    } else listen();
  } catch { /* no sensor: the written tip stays */ }
}

function unwatchTilt() {
  window.removeEventListener('deviceorientation', onTilt);
  state.tiltOn = false;
  state.tilt = null;
}

function onTilt(ev) {
  if (ev.beta == null || ev.gamma == null) return;
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  const elevation = cameraElevation(ev.beta, ev.gamma, state.facing);
  const roll = cameraRoll(ev.beta, ev.gamma, angle);
  // Smoothed a little so the readout does not flicker.
  const k = state.tilt ? 0.25 : 1;
  state.tilt = state.tilt
    ? { elevation: state.tilt.elevation + k * (elevation - state.tilt.elevation), roll: state.tilt.roll + k * (roll - state.tilt.roll) }
    : { elevation, roll };
  const now = performance.now();
  if (now - (state.tiltUi || 0) > 150) { state.tiltUi = now; renderTilt(); }
}

function renderTilt() {
  const box = $('#tilt');
  if (!box) return;
  const t = state.tilt;
  if (!t) { box.className = 'tilt'; return; } // no sensor (or not allowed): the written tip stays
  const { ok, text } = placementAdvice(t.elevation, t.roll);
  box.className = `tilt live ${ok ? 'ok' : 'off'}`;
  $('#tilt-text').textContent = `${Math.round(t.elevation)}° · ${text}`;
  // The bar runs from lying flat (0°) to upright (90°); the zone marks the good range.
  $('#tilt-mark').style.left = `${Math.max(0, Math.min(100, (t.elevation / 90) * 100))}%`;
}

// With two or three athletes the picture should be wide, not tall.
function renderTurn() {
  const el = $('#turn');
  if (el) el.hidden = state.fileMode || state.lanes.length < 2 || !window.matchMedia('(orientation: portrait)').matches;
}
window.matchMedia('(orientation: portrait)').addEventListener?.('change', renderTurn);

function renderFps() {
  const el = $('#fps');
  const warn = $('#fps-warn');
  if (!el) return;
  // A file reports its own frame rate, which is what limits precision there;
  // for the camera it is how many frames the phone manages to process.
  const fileFps = state.fileMode && state.source.fps;
  el.textContent = state.fileMode
    ? (fileFps ? `Video: ${fileFps} frames per second${state.rate > 1 ? `, slowed ${state.rate}× (recorded at ${fileFps * state.rate})` : ''}` : '')
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
  $('#file-card').hidden = !state.finished; // only offered once a run has ended
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
  // duplicate in history.
  deleteSession(state.id);
  resetRun();
  renderJumps();
  setStatus('');
  beginRun();
}

async function flipCamera() {
  const next = state.facing === 'environment' ? 'user' : 'environment';
  const btn = $('#flip');
  btn.disabled = true;
  try {
    state.source.stop();
    const info = await state.source.openCamera({ facing: next });
    state.facing = next;
    state.lanes.forEach((l) => { l.detector.reset(); l.entry = null; l.status = null; l.hint = null; });
    state.tilt = null; // the two cameras point opposite ways
    sizeStage(info);
    setStatus('');
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

// Measures everything recorded from the file so far: finds the play rate and the jumps.
function analyseFile() {
  const { rate, lanes } = analyseLanes(state.lanes.map((l) => l.rec));
  state.rate = rate;
  // In the order they happened, whoever jumped.
  const found = lanes.flatMap((jumps, i) => jumps.map((j) => ({ j, i }))).sort((a, b) => a.j.takeoffT - b.j.takeoffT);
  state.lanes.forEach((l) => { l.rec = []; });
  found.forEach(({ j, i }) => addJump(j, i));
}

function videoFinished() {
  if (state.mode !== 'live' || !state.fileMode || !state.running) return;
  state.running = false;
  state.finished = true;
  state.source.stop();
  analyseFile();
  renderFps();
  const n = state.jumps.length;
  const el = $('#status');
  el.className = 'status';
  el.textContent = n ? `Video finished. ${n} jump${n === 1 ? '' : 's'} found.` : 'Video finished. No jump found.';
  state.status = 'finished';
  if (!n) {
    $('#result-card').insertAdjacentHTML('beforeend', `<ul class="notes">
      <li>Keep hips, legs and feet in view for the whole jump.</li>
      <li>Include about a second of standing still, before or after the jump.</li>
      <li>Hold the phone still, or prop it up.</li></ul>`);
  }
  updateFileControls();
}
video.addEventListener('ended', videoFinished);

// ---------------------------------------------------------------- drawing

const GUIDE_COLOR = { ready: '#3ddc84', airborne: '#4cc9f0', fix: '#ffb020', empty: 'rgba(255,255,255,.75)', settling: 'rgba(255,255,255,.75)' };

// Lane dividers and, for the live camera, where each athlete should stand: feet on
// the pad, and the whole jump under the top line. The guide turns green when the
// athlete is framed well and ready.
function drawGuides(W, H, dpr) {
  const n = state.lanes.length;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const [a, b] = laneBounds(i, n, mirrored());
    const x0 = a * W, w = (b - a) * W, cx = x0 + w / 2;
    if (a > 0) { // divider on this lane's left edge
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
    }
    if (state.fileMode) continue;
    const lane = state.lanes[i];
    const color = GUIDE_COLOR[laneState(lane).cls] || GUIDE_COLOR.empty;
    const half = (GUIDE.width * w) / 2;
    // Standing pad.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.ellipse(cx, GUIDE.padY * H, half, (GUIDE.padH * H) / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * dpr;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.ellipse(cx, GUIDE.padY * H, half, (GUIDE.padH * H) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Head-room line and the sides of the box the jump has to stay inside.
    ctx.setLineDash([10 * dpr, 8 * dpr]);
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - half, GUIDE.padY * H); ctx.lineTo(cx - half, GUIDE.top * H);
    ctx.lineTo(cx + half, GUIDE.top * H); ctx.lineTo(cx + half, GUIDE.padY * H);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawPose() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const W = overlay.width;
  const H = overlay.height;
  const dpr = window.devicePixelRatio || 1;
  if (state.mode !== 'live' || !state.lanes.length) return;
  drawGuides(W, H, dpr);
  const mod = state.poseModule;
  if (!mod) return;
  const ok = (p) => p && (p.visibility ?? 1) > 0.15; // matches the far-leg threshold in pose.js
  ctx.lineCap = 'round';
  for (const lane of state.lanes) {
    const lm = lane.entry?.landmarks;
    if (!lm) continue;
    for (const [i, j] of mod.POSE_CONNECTIONS || []) {
      if (i < 23 || j < 23) continue; // legs only: that is all the measurement uses
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
      if (!ok(p) || i < 23) return;
      const foot = FEET.has(i);
      ctx.fillStyle = foot ? '#ffcf33' : '#4cc9f0';
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, (foot ? 7 : 4) * dpr, 0, Math.PI * 2);
      ctx.fill();
      if (foot) { ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
    });
  }
}

// ------------------------------------------------------------------ leaving

function finish() {
  if (state.running && state.fileMode) analyseFile(); // Done tapped before the video ended
  else if (state.running) state.lanes.forEach((l, i) => { const last = l.detector.flush(); if (last) addJump(last, i); });
  state.running = false;
  state.source.close();
  state.pose?.close();
  state.pose = null;
  state.release?.();
  state.release = null;
  unwatchTilt();
  state.lanes.forEach((l) => { l.entry = null; });
  state.fps = null;
  lanesEl.innerHTML = '';
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
