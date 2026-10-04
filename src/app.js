// Pool Tracker UI: pick a video source, line up the pool, track, review.
// Two ways of timing: a single lap to a finish (race-ui.js) or every length
// of a session (below).

import { applyH, cornersValid, poolToImage } from './homography.js';
import { cellIndex } from './grid.js';
import {
  PoolSession, formatTime, laneLabel, laneSettings, lengthMetres, sessionCSV, sessionRecord,
  strokeName, swimmerLabel,
} from './session.js';
import { STROKES } from './strokes.js';
import { VideoSource, cameraSupported, keepAwake } from './capture.js';
import { deleteSession, download, loadSessions, loadSetup, read, saveSession, saveSetup, write } from './store.js';
import { createRaceUI } from './race-ui.js';
import { SheetSync } from './sheets.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');

const homeEl = $('#home');
const workEl = $('#work');
const panel = $('#panel');
const stage = $('#stage');
const video = $('#video');
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');

// Distinct marker colours for swimmers (lane order), readable on water.
const COLORS = ['#ffcf33', '#ff6b6b', '#7cf29c', '#ff9f1c', '#c77dff', '#4cc9f0', '#f72585', '#b8f2e6', '#ffd6a5', '#9bf6ff'];
const CORNER_NAMES = [
  'Start wall, first-lane side',
  'Start wall, last-lane side',
  'Turn wall, last-lane side',
  'Turn wall, first-lane side',
];

const MODE_KEY = 'pool-tracker-mode';

const state = {
  mode: 'home',
  timing: read(MODE_KEY, 'race'), // 'race' (one lap to a finish) or 'session' (every length)
  source: new VideoSource(video),
  setup: loadSetup(),
  session: null,
  record: null,
  drag: -1,
  showFg: false,
  lastUi: 0,
  release: null,
  cellQuads: null,
};

// ------------------------------------------------------------------- home

function showHome() {
  state.mode = 'home';
  state.source.close();
  race.stop();
  workEl.hidden = true;
  homeEl.hidden = false;
  const isRace = state.timing === 'race';
  const sessions = isRace ? [] : loadSessions();
  homeEl.innerHTML = `
    <section class="card">
      <div class="seg" role="radiogroup" aria-label="What to time">
        <label><input type="radio" name="timing" value="race" ${isRace ? 'checked' : ''}><span>One lap to a finish</span></label>
        <label><input type="radio" name="timing" value="session" ${isRace ? '' : 'checked'}><span>Every length of a session</span></label>
      </div>
      ${isRace ? `<h2>Single-lap timer</h2>
      <p>Film swimmers coming towards the camera or crossing from the side. Press Start on the signal; each
        lane stops on its own when the swimmer touches the wall or crosses your line, and the times go to
        your Google Sheet.</p>` : `<h2>Lap and stroke timing from one camera</h2>
      <p>Point a phone or tablet at the pool. The app follows a swimmer in each lane and records
        every length: split time, stroke rate and stroke count.</p>`}
      <div class="actions">
        <button class="btn" id="use-camera" ${cameraSupported() ? '' : 'disabled'}>Use the camera</button>
        <label class="btn secondary file-btn">Open a video<input type="file" id="open-file" accept="video/*"></label>
      </div>
      ${cameraSupported() ? '' : '<p class="muted small">The camera needs a secure (https) page. You can still open a recorded video.</p>'}
      <p class="form-error" id="home-error" role="alert" hidden></p>
    </section>
    ${isRace ? `<section class="card">
      <h3>Setting up the camera</h3>
      <ol class="steps">
        <li><b>Coming towards you:</b> stand behind the finish wall, camera looking up the pool, a little above the water if you can (a tripod or a step).
          <b>Side on:</b> stand level with the finish, the higher the better, so near swimmers don't hide far ones.</li>
        <li>Keep the finish wall (or line) and a few metres of water in front of it in view, for every lane you want to time.</li>
        <li><b>Keep it still</b> — a tripod or phone clamp is best. Landscape works best side on.</li>
        <li>Press <b>Ready</b> a couple of seconds before the start: it learns what the empty water looks like.</li>
      </ol>
      <p class="muted small">If the camera misses a finish (or calls one wrongly), tap the lane's finish by hand or clear it.</p>
    </section>
    ${race.homeHTML()}` : `<section class="card">
      <h3>Setting up the camera</h3>
      <ol class="steps">
        <li><b>Up high, looking down the pool</b> from one end (a stand, balcony or tall tripod). The higher, the better swimmers stay apart.</li>
        <li><b>Both walls in view</b> — the ends swimmers turn at — and every lane you want to time.</li>
        <li><b>Keep it still</b> and in landscape. Plug in for long sessions.</li>
        <li>Start tracking <b>before</b> swimmers push off: it spends 4 seconds learning the empty water.</li>
      </ol>
      <p class="muted small">One swimmer per lane is the most accurate. For circle swimming, set up to 4 swimmers in a lane.
        Stroke type is read as Free/Back (arms alternate) or Fly/Breast (arms together); pick the exact stroke per lane if you like.</p>
    </section>`}
    ${sessions.length ? `<section class="card">
      <h3>Past sessions</h3>
      <ul class="plain history">${sessions.map((s) => `
        <li><div><b>${esc(new Date(s.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</b><br>
          <span class="muted small">${s.swimmers.length} swimmer${s.swimmers.length === 1 ? '' : 's'} ·
          ${s.swimmers.reduce((n, w) => n + w.lengths.length, 0)} lengths · ${s.length} ${esc(s.unit)} pool</span></div>
          <button class="btn secondary small-btn" data-view="${esc(s.id)}">View</button>
          <button class="btn secondary small-btn" data-csv="${esc(s.id)}">CSV</button>
          <button class="btn secondary danger small-btn" data-del="${esc(s.id)}" aria-label="Delete">✕</button>
        </li>`).join('')}</ul>
    </section>` : ''}
    <div id="past"></div>`;

  const next = () => (state.timing === 'race' ? race.showSetup() : showSetup());
  homeEl.querySelectorAll('input[name="timing"]').forEach((r) => r.addEventListener('change', () => {
    state.timing = r.value;
    write(MODE_KEY, r.value);
    // Times waiting for the Google Sheet go as soon as there's signal.
sync.flush();
window.addEventListener('online', () => sync.flush());

showHome();
  }));
  if (isRace) race.bindHome(showHome);
  $('#use-camera').onclick = async () => {
    try {
      await state.source.openCamera();
      next();
    } catch (e) {
      showError(e.name === 'NotAllowedError' ? 'Camera permission was refused. Allow it in the browser settings and try again.' : e.message);
    }
  };
  $('#open-file').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      await state.source.openFile(file);
      next();
    } catch (e) {
      showError(e.message);
    }
  };
  homeEl.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => {
      const rec = loadSessions().find((s) => s.id === b.dataset.view);
      $('#past').innerHTML = `<section class="card"><h3>${esc(new Date(rec.date).toLocaleString())}</h3>${recordTables(rec)}</section>`;
      $('#past').scrollIntoView({ behavior: 'smooth' });
    };
  });
  homeEl.querySelectorAll('[data-csv]').forEach((b) => {
    b.onclick = () => {
      const rec = loadSessions().find((s) => s.id === b.dataset.csv);
      download(`pool-session-${rec.date.slice(0, 16).replace(/[:T]/g, '-')}.csv`, sessionCSV(rec));
    };
  });
  homeEl.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      if (confirm('Delete this session?')) { deleteSession(b.dataset.del); showHome(); }
    };
  });
}

function showError(msg) {
  const el = $('#home-error');
  el.textContent = msg;
  el.hidden = false;
}

// ------------------------------------------------------------------ stage

function openWorkspace() {
  homeEl.hidden = true;
  workEl.hidden = false;
  const { width, height } = state.source.size;
  const aspect = width / height;
  stage.style.aspectRatio = `${width} / ${height}`;
  stage.style.width = `min(100%, calc(72vh * ${aspect.toFixed(4)}))`;
  sizeOverlay();
}

function sizeOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(stage.clientWidth * dpr);
  overlay.height = Math.round(stage.clientHeight * dpr);
  draw();
}
new ResizeObserver(sizeOverlay).observe(stage);

// Pool → overlay pixels.
function mapper(H) {
  return (x, y) => {
    const [u, v] = applyH(H, x, y);
    return [u * overlay.width, v * overlay.height];
  };
}

function currentH() {
  const { setup } = state;
  if (state.session) return state.session.H;
  if (!cornersValid(setup.corners)) return null;
  try { return poolToImage(setup.corners, setup.lanes, lengthMetres(setup)); } catch { return null; }
}

function draw(snap) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.mode.startsWith('race')) { race.draw(); return; }
  const { setup } = state;
  const dpr = window.devicePixelRatio || 1;
  const H = currentH();
  const editing = state.mode === 'setup';
  if (H) {
    const P = mapper(H);
    const L = lengthMetres(setup);
    ctx.lineWidth = 1.5 * dpr;
    // Lane lines.
    for (let k = 0; k <= setup.lanes; k++) {
      const edge = k === 0 || k === setup.lanes;
      ctx.strokeStyle = edge ? 'rgba(255,207,51,.9)' : `rgba(255,255,255,${editing ? 0.75 : 0.35})`;
      line(P(k, 0), P(k, L));
    }
    // Walls and distance marks every 5 m.
    ctx.strokeStyle = 'rgba(255,207,51,.9)';
    line(P(0, 0), P(setup.lanes, 0));
    line(P(0, L), P(setup.lanes, L));
    ctx.strokeStyle = `rgba(255,255,255,${editing ? 0.5 : 0.2})`;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    for (let d = 5; d < L - 0.5; d += 5) line(P(0, d), P(setup.lanes, d));
    ctx.setLineDash([]);
    // Lane numbers along the start wall.
    ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (let k = 0; k < setup.lanes; k++) {
      const on = laneSettings(setup, k).track;
      const [x, y] = P(k + 0.5, Math.min(1.2, L * 0.05));
      ctx.fillStyle = on ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.35)';
      ctx.fillText(String(setup.firstLane + k), x, y);
    }
    if (state.showFg && state.session?.fg) drawForeground();
    if (snap) drawSwimmers(P, snap);
  }
  if (editing) drawHandles(setup.corners);
}

function line([x0, y0], [x1, y1]) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

function drawHandles(corners) {
  const dpr = window.devicePixelRatio || 1;
  corners.forEach(([u, v], i) => {
    const x = u * overlay.width, y = v * overlay.height;
    ctx.fillStyle = '#ffcf33';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.arc(x, y, 13 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = `700 ${13 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + 0.5);
    ctx.textBaseline = 'alphabetic';
  });
}

// Cells the tracker currently sees as "not water" (for checking the setup).
function drawForeground() {
  const s = state.session;
  const g = s.geom;
  if (!state.cellQuads) {
    const P = mapper(s.H);
    const q = new Float32Array(g.nCells * 8);
    for (let lane = 0; lane < g.lanes; lane++) {
      for (let j = 0; j < g.across; j++) {
        for (let i = 0; i < g.nx; i++) {
          const c = cellIndex(g, lane, j, i);
          const x0 = lane + j / g.across, x1 = lane + (j + 1) / g.across;
          const y0 = i * g.cellLen, y1 = (i + 1) * g.cellLen;
          [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)].forEach(([a, b], k) => { q[c * 8 + k * 2] = a; q[c * 8 + k * 2 + 1] = b; });
        }
      }
    }
    state.cellQuads = q;
  }
  const q = state.cellQuads;
  const fg = s.fg;
  for (let c = 0; c < g.nCells; c++) {
    if (fg[c] <= 0) continue;
    ctx.fillStyle = `rgba(255,60,120,${Math.min(0.8, 0.2 + fg[c] * 0.2)})`;
    ctx.beginPath();
    ctx.moveTo(q[c * 8], q[c * 8 + 1]);
    for (let k = 1; k < 4; k++) ctx.lineTo(q[c * 8 + k * 2], q[c * 8 + k * 2 + 1]);
    ctx.fill();
  }
}

function drawSwimmers(P, snap) {
  const dpr = window.devicePixelRatio || 1;
  const { setup } = state;
  for (const ln of snap.lanes) {
    if (!ln) continue;
    for (const tr of ln.tracks) {
      const [x, y] = P(ln.lane + 0.5 + tr.y, tr.x);
      const color = COLORS[(ln.lane + tr.slot * 3) % COLORS.length];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3 * dpr;
      ctx.setLineDash(tr.hidden ? [4 * dpr, 4 * dpr] : []);
      ctx.beginPath(); ctx.arc(x, y, 11 * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // Arrow for direction of travel.
      if (Math.abs(tr.v) > 0.3) {
        const [ax, ay] = P(ln.lane + 0.5 + tr.y, tr.x + Math.sign(tr.v) * 2);
        line([x, y], [ax, ay]);
      }
      const name = swimmerLabel(setup, ln.lane, tr.slot, ln.swimmers.length);
      ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.strokeText(name, x + 14 * dpr, y + 4 * dpr);
      ctx.fillText(name, x + 14 * dpr, y + 4 * dpr);
    }
  }
}

// Corner dragging: the pool corners in session setup, the finish dots in
// race setup.
function handles() {
  if (state.mode === 'setup') return { corners: state.setup.corners, done: () => { saveSetup(state.setup); checkCorners(); } };
  if (state.mode === 'race-setup') return race.handles();
  return null;
}

function pointerPos(ev) {
  const r = overlay.getBoundingClientRect();
  return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height];
}
overlay.addEventListener('pointerdown', (ev) => {
  const h = handles();
  if (!h) return;
  const [u, v] = pointerPos(ev);
  const r = overlay.getBoundingClientRect();
  let best = -1, bestD = 40; // px
  h.corners.forEach(([cu, cv], i) => {
    const d = Math.hypot((cu - u) * r.width, (cv - v) * r.height);
    if (d < bestD) { best = i; bestD = d; }
  });
  if (best < 0) return;
  state.drag = best;
  overlay.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
overlay.addEventListener('pointermove', (ev) => {
  const h = handles();
  if (state.drag < 0 || !h) return;
  const [u, v] = pointerPos(ev);
  h.corners[state.drag] = [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))];
  draw();
});
const endDrag = () => {
  if (state.drag < 0) return;
  state.drag = -1;
  handles()?.done();
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------------ setup

function showSetup() {
  state.mode = 'setup';
  state.session = null;
  state.cellQuads = null;
  openWorkspace();
  overlay.classList.add('editing');
  const { setup } = state;
  panel.innerHTML = `
    <section class="card">
      <h2>Line up the pool</h2>
      <p>Drag the dots onto the corners of the water you want to watch, where the outer lane ropes
        (or pool edges) meet the walls:</p>
      <ol class="corner-key">${CORNER_NAMES.map((n, i) => `<li><span class="corner-dot">${i + 1}</span>${n}</li>`).join('')}</ol>
      <p class="muted small">Check that the drawn lane lines sit on the lane ropes all the way down.</p>
      <div class="row">
        <label class="field">Pool length <input id="len" type="number" min="10" max="100" step="any" value="${setup.length}"></label>
        <label class="field">Unit <select id="unit"><option value="m">metres</option><option value="yd" ${setup.unit === 'yd' ? 'selected' : ''}>yards</option></select></label>
      </div>
      <div class="row">
        <label class="field">Lanes in view <input id="lanes" type="number" min="1" max="10" value="${setup.lanes}"></label>
        <label class="field">First lane number <input id="first" type="number" min="0" max="20" value="${setup.firstLane}"></label>
      </div>
      <div class="lane-row lane-head"><span>Watch</span><span>Name</span><span>Stroke</span><span>Swimmers</span></div>
      <div class="lane-rows" id="lane-rows"></div>
      <p class="form-error" id="setup-error" role="alert" hidden></p>
      <div class="actions">
        <button class="btn" id="start">Start tracking</button>
        <button class="btn secondary" id="back">Back</button>
      </div>
    </section>`;
  renderLaneRows();
  const num = (id, lo, hi, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  };
  const onChange = () => {
    setup.length = num('#len', 10, 100, setup.length);
    setup.unit = $('#unit').value;
    const lanes = Math.round(num('#lanes', 1, 10, setup.lanes));
    const first = Math.round(num('#first', 0, 20, setup.firstLane));
    const redo = lanes !== setup.lanes || first !== setup.firstLane;
    setup.lanes = lanes;
    setup.firstLane = first;
    if (redo) renderLaneRows();
    saveSetup(setup);
    draw();
  };
  ['#len', '#unit', '#lanes', '#first'].forEach((id) => $(id).addEventListener('change', onChange));
  $('#back').onclick = showHome;
  $('#start').onclick = startTracking;
  checkCorners();
}

function renderLaneRows() {
  const { setup } = state;
  const rows = $('#lane-rows');
  rows.innerHTML = Array.from({ length: setup.lanes }, (_, i) => {
    const s = laneSettings(setup, i);
    return `<div class="lane-row ${s.track ? '' : 'off'}" data-lane="${i}">
      <label class="watch"><input type="checkbox" data-k="track" ${s.track ? 'checked' : ''}>${setup.firstLane + i}</label>
      <input type="text" data-k="name" maxlength="40" placeholder="Lane ${setup.firstLane + i}" value="${esc(s.name)}" aria-label="Swimmer name, lane ${setup.firstLane + i}">
      <select data-k="stroke" aria-label="Stroke">${Object.entries(STROKES).map(([k, v]) => `<option value="${k}" ${k === s.stroke ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <select data-k="swimmers" aria-label="Swimmers in lane">${[1, 2, 3, 4].map((n) => `<option ${n === s.swimmers ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>`;
  }).join('');
  rows.querySelectorAll('.lane-row').forEach((row) => {
    const i = Number(row.dataset.lane);
    row.addEventListener('change', (ev) => {
      const k = ev.target.dataset.k;
      const cur = { ...(setup.lane[i] || {}) };
      cur[k] = k === 'track' ? ev.target.checked : k === 'swimmers' ? Number(ev.target.value) : ev.target.value.trim();
      setup.lane[i] = cur;
      row.classList.toggle('off', !laneSettings(setup, i).track);
      saveSetup(setup);
      draw();
    });
  });
}

function checkCorners() {
  const err = $('#setup-error');
  if (!err) return true;
  const ok = cornersValid(state.setup.corners);
  err.textContent = ok ? '' : 'The corners are crossed over. Put them in order: 1 and 2 on the start wall, 3 and 4 on the turn wall.';
  err.hidden = ok;
  return ok;
}

// ---------------------------------------------------------------- tracking

async function startTracking() {
  const { setup, source } = state;
  if (!checkCorners()) return;
  if (![...Array(setup.lanes).keys()].some((i) => laneSettings(setup, i).track)) {
    const err = $('#setup-error');
    err.textContent = 'Tick at least one lane to watch.';
    err.hidden = false;
    return;
  }
  saveSetup(setup);
  const { width, height } = source.size;
  try {
    state.session = new PoolSession(setup, width, height);
  } catch (e) {
    const err = $('#setup-error');
    err.textContent = e.message;
    err.hidden = false;
    return;
  }
  state.mode = 'track';
  state.cellQuads = null;
  overlay.classList.remove('editing');
  renderTrackPanel();
  if (!source.live) video.currentTime = 0;
  state.release = await keepAwake();
  source.start((rgba, t) => {
    // A file that was rewound starts a fresh session.
    if (state.session.t !== null && t < state.session.t - 0.5) {
      state.session = new PoolSession(setup, width, height);
      renderTrackPanel();
    }
    state.session.process(rgba, t);
    const now = performance.now();
    const snap = state.session.snapshot();
    draw(snap);
    if (now - state.lastUi > 250) {
      state.lastUi = now;
      updateTrackPanel(snap);
    }
    if (source.ended) finishTracking();
  });
  video.onended = () => { if (state.mode === 'track') finishTracking(); };
}

function renderTrackPanel() {
  const { setup, session } = state;
  panel.innerHTML = `
    <section class="card">
      <div class="status-line"><span id="status">Starting…</span><span class="clock" id="clock"></span></div>
      <div class="meter" id="learn-meter"><div></div></div>
      <div class="actions">
        <button class="btn" id="clock-btn">Start race clock</button>
        <button class="btn secondary" id="finish">Finish</button>
      </div>
      <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <input type="checkbox" id="show-fg" ${state.showFg ? 'checked' : ''}> Show what the tracker sees</label>
    </section>
    ${session.lanes.map((lt, i) => (lt ? `
      <section class="card lane-card">
        <h3><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>${esc(laneLabel(setup, i))}
          <select data-stroke="${i}" aria-label="Stroke">${Object.entries(STROKES).map(([k, v]) => `<option value="${k}" ${k === lt.stroke ? 'selected' : ''}>${v.label}</option>`).join('')}</select></h3>
        <div id="lane-${i}"><p class="muted small">Waiting for a swimmer…</p></div>
      </section>` : '')).join('')}`;
  $('#clock-btn').onclick = () => {
    state.session.startClock();
    $('#clock-btn').textContent = 'Restart race clock';
  };
  $('#finish').onclick = finishTracking;
  $('#show-fg').onchange = (ev) => { state.showFg = ev.target.checked; };
  panel.querySelectorAll('[data-stroke]').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.dataset.stroke);
      state.session.setStroke(i, sel.value);
      setup.lane[i] = { ...(setup.lane[i] || {}), stroke: sel.value };
      saveSetup(setup);
    };
  });
}

function updateTrackPanel(snap) {
  const status = $('#status');
  if (!status) return;
  const meter = $('#learn-meter');
  if (snap.learning !== null) {
    status.textContent = 'Learning the empty water…';
    meter.hidden = false;
    meter.firstElementChild.style.width = `${Math.round(snap.learning * 100)}%`;
  } else {
    const n = snap.lanes.reduce((k, l) => k + (l ? l.tracks.length : 0), 0);
    status.textContent = `Tracking · ${n} swimmer${n === 1 ? '' : 's'} in view`;
    meter.hidden = true;
  }
  $('#clock').textContent = snap.clock !== null ? formatTime(snap.clock) : '';
  const { setup } = state;
  for (const ln of snap.lanes) {
    if (!ln) continue;
    const el = $(`#lane-${ln.lane}`);
    if (!el || !ln.swimmers.length) continue;
    el.innerHTML = ln.swimmers.map((sw) => {
      const last = sw.lengths[sw.lengths.length - 1];
      return `<div class="swimmer">
        ${ln.swimmers.length > 1 ? `<div class="swimmer-name">${esc(swimmerLabel(setup, ln.lane, sw.slot, ln.swimmers.length))}</div>` : ''}
        <div class="live">
          <div><b>${sw.current ? formatTime(sw.current.elapsed) : '–'}</b><span>${sw.current ? `length ${sw.lengths.length + 1}` : sw.active ? 'at the wall' : 'not in view'}</span></div>
          <div><b>${fmt(sw.liveRate)}</b><span>stroke rate /min</span></div>
          <div><b>${last ? formatTime(last.time) : '–'}</b><span>last length</span></div>
        </div>
        ${lengthsTable(sw.lengths, ln.stroke, sw.family)}
      </div>`;
    }).join('');
  }
}

function lengthsTable(lengths, stroke, family, { length: L, unit } = state.setup) {
  if (!lengths.length) return '';
  let cum = 0;
  const rows = lengths.map((l) => {
    cum += l.time;
    return `<tr><td>${l.n}</td><td>${formatTime(l.time)}${l.estimated ? '<span class="est" title="Start estimated">*</span>' : ''}</td>
      <td>${formatTime(cum)}</td><td>${l.strokes ?? '–'}</td><td>${fmt(l.rate)}</td></tr>`;
  }).join('');
  const withRate = lengths.filter((l) => l.rate);
  const avgRate = withRate.length ? withRate.reduce((s, l) => s + l.rate, 0) / withRate.length : NaN;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Length</th><th>Split</th><th>Total</th><th>Strokes</th><th>Rate</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>${lengths.length * L} ${esc(unit)}</td><td>${formatTime((cum / (lengths.length * L)) * 100)}<span class="muted small"> /100</span></td>
      <td>${formatTime(cum)}</td><td class="muted small">${esc(strokeName(stroke, family))}</td><td>${fmt(avgRate)}</td></tr></tfoot>
  </table></div>`;
}

function recordTables(rec) {
  if (!rec.swimmers.length) return '<p class="muted">No complete lengths were recorded.</p>';
  const html = rec.swimmers.map((sw) => `<div class="swimmer"><div class="swimmer-name">${esc(sw.name)}</div>
    ${lengthsTable(sw.lengths, sw.stroke, sw.lengths.find((l) => l.family)?.family, rec)}</div>`).join('');
  return `${html}<p class="muted small">Split = wall to wall. Rate = full arm cycles per minute. Strokes = hand entries
    (free/back) or cycles (fly/breast) per length. * start estimated (no race clock, swimmer first seen after the push-off).</p>`;
}

function finishTracking() {
  if (state.mode !== 'track') return;
  state.mode = 'done';
  state.source.stop();
  state.release?.();
  const { session } = state;
  session.finish();
  const rec = sessionRecord(session);
  state.record = rec;
  const saved = saveSession(rec);
  draw();
  panel.innerHTML = `
    <section class="card">
      <h2>Session results</h2>
      ${recordTables(rec)}
      ${rec.swimmers.length && !saved ? '<p class="form-error">Could not save on this device (storage full?). Download the CSV.</p>' : ''}
      <div class="actions">
        <button class="btn" id="csv" ${rec.swimmers.length ? '' : 'disabled'}>Download CSV</button>
        <button class="btn secondary" id="again">Track again</button>
        <button class="btn secondary" id="adjust">Adjust setup</button>
        <button class="btn secondary" id="home-btn">Done</button>
      </div>
    </section>`;
  $('#csv').onclick = () => download(`pool-session-${rec.date.slice(0, 16).replace(/[:T]/g, '-')}.csv`, sessionCSV(rec));
  $('#again').onclick = startTracking;
  $('#adjust').onclick = showSetup;
  $('#home-btn').onclick = showHome;
}

// ------------------------------------------------------------- single lap

const sync = new SheetSync();
const race = createRaceUI({
  state, $, esc, panel, overlay, ctx, video, sync,
  openWorkspace, showHome, draw, drawHandles, line,
});

// -------------------------------------------------------------------- boot

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

showHome();
