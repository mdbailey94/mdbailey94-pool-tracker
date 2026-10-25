// Season: the plan the daily sessions come from — dates, the weekly
// schedule (AM every day but Sunday, doubles on some days), phases with an
// AM and PM focus for each weekday, meets, the groups' interval columns and
// the gear chart that turns a group's pace into send-offs.

import {
  FOCUSES, PHASE_PRESETS, WEEKDAYS, addDays, defaultPlan, longDate, makeMeet, makePhase, makeWeek, mondayOf, planPosition, planWeeks,
} from '../../practice.js';
import { DEFAULT_GEAR_MODEL, fmtClock, makeGearModel, paceOf, parseClock, racePredictions, sendOff } from '../../gears.js';
import { focusLabel } from '../render.js';
import { BANDS, DEFAULT_TARGETS, phaseTargets } from '../../week.js';

const SHORT = { aerobic: 'Aero', threshold: 'Thresh', race: 'Race', speed: 'Speed', technique: 'Tech', recovery: 'Recov', rest: 'Rest' };
const COURSES = ['SCY', 'SCM', 'LCM'];
const TABLE_GEARS = ['G2', 'G3', 'G4', 'G5', 'G6'];
const STROKE_KEYS = [['back', 'BK'], ['breast', 'BR'], ['fly', 'FL'], ['IM', 'IM'], ['choice', 'Choice']];
const KIND_KEYS = [['kick', 'Kick'], ['pull', 'Pull'], ['drill', 'Drill']];
const SAMPLE = [[100, 'G2'], [100, 'G3'], [100, 'G4'], [50, 'G5'], [25, 'G6']];
const SAMPLE_STROKES = [['free', 'Free'], ['back', 'BK'], ['breast', 'BR'], ['fly', 'FL'], ['IM', 'IM']];

const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
// Rough, generic bands for the fatigue factor (Riegel's 1.06 sits in the middle).
const swimmerType = (f) => (f < 1.05 ? 'distance' : f > 1.08 ? 'sprint' : 'middle distance / IM');

function positionText(pos) {
  if (pos.status === 'before') return `Season starts in ${pos.daysToStart} day${pos.daysToStart === 1 ? '' : 's'}`;
  if (pos.status === 'after') return 'Season finished · off-season';
  if (pos.status === 'empty') return 'No phases in the plan yet';
  return `Now: ${pos.phase.name} · week ${pos.phaseWeek + 1} of ${pos.phase.weeks} · season week ${pos.week + 1}`;
}

function uiOf(state) {
  const ui = (state.ui.season ||= {});
  ui.meet ??= null; // meet being added / edited
  return ui;
}

// Inputs commit on change, which fires on blur — often because the coach
// pressed a button. Re-render only after that click has landed (else the
// button is replaced mid-click and the press is lost) and after focus has
// moved, so the cursor can be put back where it went.
let pointerDown = false;
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', () => { setTimeout(() => { pointerDown = false; }, 0); }, true);
document.addEventListener('pointercancel', () => { pointerDown = false; }, true);

function settled() {
  return new Promise((resolve) => {
    if (!pointerDown) { setTimeout(resolve, 0); return; }
    const done = () => { clearTimeout(t); setTimeout(resolve, 0); };
    const t = setTimeout(() => { document.removeEventListener('pointerup', done, true); resolve(); }, 1500);
    document.addEventListener('pointerup', done, { once: true, capture: true });
  });
}

// Save the plan, re-render and put the cursor back where the coach was.
async function commit(ctx, el) {
  await ctx.save.plan();
  await settled();
  if (ctx.state.tab !== 'season') return;
  const a = document.activeElement;
  const sel = a?.dataset?.f ? `[data-f="${CSS.escape(a.dataset.f)}"]`
    : a?.dataset?.chip ? `[data-chip="${CSS.escape(a.dataset.chip)}"][data-value="${CSS.escape(a.dataset.value || '')}"]`
      : a?.id && el.contains(a) ? `#${CSS.escape(a.id)}` : null;
  ctx.rerender();
  if (sel) el.querySelector(sel)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- render

export function render(ctx, el) {
  const { state } = ctx;
  const ui = uiOf(state);
  el.innerHTML = [
    basicsHTML(ctx),
    weekHTML(ctx),
    phasesHTML(ctx),
    meetsHTML(ctx, ui),
    groupsHTML(ctx),
    gearsHTML(ctx),
    learnedHTML(ctx),
  ].join('');
  bindBasics(ctx, el);
  bindWeek(ctx, el);
  bindPhases(ctx, el);
  bindMeets(ctx, el, ui);
  bindGroups(ctx, el);
  bindGears(ctx, el);
}

// ----------------------------------------------------------------- basics

function basicsHTML(ctx) {
  const { state, esc } = ctx;
  const plan = state.plan;
  const total = planWeeks(plan);
  const pos = planPosition(plan, state.today);
  const end = addDays(mondayOf(plan.start), total * 7 - 1);
  let acc = 0;
  const strip = plan.phases.map((p, i) => {
    const cells = Array.from({ length: p.weeks }, (_, w) => `<div class="p${i % 6} ${acc + w === pos.week ? 'now' : ''}" title="${esc(p.name)} week ${w + 1}"></div>`).join('');
    acc += p.weeks;
    return cells;
  }).join('');
  const pace = fmtClock(plan.pace || 100);
  return `<section class="card" id="se-basics">
    <h2>Season plan</h2>
    <p class="lead">Phases run back to back from the start; each says what every AM and PM session is for. Today and the coach work from here.</p>
    <div class="row">
      <label class="field">Season name<input type="text" data-f="name" value="${esc(plan.name)}"></label>
      <label class="field">Starts (week of)<input type="date" data-f="start" value="${esc(plan.start)}"></label>
    </div>
    <div class="grid3">
      <label class="field">Unit<select data-f="unit"><option value="y" ${plan.unit === 'y' ? 'selected' : ''}>yards</option><option value="m" ${plan.unit === 'm' ? 'selected' : ''}>metres</option></select></label>
      <label class="field">Course<select data-f="course">${COURSES.map((c) => `<option ${plan.course === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field">Planning pace /100<input type="text" data-f="pace" value="${esc(pace)}" inputmode="decimal" placeholder="1:40" autocomplete="off"></label>
    </div>
    <div class="row">
      <label class="field">Hard-week ${plan.unit === 'm' ? 'metres' : 'yards'}<input type="number" data-f="weeklyYards" min="0" max="300000" step="500" inputmode="numeric" value="${plan.weeklyYards || ''}" placeholder="none"></label>
      <p class="muted small w-yards-hint">A hard week's total at volume 100%. Each phase's volume % scales it into the Week tab's target. Blank = no yardage target.</p>
    </div>
    <label class="field inline"><input type="checkbox" data-f="preMeet" ${plan.preMeet !== false ? 'checked' : ''}> Sharpen the day before a meet (one short speed session)</label>
    <div class="strip" aria-hidden="true">${strip}</div>
    <div class="legend">${plan.phases.map((p, i) => `<span><i class="p${i % 6}"></i>${esc(p.name)} · ${p.weeks} wk</span>`).join('')}</div>
    <p class="muted small c-gap">${total} weeks, ${esc(longDate(mondayOf(plan.start)))} → ${esc(longDate(end))}. ${esc(positionText(pos))}.</p>
    <p class="muted small">Planning pace (with rest) estimates distance for blocks measured in minutes and the reverse.</p>
  </section>`;
}

function bindBasics(ctx, el) {
  const { $, $$, state } = ctx;
  const plan = state.plan;
  const card = $('#se-basics', el);
  $$('[data-f]', card).forEach((input) => {
    input.onchange = async () => {
      const k = input.dataset.f;
      const v = input.value;
      if (k === 'name') plan.name = v.trim() || 'Season';
      else if (k === 'start') { if (!v) return; plan.start = mondayOf(v); }
      else if (k === 'unit') plan.unit = v === 'm' ? 'm' : 'y';
      else if (k === 'course') plan.course = v;
      else if (k === 'preMeet') plan.preMeet = input.checked;
      else if (k === 'weeklyYards') {
        const n = Math.round(+v);
        if (v.trim() === '' || n === 0) plan.weeklyYards = null;
        else if (n > 0 && n <= 300000) plan.weeklyYards = n;
        else { ctx.toast('Yards for a hard week, e.g. 40000'); input.value = plan.weeklyYards || ''; return; }
      }
      else if (k === 'pace') {
        const s = parseClock(v);
        if (!(s >= 30 && s <= 300)) { ctx.toast('Pace looks like 1:40'); input.value = fmtClock(plan.pace || 100); return; }
        plan.pace = s;
      }
      await commit(ctx, el);
    };
  });
}

// ------------------------------------------------------------------- week

function weekHTML(ctx) {
  const { state, esc } = ctx;
  const week = state.plan.week;
  const am = week.filter((d) => d.am > 0);
  const pm = week.filter((d) => d.pm > 0);
  const mins = week.reduce((s, d) => s + d.am + d.pm, 0);
  const cell = (i, slot) => `<input type="number" min="0" max="300" step="5" inputmode="numeric" data-f="w-${slot}-${i}" value="${week[i][slot] || 0}" aria-label="${WEEKDAYS[i]} ${slot.toUpperCase()} minutes" class="${week[i][slot] ? '' : 'off'}">`;
  return `<section class="card" id="se-week">
    <h2>Week schedule</h2>
    <p class="muted small">Minutes in the water each session; 0 = no session. Phase volume scales these.</p>
    <div class="c-week" role="group" aria-label="Minutes per session">
      <span></span>${WEEKDAYS.map((d) => `<b>${d}</b>`).join('')}
      <span>AM</span>${WEEKDAYS.map((_, i) => cell(i, 'am')).join('')}
      <span>PM</span>${WEEKDAYS.map((_, i) => cell(i, 'pm')).join('')}
    </div>
    <p class="small c-gap"><b>${am.length}</b> AM + <b>${pm.length}</b> PM session${am.length + pm.length === 1 ? '' : 's'} · <b>${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}</b> a week at full volume</p>
    <details class="c-details">
      <summary>Session themes</summary>
      <p class="muted small">Optional words for a session ("Test sets", "Speciality workouts"); they show on Today and the coach reads them.</p>
      <div class="c-themes">${WEEKDAYS.map((d, i) => `
        <div class="c-theme"><b>${d}</b>
          <input type="text" data-f="t-amTheme-${i}" value="${esc(week[i].amTheme)}" placeholder="AM theme" aria-label="${d} AM theme" ${week[i].am ? '' : 'disabled'}>
          <input type="text" data-f="t-pmTheme-${i}" value="${esc(week[i].pmTheme)}" placeholder="PM theme" aria-label="${d} PM theme" ${week[i].pm ? '' : 'disabled'}>
        </div>`).join('')}</div>
    </details>
  </section>`;
}

function bindWeek(ctx, el) {
  const { $, $$, state } = ctx;
  const card = $('#se-week', el);
  $$('[data-f]', card).forEach((input) => {
    input.onchange = async () => {
      const [kind, key, i] = input.dataset.f.split('-');
      const week = state.plan.week.map((d) => ({ ...d }));
      if (kind === 'w') week[+i][key] = Math.min(300, Math.max(0, Math.round(+input.value) || 0));
      else week[+i][key] = input.value.trim();
      state.plan.week = makeWeek(week);
      await commit(ctx, el);
    };
  });
  // Keep the details open across re-renders.
  const det = $('.c-details', card);
  det.open = !!state.ui.season.themesOpen;
  det.ontoggle = () => { state.ui.season.themesOpen = det.open; };
}

// ----------------------------------------------------------------- phases

function focusSelect(ctx, f, current, { pm = false, off = false } = {}) {
  const opts = Object.keys(FOCUSES).filter((k) => !(pm && k === 'rest'));
  return `<select data-f="${f}" class="${off ? 'off' : ''}">${pm ? `<option value="" ${current ? '' : 'selected'}>—</option>` : ''}${opts.map((k) => `<option value="${k}" ${current === k ? 'selected' : ''}>${SHORT[k] || ctx.esc(focusLabel(k))}</option>`).join('')}</select>`;
}

function phasesHTML(ctx) {
  const { state, esc } = ctx;
  const { plan } = state;
  const week = plan.week;
  const pos = planPosition(plan, state.today);
  return `<div id="se-phases">
    ${plan.phases.map((p, i) => `
    <section class="card phase" data-phase="${i}">
      <div class="phase-head"><span class="swatch p${i % 6}"></span><h3 class="c-h3">${esc(p.name)}${pos.status === 'in' && pos.phaseIndex === i ? ' <span class="badge cat">now</span>' : ''}</h3><span class="spacer"></span>
        <button type="button" class="icon-btn" data-pmove="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(p.name)} earlier">↑</button>
        <button type="button" class="icon-btn" data-pmove="${i}:1" ${i === plan.phases.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(p.name)} later">↓</button>
        <button type="button" class="icon-btn danger" data-prm="${i}" aria-label="Remove ${esc(p.name)}">✕</button></div>
      <div class="grid3">
        <label class="field">Name<input type="text" data-f="p-name-${i}" value="${esc(p.name)}"></label>
        <label class="field">Weeks<input type="number" data-f="p-weeks-${i}" min="1" max="30" inputmode="numeric" value="${p.weeks}"></label>
        <label class="field">Volume %<input type="number" data-f="p-volume-${i}" min="20" max="200" step="5" inputmode="numeric" value="${Math.round(p.volume * 100)}"></label>
      </div>
      <div class="c-row-label">AM focus</div>
      <div class="days">${WEEKDAYS.map((d, k) => `<div><label for="pf-am-${i}-${k}">${d}</label>${focusSelect(ctx, `p-am-${i}-${k}`, p.am[k], { off: !week[k].am }).replace('<select ', `<select id="pf-am-${i}-${k}" `)}</div>`).join('')}</div>
      <div class="c-row-label">PM focus (doubles)</div>
      <div class="days">${WEEKDAYS.map((d, k) => `<div><label for="pf-pm-${i}-${k}">${d}</label>${focusSelect(ctx, `p-pm-${i}-${k}`, p.pm[k], { pm: true, off: !week[k].pm }).replace('<select ', `<select id="pf-pm-${i}-${k}" `)}</div>`).join('')}</div>
      ${phaseWarn(p, week)}
      ${targetsHTML(ctx, p, i)}
    </section>`).join('')}
    <section class="card">
      <div class="row">
        <label class="field">Add a phase<select id="se-addphase"><option value="">Choose…</option>${Object.entries(PHASE_PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)} (${p.weeks} weeks)</option>`).join('')}<option value="blank">Blank phase</option></select></label>
      </div>
      <div class="actions"><button type="button" class="btn secondary danger" id="se-reset">Reset to the default plan</button></div>
    </section>
  </div>`;
}

// Gear targets: share of the week's yards per gear band, and kick on top.
// Blank boxes use the default (shown as the placeholder).
const TARGET_KEYS = [...BANDS.map((b) => [b.key, b.label]), ['kick', 'Kick']];

function targetsHTML(ctx, p, i) {
  const { esc } = ctx;
  const own = p.targets || {};
  const t = phaseTargets(p);
  const sum = Math.round(BANDS.reduce((a, b) => a + (t[b.key] || 0), 0) * 100);
  const cell = ([k, label]) => `<label class="w-tgt ${k === 'kick' ? 'kick' : ''}"><span title="${esc(label)}">${esc(label)}</span>
    <span class="w-pct"><input type="number" min="0" max="100" step="1" inputmode="numeric" data-f="p-tgt-${i}-${k}" value="${own[k] != null ? Math.round(own[k] * 100) : ''}" placeholder="${Math.round(DEFAULT_TARGETS[k] * 100)}" aria-label="${esc(`${p.name} ${label} target, percent of the week's yards`)}"><span aria-hidden="true">%</span></span></label>`;
  return `<div class="c-row-label">Gear targets <span class="muted">(share of the week's yards)</span></div>
    <div class="w-targets">${TARGET_KEYS.map(cell).join('')}</div>
    ${Math.abs(sum - 100) > 2
    ? `<p class="small w-warn">The four gear bands add up to <b>${sum}%</b>; make them about 100%. Blank boxes use the default shown.</p>`
    : `<p class="muted small w-tsum">Bands add up to ${sum}%. Kick is a share of all yards, on top. Blank boxes use the default shown.</p>`}`;
}

// Mismatches between a phase's focus rows and the week schedule.
function phaseWarn(p, week) {
  const noPm = WEEKDAYS.filter((_, k) => p.pm[k] && !week[k].pm);
  const noAm = WEEKDAYS.filter((_, k) => p.am[k] !== 'rest' && !week[k].am);
  const noFocus = WEEKDAYS.filter((_, k) => !p.pm[k] && week[k].pm);
  const out = [];
  if (noPm.length) out.push(`PM focus on ${noPm.join(', ')} but no PM minutes in the week schedule.`);
  if (noFocus.length) out.push(`PM minutes on ${noFocus.join(', ')} but no PM focus here, so no double those days.`);
  if (noAm.length && noAm.length < 7) out.push(`No AM minutes on ${noAm.join(', ')}: those focuses are skipped.`);
  return out.length ? `<p class="muted small c-gap">${out.join(' ')}</p>` : '';
}

function bindPhases(ctx, el) {
  const { $, $$, state } = ctx;
  const card = $('#se-phases', el);
  $$('[data-f]', card).forEach((input) => {
    input.onchange = async () => {
      const [, key, i, k] = input.dataset.f.split('-');
      const p = state.plan.phases[+i];
      if (key === 'name') p.name = input.value.trim() || 'Phase';
      else if (key === 'weeks') p.weeks = Math.min(52, Math.max(1, Math.round(+input.value) || 1));
      else if (key === 'volume') p.volume = Math.min(2, Math.max(0.2, (+input.value || 100) / 100));
      else if (key === 'am') p.am[+k] = input.value;
      else if (key === 'pm') p.pm[+k] = input.value || null;
      else if (key === 'tgt') {
        // Stored as fractions (0–1) the way makePhase keeps them.
        const v = input.value.trim();
        const n = +v;
        const targets = { ...(p.targets || {}) };
        if (v === '') delete targets[k];
        else if (Number.isFinite(n) && n >= 0 && n <= 100) targets[k] = Math.round(n) / 100;
        else { ctx.toast('A target is a percentage, 0 to 100'); input.value = p.targets?.[k] != null ? Math.round(p.targets[k] * 100) : ''; return; }
        if (Object.keys(targets).length) p.targets = targets; else delete p.targets;
      }
      await commit(ctx, el);
    };
  });
  $$('[data-pmove]', card).forEach((b) => {
    b.onclick = async () => {
      const [i, d] = b.dataset.pmove.split(':').map(Number);
      const ph = state.plan.phases;
      [ph[i], ph[i + d]] = [ph[i + d], ph[i]];
      await ctx.save.plan();
      ctx.rerender();
    };
  });
  $$('[data-prm]', card).forEach((b) => {
    b.onclick = async () => {
      const i = +b.dataset.prm;
      if (!(await ctx.confirmAction(`Remove the ${state.plan.phases[i].name} phase (${state.plan.phases[i].weeks} weeks)?`, 'Remove'))) return;
      state.plan.phases.splice(i, 1);
      await ctx.save.plan();
      ctx.rerender();
    };
  });
  $('#se-addphase', el).onchange = async (e) => {
    const k = e.target.value;
    if (!k) return;
    state.plan.phases.push(makePhase(k === 'blank'
      ? { name: 'New phase', weeks: 4, volume: 1, am: ['aerobic', 'technique', 'aerobic', 'threshold', 'technique', 'aerobic', 'rest'], pm: [null, 'aerobic', null, 'aerobic', null, null, null] }
      : PHASE_PRESETS[k]));
    if (await ctx.save.plan()) ctx.toast(`Added ${state.plan.phases.at(-1).name}`);
    ctx.rerender();
  };
  $('#se-reset', el).onclick = async () => {
    if (!(await ctx.confirmAction('Replace the phases and week schedule with the default plan starting this week? Meets, groups and the gear chart stay.', 'Reset'))) return;
    const fresh = defaultPlan(state.today);
    Object.assign(state.plan, { start: fresh.start, week: fresh.week, phases: fresh.phases });
    if (await ctx.save.plan()) ctx.toast('Plan reset');
    ctx.rerender();
  };
}

// ------------------------------------------------------------------ meets

function meetsHTML(ctx, ui) {
  const { state, esc } = ctx;
  const meets = [...(state.plan.meets || [])].sort((a, b) => (a.start < b.start ? -1 : 1));
  const upcoming = meets.filter((m) => m.end >= state.today);
  const past = meets.filter((m) => m.end < state.today).reverse();
  const when = (m) => {
    const d = Math.round((new Date(`${m.start}T12:00`) - new Date(`${state.today}T12:00`)) / 86400000);
    const range = m.end !== m.start ? `${longDate(m.start)} → ${longDate(m.end)}` : longDate(m.start);
    const rel = m.start <= state.today && state.today <= m.end ? 'on now' : d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : '';
    return { range, rel };
  };
  const row = (m) => {
    if (ui.meet?.id === m.id) return meetForm(ctx, ui.meet);
    const w = when(m);
    return `<div class="brow">
      <div class="info"><div class="name">${esc(m.name)}${w.rel ? ` <span class="badge cat">${esc(w.rel)}</span>` : ''}</div>
        <div class="meta">${esc([w.range, m.course, m.note].filter(Boolean).join(' · '))}</div></div>
      <div class="ctl">
        <button type="button" class="icon-btn" data-medit="${esc(m.id)}">Edit</button>
        <button type="button" class="icon-btn danger" data-mrm="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">✕</button>
      </div>
    </div>`;
  };
  return `<section class="card" id="se-meets">
    <div class="c-head"><h2>Meets</h2>${ui.meet && !ui.meet.id ? '' : '<button type="button" class="btn secondary small-btn" id="se-addmeet">Add a meet</button>'}</div>
    <p class="muted small">No practice on meet days${state.plan.preMeet !== false ? '; the day before is a short sharpen session' : ''}.</p>
    ${ui.meet && !ui.meet.id ? meetForm(ctx, ui.meet) : ''}
    <div class="rows">${upcoming.length ? upcoming.map(row).join('') : '<p class="muted">No meets coming up.</p>'}</div>
    ${past.length ? `<details class="c-details" ${ui.pastOpen ? 'open' : ''} id="se-past"><summary>${past.length} past meet${past.length === 1 ? '' : 's'}</summary><div class="rows">${past.map(row).join('')}</div></details>` : ''}
  </section>`;
}

function meetForm(ctx, m) {
  const { esc } = ctx;
  return `<div class="c-form" id="se-meetform">
    <label class="field">Meet name<input type="text" data-m="name" value="${esc(m.name)}" placeholder="e.g. Fall Invite" autocomplete="off"></label>
    <div class="row">
      <label class="field">First day<input type="date" data-m="start" value="${esc(m.start)}"></label>
      <label class="field">Last day<input type="date" data-m="end" value="${esc(m.end)}"></label>
    </div>
    <div class="row">
      <label class="field">Course<select data-m="course"><option value="">—</option>${COURSES.map((c) => `<option ${m.course === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field">Note<input type="text" data-m="note" value="${esc(m.note)}" placeholder="e.g. taper meet, prelims/finals"></label>
    </div>
    <p class="form-error" id="se-meeterr" hidden></p>
    <div class="actions">
      <button type="button" class="btn" id="se-meetsave">${m.id ? 'Save meet' : 'Add meet'}</button>
      <button type="button" class="btn secondary" id="se-meetcancel">Cancel</button>
    </div>
  </div>`;
}

function bindMeets(ctx, el, ui) {
  const { $, $$, state } = ctx;
  const card = $('#se-meets', el);
  $('#se-addmeet', card)?.addEventListener('click', () => {
    ui.meet = { id: null, name: '', start: addDays(state.today, 14), end: addDays(state.today, 14), course: state.plan.course || '', note: '' };
    ctx.rerender();
    $('#se-meetform [data-m="name"]', el)?.focus();
  });
  const past = $('#se-past', card);
  if (past) past.ontoggle = () => { ui.pastOpen = past.open; };
  $$('[data-medit]', card).forEach((b) => {
    b.onclick = () => { ui.meet = { ...state.plan.meets.find((m) => m.id === b.dataset.medit) }; ctx.rerender(); };
  });
  $$('[data-mrm]', card).forEach((b) => {
    b.onclick = async () => {
      const m = state.plan.meets.find((x) => x.id === b.dataset.mrm);
      if (!m || !(await ctx.confirmAction(`Remove ${m.name}?`, 'Remove'))) return;
      state.plan.meets = state.plan.meets.filter((x) => x.id !== m.id);
      if (ui.meet?.id === m.id) ui.meet = null;
      await ctx.save.plan();
      ctx.rerender();
    };
  });
  const form = $('#se-meetform', card);
  if (!form) return;
  $$('[data-m]', form).forEach((input) => {
    input.oninput = () => {
      const prevStart = ui.meet.start;
      ui.meet[input.dataset.m] = input.value;
      // A one-day meet moves with its first day; the last day never falls before it.
      if (input.dataset.m === 'start' && input.value) {
        const end = $('[data-m="end"]', form);
        if (!ui.meet.end || ui.meet.end === prevStart || ui.meet.end < input.value) { ui.meet.end = input.value; end.value = input.value; }
      }
    };
  });
  $('#se-meetcancel', form).onclick = () => { ui.meet = null; ctx.rerender(); };
  $('#se-meetsave', form).onclick = async () => {
    const m = ui.meet;
    const err = $('#se-meeterr', form);
    if (!m.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(m.start)) { err.textContent = 'Give the meet a name and a first day.'; err.hidden = false; return; }
    if (m.end && m.end < m.start) { err.textContent = 'The last day is before the first.'; err.hidden = false; return; }
    const meet = makeMeet({ ...m, id: m.id || undefined });
    state.plan.meets = [...state.plan.meets.filter((x) => x.id !== meet.id), meet].sort((a, b) => (a.start < b.start ? -1 : 1));
    // Not saved: the app says so and offers Try again; the form stays open,
    // and saving it again replaces this meet.
    if (await ctx.save.plan()) {
      ui.meet = null;
      ctx.toast(`${meet.name} saved`);
    } else {
      m.id = meet.id;
    }
    ctx.rerender();
  };
}

// ----------------------------------------------------------------- groups

// How a group is defined: 'g3' (pace per 100) or 'test' (a 1650 time).
const groupKind = (g) => (g.test?.seconds ? 'test' : 'g3');
// A plan group's computed paces (writingContext ids groups without one by index).
const written = (ctx, g, i) => ctx.learned.writing.groups.find((x) => !x.assumed && x.id === (g.id || `g${i}`)) || null;

function groupsHTML(ctx) {
  const { state, esc, chips } = ctx;
  const { plan } = state;
  const wctx = ctx.learned.writing;
  const model = wctx.model;
  const groups = plan.groups || [];
  return `<section class="card" id="se-groups">
    <div class="c-head"><h2>Groups</h2><button type="button" class="btn secondary small-btn" id="se-addgroup">Add a group</button></div>
    <p class="muted small">Interval columns, fastest first. Each group is defined by its G3 pace per 100 or a ${model.baseDistance} time; the gear chart below gives every other gear.</p>
    ${groups.length ? '' : `<p class="banner">No groups yet: send-offs use one column from the planning pace (${esc(fmtClock(plan.pace || 100))} /100). Add your groups to get a column each.</p>`}
    ${groups.map((g, i) => {
      const w = written(ctx, g, i);
      const kind = groupKind(g);
      const pred = w?.test ? racePredictions(model, w.test) : null;
      return `<div class="c-group" data-group="${i}">
        <div class="phase-head"><b class="c-gnum">${i + 1}</b><h3 class="c-h3">${esc(g.name || `Group ${i + 1}`)}</h3><span class="spacer"></span>
          <button type="button" class="icon-btn" data-gmove="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} up">↑</button>
          <button type="button" class="icon-btn" data-gmove="${i}:1" ${i === groups.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} down">↓</button>
          <button type="button" class="icon-btn danger" data-grm="${i}" aria-label="Remove ${esc(g.name)}">✕</button></div>
        <div class="row">
          <label class="field">Name<input type="text" data-f="g-name-${i}" value="${esc(g.name || '')}"></label>
          <label class="field">Column key<input type="text" data-f="g-key-${i}" value="${esc(g.key || '')}" placeholder="${esc(w ? fmtClock(Math.round(w.paces.G3)) : '1:05')}" autocomplete="off"></label>
        </div>
        <div class="field">Defined by${chips(`g-kind-${i}`, [['g3', 'G3 pace /100'], ['test', `${model.baseDistance} time`]], kind, { allowNone: false })}</div>
        <div class="row">
          ${kind === 'g3'
            ? `<label class="field">G3 pace /100<input type="text" data-f="g-g3-${i}" value="${esc(g.g3 ? fmtClock(g.g3) : '')}" placeholder="1:03" inputmode="decimal" autocomplete="off"></label>`
            : `<label class="field">${model.baseDistance} time<input type="text" data-f="g-test-${i}" value="${esc(g.test?.seconds ? fmtClock(g.test.seconds) : '')}" placeholder="18:30" inputmode="decimal" autocomplete="off"></label>`}
          <label class="field">400 IM <span class="muted small">(optional)</span><input type="text" data-f="g-im400-${i}" value="${esc(g.im400 ? fmtClock(g.im400) : '')}" placeholder="4:45" inputmode="decimal" autocomplete="off"></label>
        </div>
        ${w ? `<div class="table-wrap"><table class="gtable c-paces">
          <thead><tr><th>/100</th>${TABLE_GEARS.map((x) => `<th>${x}</th>`).join('')}</tr></thead>
          <tbody>
            <tr><td>Free</td>${TABLE_GEARS.map((x) => `<td>${esc(fmtClock(paceOf(w.paces, x)))}</td>`).join('')}</tr>
            ${w.imPaces ? `<tr><td>IM</td>${TABLE_GEARS.map((x) => `<td>${esc(fmtClock(paceOf(w.imPaces, x)))}</td>`).join('')}</tr>` : ''}
          </tbody></table></div>
          ${pred ? `<p class="small c-pred"><span class="muted">Predicted</span> 1000 <b>${esc(fmtClock(pred[1000]))}</b> · 500 <b>${esc(fmtClock(pred[500]))}</b> · 200 <b>${esc(fmtClock(pred[200]))}</b>${kind === 'g3' ? ` · ${model.baseDistance} <b>${esc(fmtClock(pred[1650] ?? w.test.seconds))}</b>` : ''}</p>` : ''}`
          : '<p class="muted small">Enter a pace or time to see this group\'s gears.</p>'}
      </div>`;
    }).join('')}
  </section>`;
}

function bindGroups(ctx, el) {
  const { $, $$, state } = ctx;
  const card = $('#se-groups', el);
  const plan = state.plan;
  const groups = () => (plan.groups ||= []);
  $$('[data-f]', card).forEach((input) => {
    input.onchange = async () => {
      const [, key, i] = input.dataset.f.split('-');
      const g = groups()[+i];
      const v = input.value.trim();
      if (key === 'name') g.name = v || `Group ${+i + 1}`;
      else if (key === 'key') g.key = v;
      else {
        const s = v ? parseClock(v) : null;
        if (v && !(s > 0)) { ctx.toast('Times look like 1:03 or 18:30'); input.value = ''; return; }
        if (key === 'g3') { if (s && (s < 40 || s > 240)) { ctx.toast('G3 pace per 100 looks like 1:03'); return; } g.g3 = s; delete g.test; }
        else if (key === 'test') {
          if (s && s < 300) { ctx.toast(`That is fast for a ${makeGearModel(plan.gears || {}).baseDistance}`); return; }
          g.test = s ? { distance: makeGearModel(plan.gears || {}).baseDistance, seconds: s } : null; delete g.g3;
        } else if (key === 'im400') g.im400 = s;
      }
      await commit(ctx, el);
    };
  });
  ctx.bindChips(card, async (name, value) => {
    const i = +name.split('-')[2];
    const g = groups()[i];
    if (!g || !value || value === groupKind(g)) return;
    // Keep the group's speed when switching how it is defined.
    const w = written(ctx, g, i);
    if (value === 'test') { g.test = w?.test ? { distance: w.test.distance, seconds: Math.round(w.test.seconds) } : null; delete g.g3; }
    else { g.g3 = w ? Math.round(w.paces.G3) : null; delete g.test; }
    await ctx.save.plan();
    ctx.rerender();
  });
  $('#se-addgroup', card).onclick = async () => {
    const list = groups();
    const last = list.at(-1);
    const lastW = last && written(ctx, last, list.length - 1);
    const g3 = lastW ? Math.round(lastW.paces.G3) + 3 : Math.max(50, (plan.pace || 100) - 12);
    list.push({ id: ctx.uid('g'), name: `Group ${list.length + 1}`, key: '', g3, im400: null });
    await ctx.save.plan();
    ctx.rerender();
    $(`[data-f="g-name-${list.length - 1}"]`, el)?.focus();
  };
  $$('[data-gmove]', card).forEach((b) => {
    b.onclick = async () => {
      const [i, d] = b.dataset.gmove.split(':').map(Number);
      const list = groups();
      [list[i], list[i + d]] = [list[i + d], list[i]];
      await ctx.save.plan();
      ctx.rerender();
    };
  });
  $$('[data-grm]', card).forEach((b) => {
    b.onclick = async () => {
      const i = +b.dataset.grm;
      const g = groups()[i];
      if (!(await ctx.confirmAction(`Remove ${g.name || 'this group'}? Its interval column goes from every written set.`, 'Remove'))) return;
      groups().splice(i, 1);
      await ctx.save.plan();
      ctx.rerender();
    };
  });
}

// ------------------------------------------------------------ gear chart

function gearsHTML(ctx) {
  const { state, esc } = ctx;
  const plan = state.plan;
  const m = makeGearModel(plan.gears || {});
  const d = DEFAULT_GEAR_MODEL;
  const custom = !!plan.gears && Object.keys(plan.gears).length > 0;
  const g1 = ctx.learned.writing.groups[0];
  const long5 = m.rounding.long > 1;
  const sample = g1 ? SAMPLE.map(([dist, gear]) => [dist, gear, SAMPLE_STROKES.map(([s]) => sendOff(m, g1.paces, { gear, distance: dist, stroke: s, strokePaces: s === 'IM' ? g1.imPaces : null }))]) : [];
  const numIn = (f, v, { step = 'any', min = '', max = '', ph = '' } = {}) => `<input type="number" data-f="${f}" value="${v ?? ''}" step="${step}" min="${min}" max="${max}" placeholder="${esc(ph)}" inputmode="decimal">`;
  return `<section class="card" id="se-gears">
    <div class="c-head"><h2>Gear chart</h2>${custom ? '<span class="badge cat">yours</span>' : '<span class="muted small">defaults</span>'}</div>
    <p class="muted small">How a group's pace becomes every gear and every send-off. Each gear is the pace a swimmer could hold for a set time (G3 one hour, G4 fifteen minutes, G5 five, G6 two); rest grows with the gear and the rep.</p>
    <div class="grid3">
      <label class="field">Fatigue factor F${numIn('x-fatigue', m.fatigue, { step: 0.005, min: 1.0, max: 1.15 })}</label>
      <label class="field">200 offset${numIn('x-offset200', Number.isFinite(m.offset200) ? m.offset200 : '', { step: 0.005, min: 0, max: 0.2, ph: `default ${d.offset200}` })}</label>
      <label class="field">IM fatigue${numIn('x-imFatigue', m.imFatigue, { step: 0.005, min: 1.0, max: 1.15 })}</label>
    </div>
    <p class="small c-hint">F ${esc(String(m.fatigue))} fits a <b>${esc(swimmerType(m.fatigue))}</b> group. Roughly: under 1.05 for distance swimmers, 1.05–1.08 middle distance / IM, over 1.08 for sprinters.</p>

    <h3 class="c-sub">Rest</h3>
    <label class="field">Rest exponent <span class="muted small">(0 = fixed share of the swim, 1 = grows with rep length)</span>${numIn('x-restExponent', m.restExponent, { step: 0.05, min: 0, max: 1.5 })}</label>
    <div class="c-gearrest">${m.gears.map((g) => `
      <label class="c-gr"><span><b>${esc(g.name)}</b> <span class="muted">${esc(g.label)}</span></span>
        <input type="number" data-f="r-${esc(g.name)}" value="${g.rest ?? ''}" step="0.01" min="0" max="5" inputmode="decimal" aria-label="${esc(g.name)} rest ratio"></label>`).join('')}</div>
    <p class="muted small">Rest ratio × swim time × (swim ÷ 60 s)^exponent. G2 ${d.gears.find((g) => g.name === 'G2').rest}, G3 ${d.gears.find((g) => g.name === 'G3').rest}, G5 ${d.gears.find((g) => g.name === 'G5').rest} by default.</p>

    <h3 class="c-sub">Strokes and kinds <span class="muted small">(s per 100 added to free)</span></h3>
    <div class="c-offsets">
      ${STROKE_KEYS.map(([k, l]) => `<label class="field">${l}${numIn(`s-${k}`, m.strokes[k], { step: 1, min: -10, max: 40 })}</label>`).join('')}
      ${KIND_KEYS.map(([k, l]) => `<label class="field">${l}${numIn(`k-${k}`, m.kinds[k], { step: 1, min: -10, max: 60 })}</label>`).join('')}
    </div>

    <h3 class="c-sub">Rounding</h3>
    <div class="row c-rounding">
      <label class="field">Short reps to (s)${numIn('x-short', m.rounding.short, { step: 1, min: 1, max: 10 })}</label>
      <label class="field inline c-check"><input type="checkbox" data-f="x-long5" ${long5 ? 'checked' : ''}> ${m.rounding.longFrom || 150}s and up on the :05</label>
    </div>

    <details class="c-details" id="se-cns" ${state.ui.season.cnsOpen ? 'open' : ''}>
      <summary>CNS rates (advanced)</summary>
      <p class="muted small">Points per ${esc(plan.unit === 'm' ? 'metre' : 'yard')} in each gear; what is left halves every half-life. Today warns when more than 5 points are left before a high-CNS session.</p>
      <div class="c-offsets">
        ${m.gears.map((g) => `<label class="field">${esc(g.name)}${numIn(`c-${g.name}`, m.cns[g.name] ?? 0, { step: 0.001, min: 0, max: 5 })}</label>`).join('')}
        <label class="field">Half-life (h)${numIn('x-cnsHalfLifeHours', m.cnsHalfLifeHours, { step: 1, min: 1, max: 96 })}</label>
      </div>
    </details>

    ${g1 ? `<h3 class="c-sub">Send-offs for ${esc(g1.name)}</h3>
    <div class="table-wrap"><table class="gtable c-sample">
      <thead><tr><th>Rep</th>${SAMPLE_STROKES.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${sample.map(([dist, gear, vals]) => `<tr><td>${dist} ${gear}</td>${vals.map((v) => `<td>${esc(v == null ? '–' : fmtClock(v))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">From the chart alone; send-offs in written sets also follow the ratios learned from your blocks${Object.keys(ctx.learned.calibration || {}).length ? ' and your debriefs' : ''}.</p>` : ''}
    <div class="actions"><button type="button" class="btn secondary danger" id="se-gearreset" ${custom ? '' : 'disabled'}>Reset the gear chart to defaults</button></div>
  </section>`;
}

function bindGears(ctx, el) {
  const { $, $$, state } = ctx;
  const card = $('#se-gears', el);
  const plan = state.plan;
  $$('[data-f]', card).forEach((input) => {
    input.onchange = async () => {
      const [kind, ...rest] = input.dataset.f.split('-');
      const key = rest.join('-');
      const gm = (plan.gears = { ...(plan.gears || {}) });
      const v = num(input.value);
      if (kind === 'x') {
        if (key === 'long5') gm.rounding = { ...makeGearModel(gm).rounding, long: input.checked ? 5 : 1, longFrom: makeGearModel(gm).rounding.longFrom || 150 };
        else if (key === 'short') gm.rounding = { ...makeGearModel(gm).rounding, short: Math.max(1, Math.round(v || 1)) };
        else if (key === 'offset200') gm.offset200 = v;
        else if (key === 'fatigue' || key === 'imFatigue') { if (v == null || v < 1 || v > 1.2) { ctx.toast('F is usually between 1.02 and 1.12'); ctx.rerender(); return; } gm[key] = v; }
        else if (v != null && v >= 0) gm[key] = v;
      } else if (kind === 'r') {
        if (v == null || v < 0) return;
        const others = (gm.gears || []).filter((g) => g.name !== key);
        const prev = (gm.gears || []).find((g) => g.name === key) || {};
        gm.gears = [...others, { ...prev, name: key, rest: v }];
      } else if (kind === 's' && v != null) gm.strokes = { ...(gm.strokes || {}), [key]: v };
      else if (kind === 'k' && v != null) gm.kinds = { ...(gm.kinds || {}), [key]: v };
      else if (kind === 'c' && v != null && v >= 0) gm.cns = { ...(gm.cns || {}), [key]: v };
      await commit(ctx, el);
    };
  });
  const cns = $('#se-cns', card);
  cns.ontoggle = () => { state.ui.season.cnsOpen = cns.open; };
  $('#se-gearreset', card).onclick = async () => {
    if (!(await ctx.confirmAction('Reset the gear chart (fatigue factor, rest, stroke offsets, rounding, CNS) to the defaults?', 'Reset'))) return;
    plan.gears = null;
    if (await ctx.save.plan()) ctx.toast('Gear chart reset');
    ctx.rerender();
  };
}

// ------------------------------------------------------- learned (debriefs)

function learnedHTML(ctx) {
  const { esc, state } = ctx;
  const cal = ctx.learned.calibration || {};
  const rows = Object.entries(cal).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([gear, byStroke]) => Object.entries(byStroke).map(([stroke, v]) => ({ gear, stroke, v })));
  const strokeName = (s) => (s === 'all' ? 'all strokes' : { free: 'free', back: 'BK', breast: 'BR', fly: 'FL', IM: 'IM' }[s] || s);
  return `<section class="card" id="se-learned">
    <h2>Learned from debriefs</h2>
    ${rows.length ? `<p class="muted small">Send-offs move by these seconds per 100 when the group says intervals were too hard or too easy. Recent debriefs count most; three weeks old counts half.</p>
    <ul class="c-cal">${rows.map((r) => `<li><b>${esc(r.gear)} ${esc(strokeName(r.stroke))}</b><span class="${r.v > 0 ? 'c-up' : 'c-down'}">${r.v > 0 ? '+' : '−'}${Math.abs(r.v)}s/100</span><span class="muted small">${r.v > 0 ? 'more rest' : 'tighter'}</span></li>`).join('')}</ul>`
      : `<p class="muted">Nothing yet. ${state.debriefs.length ? 'Debriefs so far say the send-offs are right.' : 'Debrief practices (intervals too easy / right / too hard, send-offs made) and the send-offs adjust here.'}</p>`}
  </section>`;
}
