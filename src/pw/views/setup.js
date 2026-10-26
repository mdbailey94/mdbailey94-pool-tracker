// Setup: building the season plan together, step by step — major meets,
// the training schedule, philosophy, key skills, equipment, then the
// phases drafted back from the taper meets (by the app or with Claude) and
// a description of each. It opens by itself until it is finished or
// skipped (plan.setup), and again from Season. A coach who already has a
// plan goes through the same steps with their answers filled in, so it
// works from halfway through a season: what has happened stays as it is.
// The gear chart, groups and formatting are kept as they are.

import {
  EQUIPMENT, MEET_PRIORITY, PHILOSOPHIES, SKILLS, WEEKDAYS, addDays, dayLabel, draftPhases, focusLabel, makeMeet, migratePlan,
  mondayOf, phaseSpans, phasesBefore, planPosition, positionText,
} from '../../practice.js';
import { parsePlanReply, planTurns } from '../../coach.js';

const STEPS = [
  ['start', 'Season'], ['meets', 'Meets'], ['schedule', 'Schedule'], ['philosophy', 'Philosophy'], ['skills', 'Key skills'],
  ['equipment', 'Equipment'], ['gears', 'Gears'], ['phases', 'Phases'], ['done', 'Review'],
];
const COURSES = ['SCY', 'SCM', 'LCM'];
const copy = (v) => JSON.parse(JSON.stringify(v));
const range = (a, b) => (a === b ? dayLabel(a) : `${dayLabel(a)} – ${dayLabel(b)}`);

// The working copy of the plan (saved at every step) and the step.
function uiOf(ctx) {
  const { state } = ctx;
  let u = state.ui.setup;
  if (!u || !u.plan) {
    const plan = copy(state.plan);
    // Started from nothing (the default plan): kept through the steps, since
    // the plan stops being the default once the first step is saved.
    if (state.planIsDefault && !plan.setup?.step) plan.setup = { ...(plan.setup || {}), fresh: true };
    const at = STEPS.findIndex(([k]) => k === plan.setup?.step);
    u = state.ui.setup = { step: at > 0 && !plan.setup?.done ? at : 0, plan, proposal: null, busy: false, meet: null, from: null };
  }
  return u;
}

// Where re-planning starts by default: a new plan from the season start (the
// default phases are only placeholders); else after the phase running now
// (the coach finishes what they are in), or this Monday.
function defaultFrom(plan, today, isDefault = false) {
  if (isDefault) return plan.start;
  const pos = planPosition(plan, today);
  if (pos.status === 'before') return plan.start;
  if (pos.status !== 'in') return mondayOf(today);
  const span = phaseSpans(plan)[pos.phaseIndex];
  return addDays(span.end, 1);
}

// Mondays re-planning can start from: this week and each phase start ahead.
function fromChoices(plan, today, isDefault) {
  const mondays = new Set([plan.start, mondayOf(today) < plan.start ? plan.start : mondayOf(today)]);
  for (const s of phaseSpans(plan)) if (s.start > today) mondays.add(s.start);
  const d = defaultFrom(plan, today, isDefault);
  mondays.add(d);
  return [...mondays].sort();
}

// ---------------------------------------------------------------- render

export function render(ctx, el) {
  const { esc } = ctx;
  const u = uiOf(ctx);
  const [key, title] = STEPS[u.step];
  const body = { start: startHTML, meets: meetsHTML, schedule: scheduleHTML, philosophy: philosophyHTML, skills: skillsHTML, equipment: equipmentHTML, gears: gearsHTML, phases: phasesHTML, done: doneHTML }[key](ctx, u);
  el.innerHTML = `<section class="card su">
    <div class="su-head">
      <div><div class="eyebrow">Plan the season together · ${u.step + 1} of ${STEPS.length}</div><h2>${esc(title)}</h2></div>
      <button type="button" class="btn secondary small-btn" id="su-skip">${ctx.state.plan.setup?.done ? 'Close' : 'Not now'}</button>
    </div>
    <ol class="su-steps" aria-label="Steps">${STEPS.map(([k, l], i) => `<li class="${i === u.step ? 'on' : i < u.step ? 'past' : ''}"><button type="button" data-step="${i}" ${i === u.step ? 'aria-current="step"' : ''}>${esc(l)}</button></li>`).join('')}</ol>
    ${body}
    <div class="actions su-nav">
      ${u.step ? '<button type="button" class="btn secondary" id="su-back">Back</button>' : ''}
      ${key === 'done' ? '<button type="button" class="btn" id="su-finish">Save the plan</button>' : '<button type="button" class="btn" id="su-next">Next</button>'}
    </div>
  </section>`;
  bind(ctx, el, u, key);
}

function startHTML(ctx, u) {
  const { state, esc } = ctx;
  const p = u.plan;
  const existing = !p.setup?.fresh;
  const pos = planPosition(p, state.today);
  const spans = phaseSpans(p);
  const intro = existing
    ? `<p class="lead">You already have a plan, so let's go through it together: I've filled in what I know. Change what's off and tell me what's missing (meet priorities, your philosophy, key skills, equipment, what each phase is for).</p>
      <ul class="su-known">
        <li><b>${esc(p.name || 'Season')}</b> from ${esc(dayLabel(p.start))}${spans.length ? ` to ${esc(dayLabel(spans.at(-1).end))}` : ''}: ${spans.length} phase${spans.length === 1 ? '' : 's'}, ${(p.meets || []).length} meet${(p.meets || []).length === 1 ? '' : 's'}</li>
        <li>${esc(positionText(pos, { detail: 'season' }))}</li>
        <li>Your gear chart${(p.groups || []).length ? `, ${p.groups.length} interval group${p.groups.length === 1 ? '' : 's'}` : ''} and your formatting stay as they are.</li>
      </ul>`
    : '<p class="lead">Let\'s build your season plan together: your major meets, the training week, how you like to train, the skills and equipment you want to use. I\'ll draft the phases back from your taper meets and we\'ll go over them. Starting mid-season is fine: put the date your season started and we\'ll plan from here.</p>';
  return `${intro}
    <label class="field">Season name<input type="text" data-p="name" value="${esc(p.name || '')}" placeholder="e.g. Senior group 2026–27" autocomplete="off"></label>
    <div class="row">
      <label class="field">Season started (or starts)<input type="date" data-p="start" value="${esc(p.start)}"></label>
      <label class="field">Course<select data-p="course">${COURSES.map((c) => `<option ${p.course === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>`;
}

function meetsHTML(ctx, u) {
  const { state, esc } = ctx;
  const meets = [...(u.plan.meets || [])].sort((a, b) => (a.start < b.start ? -1 : 1));
  const m = u.meet;
  return `<p class="lead">Your major meets, and how much each one matters. <b>A</b> meets get a taper and the phases are planned back from them; <b>B</b> meets a short rest; <b>C</b> meets are swum through training.</p>
    <div class="rows">${meets.length ? meets.map((x) => `<div class="brow su-meet ${x.end < state.today ? 'is-past' : ''}">
      <div class="info"><div class="name">${esc(x.name)}${x.end < state.today ? ' <span class="muted small">(past)</span>' : ''}</div><div class="meta">${esc([range(x.start, x.end), x.course].filter(Boolean).join(' · '))}</div></div>
      <div class="ctl">
        <div class="chips" role="group" aria-label="Priority of ${esc(x.name)}">${Object.entries(MEET_PRIORITY).map(([k, l]) => `<button type="button" class="chip ${x.priority === k ? 'on' : ''}" data-prio="${esc(x.id)}" data-value="${k}" aria-pressed="${x.priority === k}" title="${esc(l)}">${k}</button>`).join('')}</div>
        <button type="button" class="icon-btn danger" data-unmeet="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">✕</button>
      </div></div>`).join('') : '<p class="muted">No meets yet. Add your major meets below.</p>'}</div>
    ${m ? `<div class="c-form su-meetform">
      <label class="field">Meet<input type="text" data-m="name" value="${esc(m.name)}" placeholder="e.g. Winter Championships" autocomplete="off"></label>
      <div class="row">
        <label class="field">First day<input type="date" data-m="start" value="${esc(m.start)}"></label>
        <label class="field">Last day<input type="date" data-m="end" value="${esc(m.end)}"></label>
      </div>
      <div class="field">Priority<div class="chips">${Object.entries(MEET_PRIORITY).map(([k, l]) => `<button type="button" class="chip ${m.priority === k ? 'on' : ''}" data-mprio="${k}" aria-pressed="${m.priority === k}">${k} · ${esc(l)}</button>`).join('')}</div></div>
      <p class="form-error" id="su-meeterr" hidden></p>
      <div class="actions"><button type="button" class="btn" id="su-meetadd">Add meet</button><button type="button" class="btn secondary" id="su-meetcancel">Cancel</button></div>
    </div>` : '<div class="actions"><button type="button" class="btn secondary" id="su-meetnew">Add a meet</button></div>'}`;
}

function scheduleHTML(ctx, u) {
  const { esc } = ctx;
  const p = u.plan;
  const cell = (i, slot) => `<input type="number" min="0" max="300" step="5" inputmode="numeric" data-w="${slot}-${i}" value="${p.week[i][slot] || 0}" aria-label="${WEEKDAYS[i]} ${slot.toUpperCase()} minutes" class="${p.week[i][slot] ? '' : 'off'}">`;
  return `<p class="lead">Your training week: minutes in the water each session (0 = no session). Doubles are the PM row.</p>
    <div class="c-week" role="group" aria-label="Minutes per session">
      <span></span>${WEEKDAYS.map((d) => `<b>${d}</b>`).join('')}
      <span>AM</span>${WEEKDAYS.map((_, i) => cell(i, 'am')).join('')}
      <span>PM</span>${WEEKDAYS.map((_, i) => cell(i, 'pm')).join('')}
    </div>
    <label class="field">A hard week's ${p.unit === 'm' ? 'metres' : 'yards'} (optional)<input type="number" data-p="weeklyYards" min="0" max="300000" step="500" inputmode="numeric" value="${esc(p.weeklyYards || '')}" placeholder="e.g. 40000"></label>`;
}

// Several-at-once chips (philosophy, skills, equipment).
const multi = (ctx, name, table, on) => `<div class="chips" role="group" data-multi="${name}">${Object.entries(table).map(([k, l]) => `<button type="button" class="chip ${on.includes(k) ? 'on' : ''}" data-multi-key="${ctx.esc(k)}" aria-pressed="${on.includes(k)}">${ctx.esc(l)}</button>`).join('')}</div>`;

function philosophyHTML(ctx, u) {
  const p = u.plan;
  return `<p class="lead">How do you like to train? Pick what fits and say it in your own words: the coach chat and the plan drafts follow it.</p>
    ${multi(ctx, 'philosophy', PHILOSOPHIES, p.philosophy.keys)}
    <label class="field">In your words<textarea data-p="philosophy.text" rows="4" placeholder="e.g. Aerobic engine through the fall, gears every day, race pace grows into the winter; kick and underwaters are non-negotiable">${ctx.esc(p.philosophy.text)}</textarea></label>`;
}

function skillsHTML(ctx, u) {
  const p = u.plan;
  return `<p class="lead">The key skills you want in the water this season.</p>
    ${multi(ctx, 'skills', SKILLS, p.skills.keys)}
    <label class="field">Anything else<textarea data-p="skills.text" rows="3" placeholder="e.g. 5 underwater kicks off every wall; breakout to first stroke without a breath">${ctx.esc(p.skills.text)}</textarea></label>`;
}

function equipmentHTML(ctx, u) {
  const on = u.plan.equipment || [];
  const table = Object.fromEntries(EQUIPMENT.map((e) => [e, e]));
  return `<p class="lead">The equipment the team has and wants to use. Suggestions only use blocks that need what you have.</p>
    ${multi(ctx, 'equipment', table, on)}
    <p class="muted small">${u.plan.equipment ? `${on.length} picked.` : 'Nothing picked yet: all equipment counts as available.'}</p>`;
}

function gearsHTML(ctx, u) {
  const { esc, state } = ctx;
  const groups = ctx.learned.writing?.groups || [];
  const own = Array.isArray(u.plan.gears?.gears) && u.plan.gears.gears.length;
  const style = state.style?.learnedFrom?.blocks;
  return `<p class="lead">${own ? 'I keep using your gear chart and your formatting.' : 'Practices are written with a gear chart (G1–G6) and your formatting.'} Nothing to change here unless something is off.</p>
    <ul class="su-known">
      <li>${own ? '<b>Your gear chart</b> (rest, CNS and paces from your own numbers)' : '<b>A generic gear chart</b>: set your own under Season → Gear chart'}</li>
      <li>${groups.length && !groups[0].assumed ? `<b>${groups.length} interval group${groups.length === 1 ? '' : 's'}</b>: ${esc(groups.map((g) => g.name).join(' | '))}` : '<b>No groups yet</b>: add them under Season → Groups for send-offs per group'}</li>
      <li>${style ? `<b>Your style</b>, learned from ${style} block${style === 1 ? '' : 's'}` : 'No style learned yet: paste a few of your sets under Blocks'}</li>
    </ul>`;
}

function phaseRows(ctx, phases, start, { editable, today }) {
  const { esc } = ctx;
  const spans = phaseSpans({ start, phases });
  return spans.map((s) => {
    const past = s.end < today;
    const now = s.start <= today && today <= s.end;
    const p = s.phase;
    const am = p.am.map((f, i) => `${WEEKDAYS[i]} ${focusLabel(f)}`).join(' · ');
    return `<div class="su-phase ${past ? 'is-past' : ''} ${now ? 'is-now' : ''}">
      <div class="su-phase-head">
        ${editable ? `<input type="text" data-ph="name-${s.index}" value="${esc(p.name)}" aria-label="Phase name">` : `<b>${esc(p.name)}</b>`}
        <span class="muted small">${esc(range(s.start, s.end))}${now ? ' · <b>now</b>' : ''}</span>
        ${editable ? `<label class="su-weeks">weeks<input type="number" min="1" max="52" data-ph="weeks-${s.index}" value="${p.weeks}" inputmode="numeric"></label>` : `<span class="small">${p.weeks} wk</span>`}
      </div>
      <div class="muted small">${esc(am)}</div>
      ${editable ? `<textarea data-ph="description-${s.index}" rows="2" placeholder="${past ? 'What it was for (optional)' : 'What this phase is for, what to watch'}">${esc(p.description || '')}</textarea>`
        : p.description ? `<p class="small su-desc">${esc(p.description)}</p>` : ''}
    </div>`;
  }).join('');
}

function phasesHTML(ctx, u) {
  const { esc, state } = ctx;
  const p = u.plan;
  const today = state.today;
  const fresh = !!p.setup?.fresh;
  u.from ||= defaultFrom(p, today, fresh);
  const lastA = [...(p.meets || [])].filter((m) => m.priority === 'A').sort((a, b) => (a.start < b.start ? -1 : 1)).at(-1);
  const spans = phaseSpans(p);
  const end = spans.at(-1)?.end;
  const short = lastA && end && end < lastA.end;
  const placeholders = p.phases.filter((x) => /placeholder/i.test(x.name)).length;
  const prop = u.proposal;
  const claudeOn = !!ctx.claude.sample && !state.ui.claudeOff;
  return `<p class="lead">The phases of the season. ${fresh ? 'Draft them from your meets, then say what each one is for.' : 'Here is what you have: say what each phase is for, and re-draft what is still to come if it needs it.'}</p>
    ${short ? `<p class="banner"><span>The plan ends ${esc(dayLabel(end))}, before your A meet ${esc(lastA.name)} (${esc(dayLabel(lastA.start))}).</span></p>` : ''}
    ${placeholders ? `<p class="banner"><span>${placeholders} phase${placeholders === 1 ? ' is a placeholder' : 's are placeholders'}: re-draft from where they start.</span></p>` : ''}
    <div class="su-phases">${phaseRows(ctx, p.phases, p.start, { editable: true, today })}</div>
    <div class="c-form su-draft">
      <label class="field">Plan from<select id="su-from">${fromChoices(p, today, fresh).map((d) => `<option value="${d}" ${d === u.from ? 'selected' : ''}>${esc(dayLabel(d))}${d === p.start ? ' (the season start)' : d === defaultFrom(p, today) ? ' (after the phase you are in)' : ''}</option>`).join('')}</select></label>
      <p class="muted small">Phases before this stay as they are.</p>
      <div class="actions">
        <button type="button" class="btn secondary" id="su-draft">Draft from my meets</button>
        ${claudeOn ? `<button type="button" class="btn secondary" id="su-claude" ${u.busy ? 'disabled' : ''}>${u.busy === 'shape' ? 'Asking Claude…' : 'Shape it with Claude'}</button>
        <button type="button" class="btn secondary" id="su-describe" ${u.busy ? 'disabled' : ''}>${u.busy === 'describe' ? 'Asking Claude…' : 'Suggest descriptions'}</button>` : ''}
      </div>
    </div>
    ${prop ? `<div class="su-proposal">
      <h3>${prop.by === 'claude' ? "Claude's draft" : 'Draft from your meets'} from ${esc(dayLabel(prop.from))}</h3>
      ${prop.note ? `<p class="small">${esc(prop.note)}</p>` : ''}
      <div class="su-phases">${phaseRows(ctx, prop.phases, p.start, { editable: false, today })}</div>
      <div class="actions"><button type="button" class="btn" id="su-use">Use this</button><button type="button" class="btn secondary" id="su-discard">Keep mine</button></div>
    </div>` : ''}`;
}

function doneHTML(ctx, u) {
  const { esc } = ctx;
  const p = u.plan;
  const spans = phaseSpans(p);
  const pick = (v, table) => [...(v.keys || []).map((k) => table[k]), v.text].filter(Boolean).join('; ');
  const a = (p.meets || []).filter((m) => m.priority === 'A');
  const described = p.phases.filter((x) => x.description).length;
  return `<p class="lead">Here is the plan. Save it and the Week, Today and the coach chat work from it.</p>
    <dl class="c-facts su-facts">
      <div><dt>Season</dt><dd>${esc(p.name || 'Season')} · ${esc(dayLabel(p.start))}${spans.length ? ` – ${esc(dayLabel(spans.at(-1).end))}` : ''} · ${esc(p.course || '')}</dd></div>
      <div><dt>Taper meets</dt><dd>${a.length ? esc(a.map((m) => `${m.name} (${dayLabel(m.start)})`).join(', ')) : 'none marked A'}</dd></div>
      <div><dt>Week</dt><dd>${p.week.filter((d) => d.am).length} AM + ${p.week.filter((d) => d.pm).length} PM sessions${p.weeklyYards ? ` · ${esc(String(p.weeklyYards))} a hard week` : ''}</dd></div>
      <div><dt>Philosophy</dt><dd>${esc(pick(p.philosophy, PHILOSOPHIES) || '—')}</dd></div>
      <div><dt>Key skills</dt><dd>${esc(pick(p.skills, SKILLS) || '—')}</dd></div>
      <div><dt>Equipment</dt><dd>${esc(p.equipment ? p.equipment.join(', ') || 'none' : 'all')}</dd></div>
      <div><dt>Phases</dt><dd>${spans.length}${described < spans.length ? ` · ${spans.length - described} without a description` : ' · all described'}</dd></div>
    </dl>`;
}

// ------------------------------------------------------------------ bind

// The working copy into the plan and saved (progress is kept at every
// step); resolves true when stored.
function keep(ctx, u, step) {
  const { state } = ctx;
  u.plan.setup = { ...(u.plan.setup || {}), step: STEPS[step]?.[0] || u.plan.setup?.step };
  state.plan = migratePlan(copy(u.plan));
  u.plan = copy(state.plan);
  return ctx.save.plan();
}

function bind(ctx, el, u, key) {
  const { $, $$, state } = ctx;
  const rr = () => ctx.rerender();
  const goStep = async (i) => {
    if (i < 0 || i >= STEPS.length) return;
    u.step = i;
    u.proposal = null;
    const saving = keep(ctx, u, i);
    rr();
    window.scrollTo?.({ top: 0 });
    await saving;
  };
  $('#su-next', el)?.addEventListener('click', () => goStep(u.step + 1));
  $('#su-back', el)?.addEventListener('click', () => goStep(u.step - 1));
  $$('[data-step]', el).forEach((b) => { b.onclick = () => goStep(+b.dataset.step); });
  $('#su-skip', el).onclick = async () => {
    const finished = !!state.plan.setup?.done;
    if (!finished) u.plan.setup = { ...(u.plan.setup || {}), skipped: state.today };
    await keep(ctx, u, u.step);
    state.ui.setup = null;
    if (!finished) ctx.toast('Plan the season any time from Season');
    ctx.go(finished ? 'season' : 'today');
  };
  $('#su-finish', el)?.addEventListener('click', async () => {
    u.plan.setup = { done: state.today };
    // The team's equipment is what suggestions can use, unless picked otherwise.
    if (u.plan.equipment && state.prefs.equipment == null) {
      state.prefs = { ...state.prefs, equipment: [...u.plan.equipment] };
      ctx.save.prefs();
    }
    const saved = await keep(ctx, u, u.step);
    if (!saved) return;
    state.ui.setup = null;
    ctx.toast('Season plan saved');
    ctx.go('week');
  });

  // Plain fields (`data-p="a.b"`): typed into the working copy.
  $$('[data-p]', el).forEach((input) => {
    input.oninput = () => {
      const [a, b] = input.dataset.p.split('.');
      let v = input.value;
      if (a === 'start') { if (!v) return; v = mondayOf(v); }
      if (a === 'weeklyYards') v = Math.round(+v) > 0 ? Math.min(300000, Math.round(+v)) : null;
      if (a === 'course') u.plan.unit = v === 'SCY' ? 'y' : 'm';
      if (b) u.plan[a] = { ...(u.plan[a] || {}), [b]: v }; else u.plan[a] = v;
    };
  });
  $$('[data-w]', el).forEach((input) => {
    input.oninput = () => {
      const [slot, i] = input.dataset.w.split('-');
      u.plan.week[+i][slot] = Math.min(300, Math.max(0, Math.round(+input.value) || 0));
      input.classList.toggle('off', !u.plan.week[+i][slot]);
    };
  });
  // Several-at-once chips.
  $$('[data-multi]', el).forEach((row) => {
    const name = row.dataset.multi;
    $$('[data-multi-key]', row).forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.multiKey;
        if (name === 'equipment') {
          const on = new Set(u.plan.equipment || []);
          if (on.has(k)) on.delete(k); else on.add(k);
          u.plan.equipment = EQUIPMENT.filter((e) => on.has(e));
        } else {
          const keys = new Set(u.plan[name].keys);
          if (keys.has(k)) keys.delete(k); else keys.add(k);
          u.plan[name] = { ...u.plan[name], keys: [...keys] };
        }
        rr();
      };
    });
  });

  // Meets.
  $$('[data-prio]', el).forEach((b) => {
    b.onclick = () => {
      const m = u.plan.meets.find((x) => x.id === b.dataset.prio);
      if (!m) return;
      m.priority = m.priority === b.dataset.value ? '' : b.dataset.value;
      rr();
    };
  });
  $$('[data-unmeet]', el).forEach((b) => {
    b.onclick = async () => {
      const m = u.plan.meets.find((x) => x.id === b.dataset.unmeet);
      if (!m || !(await ctx.confirmAction(`Remove ${m.name} from the plan?`, 'Remove'))) return;
      u.plan.meets = u.plan.meets.filter((x) => x.id !== m.id);
      rr();
    };
  });
  $('#su-meetnew', el)?.addEventListener('click', () => {
    const d = addDays(state.today, 28);
    u.meet = { name: '', start: d, end: d, priority: 'A' };
    rr();
    $('[data-m="name"]', el)?.focus();
  });
  $$('[data-m]', el).forEach((input) => { input.oninput = () => { u.meet[input.dataset.m] = input.value; }; });
  $$('[data-mprio]', el).forEach((b) => { b.onclick = () => { u.meet.priority = b.dataset.mprio; rr(); }; });
  $('#su-meetcancel', el)?.addEventListener('click', () => { u.meet = null; rr(); });
  $('#su-meetadd', el)?.addEventListener('click', () => {
    const m = u.meet;
    const err = $('#su-meeterr', el);
    if (!m.name.trim() || !m.start) { err.textContent = 'Give the meet a name and its first day.'; err.hidden = false; return; }
    u.plan.meets = [...(u.plan.meets || []), makeMeet({ ...m, course: m.course || u.plan.course, end: m.end && m.end >= m.start ? m.end : m.start })]
      .sort((a, b) => (a.start < b.start ? -1 : 1));
    u.meet = null;
    rr();
  });

  // Phases.
  $$('[data-ph]', el).forEach((input) => {
    input.oninput = () => {
      const [f, i] = input.dataset.ph.split('-');
      const ph = u.plan.phases[+i];
      if (!ph) return;
      if (f === 'weeks') { const n = Math.round(+input.value); if (n >= 1 && n <= 52) ph.weeks = n; } else ph[f] = input.value;
    };
    // Weeks move every later phase's dates: redraw once typed.
    if (input.dataset.ph.startsWith('weeks-')) input.onchange = rr;
  });
  $('#su-from', el)?.addEventListener('change', (e) => { u.from = e.target.value; u.proposal = null; rr(); });
  $('#su-draft', el)?.addEventListener('click', () => {
    u.proposal = { by: 'app', from: u.from, phases: draftPhases(u.plan, { from: u.from }), note: '' };
    rr();
    $('.su-proposal', el)?.scrollIntoView({ block: 'nearest' });
  });
  const ask = async (mode) => {
    const sample = ctx.claude.sample;
    if (!sample || u.busy) return;
    u.busy = mode;
    rr();
    try {
      const turns = planTurns(u.plan, { today: state.today, from: u.from, mode });
      let r;
      try {
        r = parsePlanReply(await sample.json(turns, { modelTier: 'default', cache: false }), u.plan, mode);
      } catch (e) {
        if (e?.code === 'invalid_json' && e.text) r = parsePlanReply(e.text, u.plan, mode); else throw e;
      }
      if (mode === 'describe') {
        // Only phases without a description get one: what the coach wrote stays.
        let n = 0;
        u.plan.phases.forEach((ph, i) => { if (!String(ph.description || '').trim() && r.descriptions[i]) { ph.description = r.descriptions[i]; n += 1; } });
        ctx.toast(n ? `Suggested ${n} description${n === 1 ? '' : 's'}: edit them as you like` : 'Every phase already has a description');
      } else {
        u.proposal = { by: 'claude', from: u.from, phases: [...phasesBefore(u.plan, u.from), ...r.phases], note: r.note };
      }
    } catch (e) {
      const code = e?.code;
      if (['not_granted', 'capability_disabled', 'capability_removed'].includes(code)) state.ui.claudeOff = code;
      ctx.toast(code === 'rate_limited' ? 'Claude is busy: try again in a minute.' : "Claude couldn't draft that this time. Draft from your meets instead, or try again.", { error: true });
    } finally {
      u.busy = false;
      if (state.tab === 'setup') rr();
    }
  };
  $('#su-claude', el)?.addEventListener('click', () => ask('shape'));
  $('#su-describe', el)?.addEventListener('click', () => ask('describe'));
  $('#su-use', el)?.addEventListener('click', () => {
    // Descriptions typed for kept phases stay with them.
    u.plan.phases = u.proposal.phases;
    u.proposal = null;
    rr();
    ctx.toast('Phases updated: say what each one is for, then Next');
  });
  $('#su-discard', el)?.addEventListener('click', () => { u.proposal = null; rr(); });
}
