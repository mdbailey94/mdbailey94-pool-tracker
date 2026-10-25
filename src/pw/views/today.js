// Today: where the season is, the week, today's sessions (AM, and PM on
// double days), a few questions about the group, the written set, the
// debrief reminder and how much CNS load is still around.

import {
  EQUIPMENT, FOCUSES, WEEKDAYS, addDays, blockMinutes, composePractice, daysBetween, longDate,
  makeBlock, mondayOf, nextMeet, sessionsOn, suggestPractice, uid,
} from '../../practice.js';
import { generateBlock } from '../../setlang.js';
import { slotHour } from '../../week.js';
import { focusLabel, practiceHTML } from '../render.js';
import { cnsBefore } from '../load.js';
import { openDebrief, replaceDraft } from '../guards.js';

const SHORT = { aerobic: 'Aero', threshold: 'Thresh', race: 'Race', speed: 'Speed', technique: 'Tech', recovery: 'Recov', rest: 'Rest' };
const TIME_CHIPS = [20, 30, 45, 60, 90, 120];
const FEELINGS = [['fresh', 'Fresh'], ['normal', 'Normal'], ['tired', 'Tired, sore']];
const HIGH_CNS = new Set(['race', 'speed']);
// The block writer's focus for each category (generateBlock): warm-ups and
// cool-downs are written easy, as Blocks writes them.
const GEN_FOCUS = { warmup: 'warmup', aerobic: 'aerobic', threshold: 'threshold', race: 'race', speed: 'speed', kick: 'kick', technique: 'technique', pull: 'aerobic', cooldown: 'cooldown' };
const STEPS = 5;

const gearsText = (f) => (FOCUSES[f]?.gears || []).join(' · ');
const slotName = (slot) => (slot === 'PM' ? 'PM' : 'AM');
const dayName = (iso) => longDate(iso).split(',')[0];

export function positionText(pos) {
  if (pos.status === 'before') return `Season starts in ${pos.daysToStart} day${pos.daysToStart === 1 ? '' : 's'}`;
  if (pos.status === 'after') return 'Season finished · off-season';
  if (pos.status === 'empty') return 'No phases in the plan yet';
  return `${pos.phase.name} · week ${pos.phaseWeek + 1} of ${pos.phase.weeks}`;
}

const coachOn = (ctx) => !!ctx.claude.sample && !ctx.state.ui.claudeOff;

// ----------------------------------------------------------------- render

export function render(ctx, el) {
  const { state } = ctx;
  const day = sessionsOn(state.plan, state.today);
  el.innerHTML = [
    headCard(ctx, day),
    debriefCard(ctx),
    sessionsCard(ctx, day),
    state.ask ? askCard(ctx, day) : '',
    !state.ask && state.suggestion ? suggestionCard(ctx) : '',
    loadCard(ctx, day),
    `<section class="card coach-link">
      <div><h3>Text the coach</h3><p class="muted small">${coachOn(ctx) ? 'Ask for a practice or a block in your notation, change one, or ask what the debriefs said.' : 'Chat with Claude about your sets (needs the Claude version of this page); paste a set to save it as a block.'}</p></div>
      <button class="btn secondary" id="t-coach">Open Coach</button>
    </section>`,
  ].join('');
  bind(ctx, el);
  if (state.ui.todayScroll) {
    const target = ctx.$(state.ui.todayScroll, el);
    state.ui.todayScroll = null;
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

// ------------------------------------------------------------------ header

function weekStrip(ctx) {
  const { state, esc } = ctx;
  const monday = mondayOf(state.today);
  return `<div class="week tw-week">${WEEKDAYS.map((d, i) => {
    const iso = addDays(monday, i);
    const day = sessionsOn(state.plan, iso);
    const am = day.sessions.find((s) => s.slot === 'AM');
    const pm = day.sessions.find((s) => s.slot === 'PM');
    const label = day.meet ? 'Meet' : am ? SHORT[am.focus] || focusLabel(am.focus) : pm ? `PM ${SHORT[pm.focus] || ''}` : 'Rest';
    const cls = [iso === state.today ? 'today' : '', !day.sessions.length && !day.meet ? 'rest' : '', day.meet ? 'meetday' : ''].filter(Boolean).join(' ');
    const title = day.meet ? day.meet.name : day.sessions.map((s) => `${s.slot} ${s.minutes} min ${focusLabel(s.focus)}`).join(', ') || 'No practice';
    return `<div class="${cls}" title="${esc(`${d}: ${title}`)}"><b>${d}</b><span>${esc(label)}</span>${am && pm ? '<i class="pm">+PM</i>' : '<i class="pm none"></i>'}</div>`;
  }).join('')}</div>`;
}

function headCard(ctx, day) {
  const { state, esc } = ctx;
  const pos = day.position;
  const banners = [];
  if (day.meet) {
    banners.push(`<div class="banner meet"><b>Meet day</b><span>${esc(day.meet.name)}${day.meet.course ? ` · ${esc(day.meet.course)}` : ''}. No practice.</span></div>`);
  } else {
    const m = nextMeet(state.plan, state.today);
    const away = m ? daysBetween(state.today, m.start) : null;
    if (m && away > 0 && away <= 7) banners.push(`<div class="banner meet"><b>${esc(m.name)}</b><span>in ${away} day${away === 1 ? '' : 's'} (${esc(longDate(m.start))})</span></div>`);
  }
  if (day.preMeet) banners.push(`<div class="banner"><b>Pre-meet</b><span>${esc(day.sessions[0]?.note || 'Sharpen')}: one short session, speed and race feel, plenty of rest.</span></div>`);
  if (state.planIsDefault) banners.push('<div class="banner"><span>This is the default plan: 2 hours every morning but Sunday, doubles Tuesday and Thursday. Set your dates, meets and groups under <b>Season</b>.</span><button class="btn secondary small-btn" id="t-season">Season</button></div>');
  return `<section class="card tw-head">
    <div class="eyebrow">${esc(longDate(state.today))}</div>
    <h2>${esc(positionText(pos))}</h2>
    ${pos.status === 'in' ? `<p class="muted small">Season week ${pos.week + 1} of ${pos.total}${state.plan.name && state.plan.name !== 'Season' ? ` · ${esc(state.plan.name)}` : ''}</p>` : ''}
    ${weekStrip(ctx)}
    ${banners.length ? `<div class="tw-banners">${banners.join('')}</div>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- sessions

function sessionsCard(ctx, day) {
  const { state, esc } = ctx;
  if (day.meet) {
    const m = day.meet;
    const n = daysBetween(m.start, state.today) + 1;
    const len = daysBetween(m.start, m.end) + 1;
    return `<section class="card"><div class="eyebrow">Meet</div><h3>${esc(m.name)}</h3>
      <p class="lead">${len > 1 ? `Day ${n} of ${len}` : 'One day'}${m.course ? ` · ${esc(m.course)}` : ''}. No practice today.</p>
      ${m.note ? `<p class="muted small">${esc(m.note)}</p>` : ''}
    </section>`;
  }
  if (!day.sessions.length) {
    let next = null;
    for (let i = 1; i <= 7 && !next; i++) {
      const d = sessionsOn(state.plan, addDays(state.today, i));
      if (d.sessions.length) next = { date: d.date, s: d.sessions[0] };
    }
    return `<section class="card"><div class="eyebrow">Today</div><h3>No practice today</h3>
      <p class="lead">${esc(dayName(state.today))} is off in the plan.${next ? ` Next: ${esc(dayName(next.date))} ${next.s.slot}, ${next.s.minutes} min ${esc(focusLabel(next.s.focus).toLowerCase())}.` : ''}</p>
      <div class="actions"><button class="btn secondary" id="t-anyway">Write one anyway</button></div>
    </section>`;
  }
  const written = (slot) => state.log.find((r) => r.date === state.today && (r.slot || 'AM') === slot);
  return `<section class="card"><div class="eyebrow">Today's sessions</div>
    <div class="session-grid">${day.sessions.map((s) => {
      const rec = written(s.slot);
      const active = state.ask?.slot === s.slot || (!state.ask && state.suggestion?.slot === s.slot);
      return `<div class="session ${active ? 'active' : ''}">
        <div class="slot">${s.slot} · ${s.minutes} min${s.volume && s.volume !== 1 ? ` <span class="muted">(${Math.round(s.volume * 100)}% volume)</span>` : ''}</div>
        <div class="tw-focus"><b>${esc(focusLabel(s.focus))}</b>${gearsText(s.focus) ? ` <span class="muted">${esc(gearsText(s.focus))}</span>` : ''}</div>
        ${s.theme ? `<div class="muted small">${esc(s.theme)}</div>` : ''}
        ${s.note ? `<div class="small">${esc(s.note)}</div>` : ''}
        ${rec ? `<div class="small tw-done">In the log${rec.title ? `: ${esc(rec.title)}` : ''}</div>` : ''}
        <button class="btn ${rec ? 'secondary' : ''}" data-write="${s.slot}">${rec ? 'Write another' : 'Write it'}</button>
      </div>`;
    }).join('')}</div>
  </section>`;
}

// --------------------------------------------------------------- questions

function startAsk(ctx, slot, extra = {}) {
  const { state } = ctx;
  const day = sessionsOn(state.plan, state.today);
  const s = day.sessions.find((x) => x.slot === slot);
  state.suggestion = null;
  state.ask = {
    slot,
    step: 0,
    minutes: s?.minutes || 60,
    feeling: 'normal',
    equipment: Array.isArray(state.prefs.equipment) ? [...state.prefs.equipment] : null,
    focus: null,
    emphasis: '',
    ...extra,
  };
  state.ui.todayScroll = '#t-ask';
  ctx.rerender();
}

function usedEquipment(ctx) {
  return EQUIPMENT.filter((e) => ctx.state.blocks.some((b) => b.equipment?.includes(e)));
}

// The equipment after tapping one item. From Everything (null) that item is
// all there is; else it goes on or off (none left = Nothing).
export function toggleKit(equipment, k) {
  if (!Array.isArray(equipment)) return [k];
  return equipment.includes(k) ? equipment.filter((x) => x !== k) : [...equipment, k];
}

function askCard(ctx, day) {
  const { state, esc } = ctx;
  const a = state.ask;
  const s = day.sessions.find((x) => x.slot === a.slot);
  const planned = s?.focus || (a.focus ?? 'recovery');
  const step = a.step;
  let body = '';
  if (step === 0) {
    const other = !TIME_CHIPS.includes(a.minutes);
    body = `<p class="lead">Time in the water</p>
      <div class="chips">${TIME_CHIPS.map((m) => `<button type="button" class="chip ${a.minutes === m ? 'on' : ''}" data-min="${m}" aria-pressed="${a.minutes === m}">${m} min</button>`).join('')}
        <label class="chip chip-input ${other ? 'on' : ''}" id="t-min-chip">other <input type="number" id="t-min" inputmode="numeric" min="15" max="240" value="${other ? a.minutes : ''}" aria-label="Other minutes"> min</label></div>
      ${s ? `<p class="muted small">The plan says ${s.minutes} min.</p>` : ''}`;
  } else if (step === 1) {
    body = `<p class="lead">The group today</p>
      ${ctx.chips('feel', FEELINGS, a.feeling, { allowNone: false })}
      <p class="muted small">Tired eases a hard day (threshold → aerobic, race pace or speed → technique).</p>`;
  } else if (step === 2) {
    const used = usedEquipment(ctx);
    const all = a.equipment === null;
    body = `<p class="lead">Equipment on deck</p>
      <div class="chips"><button type="button" class="chip ${all ? 'on' : ''}" data-kit="all" aria-pressed="${all}">Everything</button>
        ${used.map((e) => { const on = !all && a.equipment.includes(e); return `<button type="button" class="chip ${on ? 'on' : ''}" data-kit="${esc(e)}" aria-pressed="${on}">${esc(e)}</button>`; }).join('')}
        <button type="button" class="chip ${!all && !a.equipment.length ? 'on' : ''}" data-kit="none" aria-pressed="${!all && !a.equipment.length}">Nothing</button></div>
      <p class="muted small">Blocks that need equipment you don't have are left out.</p>`;
  } else if (step === 3) {
    const opts = [['plan', `Follow the plan (${focusLabel(planned)})`], ...Object.keys(FOCUSES).filter((f) => f !== 'rest' && f !== planned).map((f) => [f, focusLabel(f)])];
    body = `<p class="lead">Focus</p>${ctx.chips('focus', opts, a.focus || 'plan', { allowNone: false })}`;
  } else {
    body = `<label class="q"><span>Anything to emphasise?</span>
      <textarea id="t-emph" rows="3" placeholder="e.g. BR turns, UWDK off every wall, holding G3 on the 100s">${esc(a.emphasis)}</textarea></label>
      <p class="muted small">${esc(summaryOf(ctx, a, planned))}</p>`;
  }
  const last = step === STEPS - 1;
  return `<section class="card tw-ask" id="t-ask">
    <div class="eyebrow">${esc(slotName(a.slot))} · ${step + 1} of ${STEPS}</div>
    ${body}
    <div class="actions">
      <button class="btn secondary" id="t-back">${step === 0 ? 'Cancel' : 'Back'}</button>
      ${last ? `<button class="btn" id="t-write">Write the set</button>${coachOn(ctx) ? '<button class="btn secondary" id="t-ask-coach">Ask the coach</button>' : ''}` : '<button class="btn" id="t-next">Next</button>'}
    </div>
  </section>`;
}

function equipmentText(eq) {
  if (eq === null || eq === undefined) return 'everything';
  return eq.length ? eq.join(', ') : 'no equipment';
}

function summaryOf(ctx, a, planned) {
  const feel = FEELINGS.find(([k]) => k === a.feeling)?.[1].toLowerCase() || 'normal';
  return `${a.minutes} min · ${focusLabel(a.focus || planned)} · the group ${feel} · ${equipmentText(a.equipment)}`;
}

// The message for the coach chat from the answers (and the app's draft).
function coachMessage(ctx, a, suggestion = null) {
  const { state } = ctx;
  const day = sessionsOn(state.plan, state.today);
  const s = day.sessions.find((x) => x.slot === a.slot);
  const focus = a.focus || s?.focus || 'recovery';
  const feel = FEELINGS.find(([k]) => k === a.feeling)?.[1].toLowerCase() || 'normal';
  const lines = [
    `Write today's ${slotName(a.slot)} practice (${longDate(state.today)}): ${a.minutes} min in the water, ${focusLabel(focus).toLowerCase()}${a.focus && s && a.focus !== s.focus ? ` (the plan says ${focusLabel(s.focus).toLowerCase()})` : ''}.`,
    `The group today: ${feel}.`,
    `Equipment: ${equipmentText(a.equipment)}.`,
  ];
  if (a.emphasis?.trim()) lines.push(`Emphasise: ${a.emphasis.trim()}`);
  if (suggestion?.blocks?.length) lines.push(`The app put together: ${suggestion.blocks.map((b) => b.name).join(', ')}. Write it out in my notation with send-offs for each group, changing what doesn't fit.`);
  return lines.join('\n');
}

function askCoach(ctx, a, suggestion = null) {
  const { state } = ctx;
  state.chat.pending = coachMessage(ctx, a, suggestion);
  state.chat.pendingSlot = a.slot;
  ctx.go('coach');
}

function suggest(ctx, a, variant = 0) {
  const { state } = ctx;
  const opts = { minutes: a.minutes, feeling: a.feeling, equipment: a.equipment, focus: a.focus, slot: a.slot };
  const s = suggestPractice({ plan: state.plan, library: state.blocks, date: state.today, history: state.log, weights: ctx.learned.weights, variant, ...opts });
  state.suggestion = { ...s, ask: { ...a }, variant };
  state.ask = null;
  state.ui.todayScroll = '#t-sugg';
  if (JSON.stringify(state.prefs.equipment ?? null) !== JSON.stringify(a.equipment ?? null)) {
    state.prefs = { ...state.prefs, equipment: a.equipment };
    ctx.save.prefs();
  }
  ctx.rerender();
}

// -------------------------------------------------------------- suggestion

function suggestionCard(ctx) {
  const { state, esc } = ctx;
  const s = state.suggestion;
  const composed = composePractice({ blocks: s.blocks, rounds: s.rounds, pattern: s.pattern, pace: state.plan.pace, unit: state.plan.unit });
  const rest = s.focus === 'rest';
  const bare = s.blocks.map((b, i) => [b, i]).filter(([b]) => !b.lines?.length && GEN_FOCUS[b.category]);
  const notes = [...s.notes];
  if (s.ask?.emphasis?.trim()) notes.push(`Emphasise: ${s.ask.emphasis.trim()}`);
  return `<section class="card" id="t-sugg">
    <div class="eyebrow">${esc(slotName(s.slot))} · ${esc(focusLabel(s.focus))} · ${s.minutes} min${s.variant ? ` · option ${s.variant + 1}` : ''}</div>
    <h3>${s.blocks.length ? `Today's ${esc(slotName(s.slot))}` : rest ? 'Nothing to write' : 'Nothing fits yet'}</h3>
    ${s.blocks.length ? practiceHTML(composed, ctx, { slot: s.slot, showDetail: state.prefs.showDetail !== false }) : ''}
    ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${bare.length ? `<div class="tw-bare"><p class="muted small">No set lines yet for these blocks. Write them from your gear chart and style, saved to the library as new blocks:</p>
      ${bare.map(([b, i]) => `<div class="tw-bare-row"><span>${esc(b.name)}</span><button class="btn secondary small-btn" data-gen="${i}">Write lines</button></div>`).join('')}</div>` : ''}
    <div class="actions">
      ${s.blocks.length ? '<button class="btn" id="t-open">Open in builder</button>' : ''}
      ${!rest && state.blocks.length ? '<button class="btn secondary" id="t-another">Another</button>' : ''}
      ${!state.blocks.length ? '<button class="btn secondary" id="t-blocks">Open Blocks</button>' : ''}
      ${coachOn(ctx) ? '<button class="btn secondary" id="t-sugg-coach">Ask the coach</button>' : ''}
      <button class="btn secondary" id="t-reset">Start over</button>
    </div>
  </section>`;
}

async function writeLinesFor(ctx, i) {
  const { state } = ctx;
  const s = state.suggestion;
  const b = s?.blocks[i];
  if (!b) return;
  const gen = generateBlock({ focus: GEN_FOCUS[b.category] || 'aerobic', minutes: blockMinutes(b, state.plan.pace), stroke: b.stroke, slot: s.slot, ctx: ctx.learned.writing });
  const nb = makeBlock({ ...gen, category: b.category, equipment: b.equipment, detail: b.detail, intensity: b.intensity, source: 'generated' });
  const saved = await ctx.save.block(nb);
  // The written block carries its own rounds, so it leaves the circuit. It
  // stays in the suggestion when the library save failed (the app says Not
  // saved and offers Try again).
  s.blocks[i] = { ...nb, circuit: false };
  ctx.toast(saved ? `Wrote ${nb.name} · saved to the library` : `Wrote ${nb.name} · not saved to the library yet`);
  ctx.rerender();
}

// ----------------------------------------------------------------- debrief

function latestUndebriefed(state) {
  const done = new Set(state.debriefs.map((d) => d.practiceId));
  const latest = [...state.log].filter((r) => r.date <= state.today)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.slot === 'PM') - (a.slot === 'PM') || (b.createdAt || 0) - (a.createdAt || 0)))[0];
  return latest && !done.has(latest.id) ? latest : null;
}

function debriefCard(ctx) {
  const { state, esc } = ctx;
  const r = latestUndebriefed(state);
  if (!r) return '';
  const when = r.date === state.today ? `today's ${r.slot || 'AM'}` : r.date === addDays(state.today, -1) ? `yesterday's ${r.slot || 'AM'}` : `${dayName(r.date)}'s ${r.slot || 'AM'}`;
  const editing = state.debriefing?.practiceId === r.id;
  return `<section class="card tw-debrief">
    <div><div class="eyebrow">Debrief</div>
    <h3>How did ${esc(when)} go?</h3>
    <p class="muted small">${esc(r.title || focusLabel(r.focus) || 'Practice')} · intervals, goal times, drills, what you changed. The app learns from it.</p></div>
    <button class="btn" id="t-debrief" data-id="${esc(r.id)}">${editing ? 'Continue debrief' : 'Debrief'}</button>
  </section>`;
}

// -------------------------------------------------------------------- load

// What is left from the last 2 days' practices, each counted as the builder
// counted it (rounds, round pattern, gear shifts: see load.js).
function loadCard(ctx, day) {
  const { state, esc } = ctx;
  const model = ctx.learned.writing.model;
  const slots = day.sessions.length ? day.sessions : [{ slot: 'AM', focus: null }];
  const { recent: recs, left } = cnsBefore(state.log, state.today, slots.map((s) => s.slot), ctx);
  const rows = slots.map((s, i) => ({ s, left: left[i].left }));
  const worst = rows.find((x) => x.s.focus && HIGH_CNS.has(x.s.focus) && x.left > 5);
  const contrib = recs.filter((x) => x.points > 0);
  return `<section class="card tw-load">
    <div class="eyebrow">Load</div>
    <h3>CNS left from the last 2 days</h3>
    ${recs.length ? `<div class="tw-cns">${rows.map(({ s, left }) => `<div><span class="muted small">${day.sessions.length ? `${s.slot} · ${slotHour(s.slot)}:00` : 'This morning'}</span><b class="${left > 5 ? 'hi' : ''}">${left}</b></div>`).join('')}</div>
      ${contrib.length ? `<p class="muted small">${contrib.map((x) => `${esc(dayName(x.record.date))} ${esc(x.record.slot || 'AM')}: ${Math.round(x.points * 10) / 10}`).join(' · ')} (points when swum; half gone every ${model.cnsHalfLifeHours || 12} h)</p>` : '<p class="muted small">Nothing above G3 in the last 2 days.</p>'}`
    : '<p class="muted small">No practices in the log for the last 2 days, so nothing is left over.</p>'}
    ${worst ? `<div class="banner alert"><span>${worst.left} points still left before the ${esc(worst.s.slot)} ${esc(focusLabel(worst.s.focus).toLowerCase())} session. A high-CNS session wants under 5: keep the G5–G6 work short, give it more rest, or swap it with an aerobic day.</span></div>` : ''}
  </section>`;
}

// -------------------------------------------------------------------- bind

function bind(ctx, el) {
  const { state, $, $$ } = ctx;
  const on = (sel, fn) => { const n = $(sel, el); if (n) n.onclick = fn; };
  on('#t-coach', () => ctx.go('coach'));
  on('#t-season', () => ctx.go('season'));
  on('#t-anyway', () => startAsk(ctx, 'AM', { minutes: 60, focus: 'recovery' }));
  $$('[data-write]', el).forEach((b) => { b.onclick = () => startAsk(ctx, b.dataset.write); });
  on('#t-debrief', async (e) => {
    const r = state.log.find((x) => x.id === e.currentTarget.dataset.id);
    if (!r || !(await openDebrief(ctx, r))) return;
    ctx.go('debrief');
  });

  const a = state.ask;
  if (a) {
    $$('[data-min]', el).forEach((b) => { b.onclick = () => { a.minutes = +b.dataset.min; ctx.rerender(); }; });
    const min = $('#t-min', el);
    if (min) {
      min.onclick = (e) => e.stopPropagation();
      // Typed minutes count as they are typed, with the chips updated in
      // place: a redraw on change (which fires when the coach presses Next)
      // would swallow that press.
      min.oninput = () => {
        const v = Math.round(+min.value);
        if (!min.value || !(v >= 15 && v <= 300)) return;
        a.minutes = v;
        $$('[data-min]', el).forEach((c) => { const on = +c.dataset.min === v; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
        $('#t-min-chip', el)?.classList.toggle('on', !TIME_CHIPS.includes(v));
      };
    }
    ctx.bindChips(el, (name, value) => {
      if (name === 'feel') a.feeling = value || 'normal';
      if (name === 'focus') a.focus = !value || value === 'plan' ? null : value;
      ctx.rerender();
    });
    $$('[data-kit]', el).forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.kit;
        if (k === 'all') a.equipment = null;
        else if (k === 'none') a.equipment = [];
        else a.equipment = toggleKit(a.equipment, k);
        ctx.rerender();
      };
    });
    const emph = $('#t-emph', el);
    if (emph) emph.oninput = () => { a.emphasis = emph.value; };
    on('#t-back', () => { if (a.step === 0) state.ask = null; else a.step--; ctx.rerender(); });
    on('#t-next', () => {
      if (a.step === 0 && min && min.value) { const v = Math.round(+min.value); if (v >= 15 && v <= 300) a.minutes = v; }
      a.step = Math.min(STEPS - 1, a.step + 1);
      ctx.rerender();
    });
    on('#t-write', () => suggest(ctx, a));
    on('#t-ask-coach', () => askCoach(ctx, a));
  }

  const s = state.suggestion;
  if (s) {
    on('#t-another', () => suggest(ctx, s.ask, (s.variant || 0) + 1));
    on('#t-reset', () => { state.suggestion = null; state.ask = null; ctx.rerender(); });
    on('#t-blocks', () => ctx.go('blocks'));
    on('#t-sugg-coach', () => askCoach(ctx, s.ask, s));
    on('#t-open', async () => {
      if (!(await replaceDraft(ctx, "today's suggestion"))) return;
      state.draft = {
        date: state.today,
        slot: s.slot,
        title: '',
        focus: s.ask?.focus || null,
        blocks: s.blocks.map((b) => ({ ...b, key: uid('k') })),
        rounds: Math.max(2, s.rounds),
        pattern: s.pattern || 'even',
      };
      ctx.go('build');
    });
    $$('[data-gen]', el).forEach((b) => {
      b.onclick = async () => { b.disabled = true; b.textContent = 'Writing…'; await writeLinesFor(ctx, +b.dataset.gen); };
    });
  }
}
