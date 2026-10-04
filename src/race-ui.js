// Single-lap timer UI: mark the finish, press Start, the camera stops each
// lane at the touch (or line), times go to the device and the Google Sheet.

import { applyH, cornersValid } from './homography.js';
import {
  FinishSession, RACE_STROKES, VIEW_CORNERS, bandToImage, formatRaceTime, raceCSV, raceLane, raceLaneLabel,
  raceRecord, raceRows,
} from './finish.js';
import { YARD } from './session.js';
import { keepAwake } from './capture.js';
import { deleteRace, download, loadRaceSetup, loadRaces, saveRace, saveRaceSetup } from './store.js';
import { APPS_SCRIPT } from './sheets.js';

const DOT_NAMES = [
  'Finish line, lane-1 end',
  'Finish line, far end',
  'Back line, far end',
  'Back line, lane-1 end',
];
const VIEW_HINT = {
  head: 'Camera behind the finish wall, looking up the pool at swimmers coming towards it. Dots 1–2 go on the edge of the wall (or the finish line), dots 3–4 on a line across the pool further back, such as the backstroke flags.',
  side: 'Camera on the side of the pool, swimmers crossing the picture. Dots 1–2 go along the finish (the wall, or a line across the pool); dots 3–4 on a parallel line back towards where they come from.',
};

const timeStamp = (rec) => new Date(rec.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function createRaceUI(env) {
  const { state, $, esc, panel, overlay, ctx, video, sync } = env;
  const race = {
    setup: loadRaceSetup(),
    session: null,
    heat: 1,
    record: null, // the heat as last saved (null until saved)
    snap: null,
    lastUi: 0,
    release: null,
  };

  const metres = (v) => v * (race.setup.unit === 'yd' ? YARD : 1);

  // ------------------------------------------------------------- drawing

  function draw() {
    const { setup } = race;
    const dpr = window.devicePixelRatio || 1;
    const editing = state.mode === 'race-setup';
    if (cornersValid(setup.corners)) {
      let H = null;
      try { H = bandToImage(setup.corners, setup.lanes, metres(setup.depth)); } catch { /* collapsed */ }
      if (H) drawBand(H, dpr, editing);
    }
    if (editing) env.drawHandles(setup.corners);
  }

  function drawBand(H, dpr, editing) {
    const { setup } = race;
    const D = metres(setup.depth);
    const P = (x, y) => {
      const [u, v] = applyH(H, x, y);
      return [u * overlay.width, v * overlay.height];
    };
    ctx.lineWidth = 1.5 * dpr;
    for (let k = 0; k <= setup.lanes; k++) {
      ctx.strokeStyle = `rgba(255,255,255,${editing ? 0.75 : 0.35})`;
      env.line(P(k, 0), P(k, D));
    }
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = `rgba(255,255,255,${editing ? 0.5 : 0.25})`;
    for (let d = 1; d < D - 0.2; d += 1) env.line(P(0, d), P(setup.lanes, d));
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,207,51,.9)';
    env.line(P(0, D), P(setup.lanes, D));
    // The finish itself.
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = '#ff4d6d';
    env.line(P(0, 0), P(setup.lanes, 0));
    const snap = race.snap;
    ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (let k = 0; k < setup.lanes; k++) {
      const on = raceLane(setup, k).track;
      const ln = snap?.lanes[k];
      // Where the swimmer's front is, while they close in.
      if (ln && !ln.result && ln.lead !== null && ln.lead < D) {
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = '#7cf29c';
        env.line(P(k + 0.1, Math.max(0, ln.lead)), P(k + 0.9, Math.max(0, ln.lead)));
      }
      const [x, y] = P(k + 0.5, Math.min(D * 0.5, 0.8));
      ctx.fillStyle = on ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.35)';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      const label = ln?.result ? formatRaceTime(ln.result.time) : String(setup.firstLane + k);
      if (ln?.result) {
        ctx.font = `700 ${15 * dpr}px system-ui, sans-serif`;
        ctx.fillStyle = '#ffcf33';
      }
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);
      ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    }
  }

  // Corner dragging (app.js handles the pointer).
  function handles() {
    return {
      corners: race.setup.corners,
      done: () => { saveRaceSetup(race.setup); checkDots(); },
    };
  }

  // --------------------------------------------------------------- setup

  function showSetup() {
    state.mode = 'race-setup';
    race.session = null;
    race.snap = null;
    env.openWorkspace();
    overlay.classList.add('editing');
    const { setup } = race;
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    panel.innerHTML = `
      <section class="card">
        <h2>Set up the finish</h2>
        <div class="seg" role="radiogroup" aria-label="Camera view">
          <label><input type="radio" name="view" value="head" ${setup.view === 'head' ? 'checked' : ''}><span>Coming towards camera</span></label>
          <label><input type="radio" name="view" value="side" ${setup.view === 'side' ? 'checked' : ''}><span>Side on</span></label>
        </div>
        <div class="seg" role="radiogroup" aria-label="Finish">
          <label><input type="radio" name="finish" value="touch" ${setup.finish === 'touch' ? 'checked' : ''}><span>Touch on the wall</span></label>
          <label><input type="radio" name="finish" value="line" ${setup.finish === 'line' ? 'checked' : ''}><span>Crossing a line</span></label>
        </div>
        <p class="small" id="view-hint">${esc(VIEW_HINT[setup.view])}</p>
        <ol class="corner-key">${DOT_NAMES.map((n, i) => `<li><span class="corner-dot">${i + 1}</span>${n}</li>`).join('')}</ol>
        <div class="row">
          <label class="field">Dots 3–4 are back <input id="depth" type="number" min="1" max="25" step="any" value="${setup.depth}"></label>
          <label class="field">Unit <select id="unit">${opt('m', setup.unit, 'metres')}${opt('yd', setup.unit, 'yards')}</select></label>
        </div>
        <div class="row">
          <label class="field">Lanes in view <input id="lanes" type="number" min="1" max="10" value="${setup.lanes}"></label>
          <label class="field">First lane number <input id="first" type="number" min="0" max="20" value="${setup.firstLane}"></label>
        </div>
        <div class="lane-row race-lane lane-head"><span>Time</span><span>Swimmer</span></div>
        <div class="lane-rows" id="race-lanes"></div>
      </section>
      <section class="card">
        <h3>The race</h3>
        <div class="row">
          <label class="field">Distance <input id="distance" type="number" min="1" max="2000" step="any" value="${setup.distance}"></label>
          <label class="field">Stroke <select id="stroke">${RACE_STROKES.map((s) => opt(s, setup.stroke, s)).join('')}</select></label>
        </div>
        <label class="field">Event / set name (optional) <input id="event" type="text" maxlength="60" placeholder="e.g. 25 free sprint" value="${esc(setup.event)}"></label>
        <label class="field">Ignore finishes in the first … seconds
          <input id="ignore" type="number" min="0" max="600" step="any" value="${setup.ignore}"></label>
        <p class="small muted">${sync.connected ? `Times will go to your Google Sheet (tab “${esc(sync.config.tab)}”).` : 'No Google Sheet connected: times stay on this device. Connect one from the home screen.'}</p>
        <p class="form-error" id="setup-error" role="alert" hidden></p>
        <div class="actions">
          <button class="btn" id="ready">Ready</button>
          <button class="btn secondary" id="back">Back</button>
        </div>
      </section>`;
    renderLanes();
    const num = (id, lo, hi, fallback) => {
      const v = Number($(id).value);
      return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
    };
    panel.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener('change', () => {
      setup.view = r.value;
      // Start the dots from a shape that suits the view.
      setup.corners = VIEW_CORNERS[r.value].map((p) => [...p]);
      $('#view-hint').textContent = VIEW_HINT[r.value];
      saveRaceSetup(setup);
      checkDots();
      env.draw();
    }));
    panel.querySelectorAll('input[name="finish"]').forEach((r) => r.addEventListener('change', () => {
      setup.finish = r.value;
      saveRaceSetup(setup);
    }));
    const onChange = () => {
      setup.depth = num('#depth', 1, 25, setup.depth);
      setup.unit = $('#unit').value;
      setup.distance = num('#distance', 1, 2000, setup.distance);
      setup.stroke = $('#stroke').value;
      setup.event = $('#event').value.trim();
      setup.ignore = num('#ignore', 0, 600, setup.ignore);
      const lanes = Math.round(num('#lanes', 1, 10, setup.lanes));
      const first = Math.round(num('#first', 0, 20, setup.firstLane));
      const redo = lanes !== setup.lanes || first !== setup.firstLane;
      setup.lanes = lanes;
      setup.firstLane = first;
      if (redo) renderLanes();
      saveRaceSetup(setup);
      env.draw();
    };
    ['#depth', '#unit', '#lanes', '#first', '#distance', '#stroke', '#event', '#ignore'].forEach((id) => $(id).addEventListener('change', onChange));
    $('#back').onclick = env.showHome;
    $('#ready').onclick = () => startRace();
    checkDots();
    env.draw();
  }

  function renderLanes() {
    const { setup } = race;
    const rows = $('#race-lanes');
    rows.innerHTML = Array.from({ length: setup.lanes }, (_, i) => {
      const s = raceLane(setup, i);
      return `<div class="lane-row race-lane ${s.track ? '' : 'off'}" data-lane="${i}">
        <label class="watch"><input type="checkbox" data-k="track" ${s.track ? 'checked' : ''}>${setup.firstLane + i}</label>
        <input type="text" data-k="name" maxlength="40" placeholder="Lane ${setup.firstLane + i}" value="${esc(s.name)}" aria-label="Swimmer, lane ${setup.firstLane + i}">
      </div>`;
    }).join('');
    rows.querySelectorAll('.lane-row').forEach((row) => {
      const i = Number(row.dataset.lane);
      row.addEventListener('change', (ev) => {
        const k = ev.target.dataset.k;
        setup.lane[i] = { ...(setup.lane[i] || {}), [k]: k === 'track' ? ev.target.checked : ev.target.value.trim() };
        row.classList.toggle('off', !raceLane(setup, i).track);
        saveRaceSetup(setup);
        env.draw();
      });
    });
  }

  function checkDots() {
    const err = $('#setup-error');
    if (!err) return true;
    const ok = cornersValid(race.setup.corners);
    err.textContent = ok ? '' : 'The dots are crossed over. 1 and 2 go on the finish, 3 and 4 on the line behind it (3 opposite 2, 4 opposite 1).';
    err.hidden = ok;
    return ok;
  }

  function setupError(msg) {
    const err = $('#setup-error');
    err.textContent = msg;
    err.hidden = false;
  }

  // ---------------------------------------------------------------- race

  async function startRace() {
    const { setup } = race;
    const { source } = state;
    if (!checkDots()) return;
    if (![...Array(setup.lanes).keys()].some((i) => raceLane(setup, i).track)) return setupError('Tick at least one lane to time.');
    saveRaceSetup(setup);
    const { width, height } = source.size;
    try {
      race.session = new FinishSession(setup, width, height);
    } catch (e) {
      return setupError(e.message);
    }
    state.mode = 'race';
    race.record = null;
    race.snap = null;
    overlay.classList.remove('editing');
    renderRacePanel();
    source.stop();
    if (!source.live && source.ended) video.currentTime = 0;
    race.release?.();
    race.release = await keepAwake();
    source.start((rgba, t) => {
      const s = race.session;
      if (!s) return;
      // A file rewound past the start: that start no longer applies.
      if (s.started && t < s.startT - 0.5) resetHeat();
      const done = s.process(rgba, t);
      race.snap = s.snapshot();
      env.draw();
      if (done.length) onFinish();
      const now = performance.now();
      if (done.length || now - race.lastUi > 100) {
        race.lastUi = now;
        updateRacePanel();
      }
    });
    video.onended = () => { if (state.mode === 'race') updateRacePanel(); };
  }

  function now(ev) {
    // Live camera frames are stamped on the page clock, which is also what a
    // tap's timeStamp uses; a file runs on its own media time.
    return state.source.live ? (ev?.timeStamp ?? performance.now()) / 1000 : video.currentTime;
  }

  function renderRacePanel() {
    const s = race.session;
    const { setup } = race;
    panel.innerHTML = `
      <section class="card">
        <div class="status-line"><span id="status">Starting…</span><span class="clock big" id="clock">0.00</span></div>
        <div class="meter" id="learn-meter"><div></div></div>
        <div class="actions">
          <button class="btn start-btn" id="start-btn">Start</button>
        </div>
        <p class="small muted" id="race-note">Press Start (or the space bar) on the start signal.</p>
        ${state.source.live ? '' : `<label class="field small">Playback speed
          <select id="speed"><option value="1">1×</option><option value="0.5">½×</option><option value="0.25">¼×</option></select></label>`}
      </section>
      <section class="card">
        <h3>${esc(setup.event || `${setup.distance} ${setup.unit} ${setup.stroke}`)} · Heat ${race.heat}</h3>
        <ul class="plain race-lanes">${s.lanes.map((lf, i) => (lf ? `
          <li data-lane="${i}">
            <span class="lane-no">${setup.firstLane + i}</span>
            <span class="lane-name">${esc(raceLaneLabel(setup, i))}</span>
            <span class="lane-time" id="time-${i}">–</span>
            <button class="btn secondary small-btn" data-tap="${i}" title="Record this lane's finish now">Tap finish</button>
            <button class="btn secondary small-btn" data-clear="${i}" title="Throw this time away and watch again" hidden>Clear</button>
          </li>` : '')).join('')}</ul>
        <p class="small" id="sheet-status"></p>
        <div class="actions">
          <button class="btn secondary" id="next" hidden>Next heat</button>
          <button class="btn secondary" id="done">Done</button>
        </div>
      </section>`;
    $('#start-btn').addEventListener('pointerdown', (ev) => pressStart(ev));
    $('#start-btn').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pressStart(ev); });
    $('#done').onclick = endRace;
    $('#next').onclick = nextHeat;
    $('#speed')?.addEventListener('change', (ev) => { video.playbackRate = Number(ev.target.value); });
    panel.querySelectorAll('[data-tap]').forEach((b) => {
      b.addEventListener('pointerdown', (ev) => {
        const t = now(ev);
        if (!race.session.started) return;
        race.session.manualFinish(Number(b.dataset.tap), t);
        onFinish();
        updateRacePanel();
      });
    });
    panel.querySelectorAll('[data-clear]').forEach((b) => {
      b.onclick = () => {
        race.session.clearFinish(Number(b.dataset.clear));
        if (race.record) saveHeat(); // correct what was saved and sent
        updateRacePanel();
      };
    });
    updateRacePanel();
  }

  function pressStart(ev) {
    const s = race.session;
    if (!s) return;
    if (s.started && !confirm('Restart the clock? Times so far in this heat are thrown away.')) return;
    if (s.started) clearSaved();
    s.start(now(ev));
    if (!state.source.live && video.paused) video.play().catch(() => {});
    updateRacePanel();
  }

  function onFinish() {
    navigator.vibrate?.(40);
    if (race.session.allDone || race.record) saveHeat();
  }

  // Save the heat on the device and send it to the sheet. Called when every
  // lane is in, on Done, and again after any later correction.
  function saveHeat() {
    const s = race.session;
    if (!s?.started) return;
    const date = race.record ? new Date(race.record.date) : new Date();
    const prev = race.record ? raceRows(race.record) : [];
    const rec = raceRecord(s, { heat: race.heat, date });
    if (race.record && JSON.stringify(rec) === JSON.stringify(race.record)) return; // nothing new
    race.record = rec;
    saveRace(rec);
    const rows = raceRows(rec);
    const ids = new Set(rows.map((r) => r.id));
    // Times cleared since the last save come out of the sheet too.
    const removed = prev.filter((r) => !ids.has(r.id)).map((r) => ({ id: r.id, deleted: true }));
    sync.add([...rows, ...removed]);
  }

  function clearSaved() {
    if (!race.record) return;
    sync.add(raceRows(race.record).map((r) => ({ id: r.id, deleted: true })));
    deleteRace(race.record.id);
    race.record = null;
  }

  function resetHeat() {
    clearSaved();
    race.session.startT = null;
    race.session.lanes.forEach((lf) => lf?.clear());
    updateRacePanel();
  }

  function updateRacePanel() {
    const s = race.session;
    const snap = (race.snap = s.snapshot());
    const status = $('#status');
    if (!status) return;
    const meter = $('#learn-meter');
    meter.hidden = snap.learning === null;
    if (snap.learning !== null) meter.firstElementChild.style.width = `${Math.round(snap.learning * 100)}%`;
    const done = s.started && s.allDone;
    status.textContent = snap.learning !== null ? 'Learning the empty water…'
      : !s.started ? 'Ready' : done ? 'All in' : 'Racing';
    $('#clock').textContent = formatRaceTime(snap.clock ?? 0);
    const btn = $('#start-btn');
    btn.textContent = s.started ? 'Restart' : 'Start';
    btn.classList.toggle('secondary', s.started);
    $('#race-note').hidden = s.started;
    $('#next').hidden = !s.started;
    snap.lanes.forEach((ln) => {
      if (!ln) return;
      const el = $(`#time-${ln.lane}`);
      el.innerHTML = ln.result
        ? `${formatRaceTime(ln.result.time)}${ln.result.method === 'manual' ? '<span class="tag">tap</span>' : ''}`
        : s.started ? (ln.lead !== null && ln.lead < s.depth ? `${ln.lead.toFixed(1)} m` : '…') : '–';
      el.classList.toggle('in', Boolean(ln.result));
      panel.querySelector(`[data-tap="${ln.lane}"]`).hidden = Boolean(ln.result) || !s.started;
      panel.querySelector(`[data-clear="${ln.lane}"]`).hidden = !ln.result;
    });
    renderSheetStatus();
  }

  function renderSheetStatus() {
    const el = $('#sheet-status');
    if (!el) return;
    el.textContent = race.record ? `Saved on this device. ${sheetLine()}` : '';
  }

  function sheetLine() {
    const st = sync.status;
    if (!sync.connected) return 'No Google Sheet connected.';
    switch (st.state) {
      case 'sending': return 'Sending to the sheet…';
      case 'sent': return st.confirmed === false ? 'Sent to the sheet.' : 'In the sheet ✓';
      case 'queued': return `${st.reason} (${sync.pending.length} waiting)`;
      case 'error': return `Sheet problem: ${st.reason}`;
      default: return '';
    }
  }

  function endRace() {
    const s = race.session;
    state.source.stop();
    race.release?.();
    race.release = null;
    if (s?.started) saveHeat();
    state.mode = 'race-done';
    const rec = race.record;
    env.draw();
    panel.innerHTML = `
      <section class="card">
        <h2>${rec ? `${esc(rec.event || `${rec.distance} ${rec.unit} ${rec.stroke}`)} · Heat ${rec.heat}` : 'No times'}</h2>
        ${rec ? heatTable(rec) : '<p class="muted">The clock was never started.</p>'}
        <p class="small" id="sheet-status"></p>
        <div class="actions">
          <button class="btn" id="next">Next heat</button>
          ${rec ? '<button class="btn secondary" id="csv">Download CSV</button>' : ''}
          <button class="btn secondary" id="adjust">Adjust setup</button>
          <button class="btn secondary" id="home-btn">Done</button>
        </div>
      </section>`;
    renderSheetStatus();
    $('#next').onclick = nextHeat;
    if (rec) $('#csv').onclick = () => download(`heat-${rec.date.slice(0, 16).replace(/[:T]/g, '-')}.csv`, raceCSV([rec]));
    $('#adjust').onclick = showSetup;
    $('#home-btn').onclick = env.showHome;
  }

  function nextHeat() {
    const s = race.session;
    if (s?.started && state.mode === 'race') saveHeat();
    if (race.record || s?.started) race.heat++;
    startRace();
  }

  function stop() {
    race.release?.();
    race.release = null;
    race.session = null;
  }

  // ---------------------------------------------------------------- home

  function heatTable(rec) {
    return `<div class="table-wrap"><table>
      <thead><tr><th>Lane</th><th class="left">Swimmer</th><th>Time</th></tr></thead>
      <tbody>${rec.results.map((r) => `<tr><td>${r.lane}</td><td class="left">${esc(r.name)}</td>
        <td>${Number.isFinite(r.time) ? `${formatRaceTime(r.time)}${r.method === 'manual' ? ' <span class="tag">tap</span>' : ''}` : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function homeHTML() {
    const races = loadRaces();
    const cfg = sync.config;
    const pending = sync.pending.length;
    return `
      <section class="card">
        <h3>Google Sheet</h3>
        <p class="small">${sync.connected ? `Connected — finished heats are added to the “${esc(cfg.tab)}” tab automatically.` : 'Not connected. Each finished heat can be added to a Google Sheet automatically.'}
          ${pending ? `<br><b>${pending} time${pending === 1 ? '' : 's'} waiting to send.</b> <button class="btn secondary small-btn" id="send-now">Send now</button>` : ''}</p>
        <details ${sync.connected ? '' : 'open'}>
          <summary>${sync.connected ? 'Change the sheet' : 'Set it up (about 2 minutes, once)'}</summary>
          <ol class="steps small">
            <li>Make a new Google Sheet (sheets.new) and open <b>Extensions → Apps Script</b>.</li>
            <li>Replace what's there with this script, and save:
              <textarea class="code" id="script" readonly rows="6">${esc(APPS_SCRIPT)}</textarea>
              <button class="btn secondary small-btn" id="copy-script">Copy script</button></li>
            <li><b>Deploy → New deployment</b>, type <b>Web app</b>. Execute as: <b>Me</b>. Who has access: <b>Anyone</b>.
              Deploy and allow access.</li>
            <li>Paste the <b>Web app URL</b> (ends in <code>/exec</code>) here:</li>
          </ol>
          <label class="field">Web app URL <input id="sheet-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.url)}"></label>
          <label class="field">Tab name <input id="sheet-tab" type="text" maxlength="60" value="${esc(cfg.tab)}"></label>
          <p class="small" id="sheet-msg" role="status"></p>
          <div class="actions">
            <button class="btn" id="sheet-save">Test and save</button>
            ${sync.connected ? '<button class="btn secondary danger" id="sheet-off">Disconnect</button>' : ''}
          </div>
          <p class="muted small">Anyone with that URL can add rows to the sheet, so keep it to yourself. Times also stay on this device.</p>
        </details>
      </section>
      ${races.length ? `<section class="card">
        <h3>Past heats</h3>
        <ul class="plain history">${races.slice(0, 30).map((r) => `
          <li><div><b>${esc(r.event || `${r.distance} ${r.unit} ${r.stroke}`)} · Heat ${r.heat}</b>
            <span class="muted small">${esc(timeStamp(r))}</span><br>
            <span class="small">${r.results.filter((x) => Number.isFinite(x.time)).map((x) => `${esc(x.name)} <b>${formatRaceTime(x.time)}</b>`).join(' · ')}</span></div>
            <button class="btn secondary danger small-btn" data-del-heat="${esc(r.id)}" aria-label="Delete heat">✕</button>
          </li>`).join('')}</ul>
        <div class="actions">
          <button class="btn secondary" id="heats-csv">Download all (CSV)</button>
          ${sync.connected ? '<button class="btn secondary" id="heats-send">Send all to the sheet</button>' : ''}
        </div>
      </section>` : ''}`;
  }

  function bindHome(rerender) {
    const msg = (t) => { $('#sheet-msg').textContent = t; };
    $('#copy-script').onclick = async () => {
      try { await navigator.clipboard.writeText(APPS_SCRIPT); msg('Script copied.'); } catch { $('#script').select(); msg('Select all and copy the script.'); }
    };
    $('#sheet-save').onclick = async () => {
      const url = $('#sheet-url').value.trim();
      msg('Checking…');
      const res = await sync.test(url);
      msg(res.message);
      if (!res.ok) return;
      sync.config = { url, tab: $('#sheet-tab').value };
      sync.flush();
      setTimeout(rerender, 900);
    };
    if ($('#sheet-off')) {
      $('#sheet-off').onclick = () => { sync.config = { url: '', tab: sync.config.tab }; rerender(); };
    }
    if ($('#send-now')) $('#send-now').onclick = () => sync.flush().then(rerender);
    if ($('#heats-csv')) $('#heats-csv').onclick = () => download('pool-heats.csv', raceCSV(loadRaces()));
    if ($('#heats-send')) {
      $('#heats-send').onclick = () => {
        sync.add(loadRaces().flatMap(raceRows)).then(rerender);
      };
    }
    document.querySelectorAll('[data-del-heat]').forEach((b) => {
      b.onclick = () => {
        if (!confirm('Delete this heat from the device? (It stays in the Google Sheet.)')) return;
        deleteRace(b.dataset.delHeat);
        rerender();
      };
    });
  }

  // Space bar starts the clock (handy with a laptop or a keyboard remote).
  document.addEventListener('keydown', (ev) => {
    if (state.mode !== 'race' || ev.code !== 'Space' || ev.repeat) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    ev.preventDefault();
    pressStart(ev);
  });

  sync.onChange = () => renderSheetStatus();

  return { showSetup, draw, handles, homeHTML, bindHome, stop };
}
