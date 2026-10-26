// Week: the lead coach's planning board. Every session Monday to Sunday with
// what the plan wants and where it stands (open, written, swum, debriefed),
// the week's totals against the phase's targets (yards, gear bands, kick,
// CNS day by day), and a first draft of every open session in one go that
// the coach looks over before anything is saved. Written sessions go into
// the week's Google Doc from the card under the header (doc-card.js).

import {
  FOCUSES, WEEKDAYS, addDays, composePractice, daysBetween, fmtDistance, longDate, mondayOf,
  parseISO, sessionsOn, suggestPractice,
} from '../../practice.js';
import { BANDS, draftWeek, weekGaps, weekOf, weekTotals } from '../../week.js';
import { focusLabel, practiceHTML, practiceTextFor } from '../render.js';
import { draftBlock, savedRecord } from '../load.js';
import { openDebrief, replaceDraft } from '../guards.js';
import { updateDebriefDot } from '../app.js';
import { bindDocCard, docCardHTML, inDoc, weekDocFor } from '../doc-card.js';

const STATUS = { open: 'Open', written: 'Written', swum: 'Swum', debriefed: 'Debriefed' };
const BAND_NAME = { aerobic: 'aerobic', threshold: 'threshold', vo2: '1000 pace / VO2', race: 'race / speed' };
const HIGH_CNS = new Set(['race', 'speed']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const gearsText = (f) => (FOCUSES[f]?.gears || []).join(' · ');
const pct = (v) => Math.round((v || 0) * 100);
const coachOn = (ctx) => !!ctx.claude.sample && !ctx.state.ui.claudeOff;
const isMain = (b) => !['warmup', 'cooldown'].includes(b.category);

function shortDate(iso, withYear = false) {
  return parseISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}
const dayLabel = (iso) => `${WEEKDAYS[(parseISO(iso).getDay() + 6) % 7]} ${shortDate(iso)}`;
const weekdayLong = (iso) => parseISO(iso).toLocaleDateString(undefined, { weekday: 'long' });

// What a written practice is called on the board: its title, else its main
// blocks, else its focus.
function recordTitle(r) {
  if (r.title) return r.title;
  const main = (r.blocks || []).filter(isMain).map((b) => b.name).filter(Boolean);
  if (main.length) return main.slice(0, 3).join(', ') + (main.length > 3 ? '…' : '');
  return focusLabel(r.focus) || 'Practice';
}

function relWeek(monday, today) {
  const n = Math.round(daysBetween(mondayOf(today), monday) / 7);
  if (n === 0) return 'This week';
  if (n === 1) return 'Next week';
  if (n === -1) return 'Last week';
  return n > 0 ? `In ${n} weeks` : `${-n} weeks ago`;
}

function positionText(pos) {
  if (!pos) return '';
  if (pos.status === 'before') return `Before the season · it starts in ${pos.daysToStart} day${pos.daysToStart === 1 ? '' : 's'}`;
  if (pos.status === 'after') return 'After the season · off-season';
  if (pos.status === 'empty') return 'No phases in the plan yet';
  return `${pos.phase.name} · week ${pos.phaseWeek + 1} of ${pos.phase.weeks} · season week ${pos.week + 1} of ${pos.total} · volume ${pct(pos.phase.volume)}%`;
}

// ----------------------------------------------------------------- render

export function render(ctx, el) {
  const { state } = ctx;
  if (!ISO.test(state.ui.week || '')) state.ui.week = mondayOf(state.today);
  const monday = mondayOf(state.ui.week);
  state.ui.week = monday;
  const ui = (state.ui.wk ||= { view: null, drafts: null, past: false });
  if (ui.drafts && ui.drafts.monday !== monday) ui.drafts = null;
  const week = weekOf({ plan: state.plan, date: monday, today: state.today, log: state.log, debriefs: state.debriefs });
  // CNS by day counted as the builder and Today count it (recordLoad).
  const totals = weekTotals(week, state.plan, ctx.learned.writing.model);
  const gaps = weekGaps(totals);
  const viewing = ui.view ? findSession(week, ui.view) : null;
  if (ui.view && !viewing) ui.view = null;

  el.innerHTML = `<div class="wk">
    ${headHTML(ctx, week, totals, ui)}
    ${docCardHTML(ctx, week)}
    ${ui.drafts ? draftsHTML(ctx, ui.drafts) : ''}
    <div class="wk-days">${week.days.map((day, i) => dayHTML(ctx, day, i, ui)).join('')}</div>
    ${viewing ? viewerHTML(ctx, viewing) : ''}
    ${totalsHTML(ctx, week, totals, gaps)}
  </div>`;
  bind(ctx, el, week, ui);
  if (state.ui.wkScroll) {
    const target = ctx.$(state.ui.wkScroll, el);
    state.ui.wkScroll = null;
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function findSession(week, recordId) {
  for (const day of week.days) for (const s of day.sessions) if (s.record?.id === recordId) return s;
  return null;
}

// Sessions still to write (not past days unless asked).
function openSessions(week, today, includePast) {
  return week.days.filter((d) => includePast || d.date >= today).flatMap((d) => d.sessions.filter((s) => !s.record && !s.extra));
}

// ----------------------------------------------------------------- header

function meetBanners(ctx, week) {
  const { state, esc } = ctx;
  const out = [];
  const after = addDays(week.sunday, 7);
  const meets = (state.plan.meets || []).filter((m) => m.end >= week.monday && m.start <= after).sort((a, b) => (a.start < b.start ? -1 : 1));
  for (const m of meets) {
    const range = m.start === m.end ? longDate(m.start) : `${longDate(m.start)} – ${longDate(m.end)}`;
    if (m.start <= week.sunday) {
      const pre = week.days.find((d) => d.preMeet && addDays(d.date, 1) === m.start);
      out.push(`<div class="banner meet"><b>${esc(m.name)}</b><span>${esc(range)}${m.course ? ` · ${esc(m.course)}` : ''}. No practice on meet days${pre ? `; ${esc(weekdayLong(pre.date))} is one short sharpen session` : ''}.</span></div>`);
    } else {
      const n = daysBetween(week.sunday, m.start);
      out.push(`<div class="banner meet"><b>${esc(m.name)}</b><span>starts ${esc(longDate(m.start))}, ${n} day${n === 1 ? '' : 's'} after this week${m.course ? ` · ${esc(m.course)}` : ''}.</span></div>`);
    }
  }
  return out;
}

function stripHTML(ctx, week) {
  const { state, esc } = ctx;
  return `<div class="wk-strip" role="group" aria-label="Jump to a day">${week.days.map((day, i) => {
    const label = day.meet && !day.sessions.length ? 'Meet' : day.sessions.length ? '' : 'Rest';
    const aria = `${dayLabel(day.date)}: ${day.meet ? `${day.meet.name}. ` : ''}${day.sessions.map((s) => `${s.slot} ${STATUS[s.status].toLowerCase()}`).join(', ') || (day.meet ? '' : 'rest')}`;
    return `<button type="button" class="wk-strip-day ${day.date === state.today ? 'is-today' : ''} ${day.meet ? 'is-meet' : ''}" data-jump="${i}" aria-label="${esc(aria)}">
      <b>${WEEKDAYS[i]}</b><span>${parseISO(day.date).getDate()}</span>
      <span class="wk-dots">${label ? `<em>${label}</em>` : day.sessions.map((s) => `<i class="wk-dot st-${s.status}" title="${esc(`${s.slot} ${STATUS[s.status]}`)}"></i>`).join('')}</span>
    </button>`;
  }).join('')}</div>`;
}

function headHTML(ctx, week, totals, ui) {
  const { state, esc } = ctx;
  const { monday, sunday } = week;
  const thisWeek = monday === mondayOf(state.today);
  const year = parseISO(monday).getFullYear() !== parseISO(state.today).getFullYear() || parseISO(sunday).getFullYear() !== parseISO(state.today).getFullYear();
  const unit = state.plan.unit;
  const all = week.days.flatMap((d) => d.sessions);
  const count = (st) => all.filter((s) => s.status === st).length;
  const toDebrief = count('swum');
  const summary = [
    `<b>${totals.written}</b> of ${totals.planned} session${totals.planned === 1 ? '' : 's'} written${totals.extras ? ` + ${totals.extras} extra` : ''}`,
    totals.distance ? `<b>${fmtDistance(totals.distance, unit)}</b>${totals.targetYards ? ` of about ${fmtDistance(totals.targetYards, unit)}` : ''}` : '',
    toDebrief ? `<b>${toDebrief}</b> to debrief` : '',
    count('debriefed') ? `${count('debriefed')} debriefed` : '',
  ].filter(Boolean).join(' · ');
  const banners = meetBanners(ctx, week);
  if (state.planIsDefault) banners.push('<div class="banner"><span>This is the default plan. Set your dates, phases, meets and groups under <b>Season</b>.</span><button type="button" class="btn secondary small-btn" data-go="season">Season</button></div>');
  const open = openSessions(week, state.today, ui.past);
  const pastOpen = week.days.some((d) => d.date < state.today && d.sessions.some((s) => !s.record && !s.extra));
  return `<section class="card wk-head">
    <div class="wk-nav">
      <button type="button" class="icon-btn" id="wk-prev" aria-label="Previous week">‹</button>
      <button type="button" class="btn secondary small-btn" id="wk-now" ${thisWeek ? 'disabled' : ''}>This week</button>
      <button type="button" class="icon-btn" id="wk-next" aria-label="Next week">›</button>
      <label class="wk-jump">Go to<input type="date" id="wk-date" value="${esc(monday)}" aria-label="Go to the week of a date"></label>
    </div>
    <div class="eyebrow">${esc(relWeek(monday, state.today))}</div>
    <h2>${esc(`${shortDate(monday, year)} – ${shortDate(sunday, year)}`)}</h2>
    <p class="wk-pos">${esc(positionText(week.position))}</p>
    ${week.position.status === 'in' && week.position.phase?.description ? `<p class="small phase-desc">${esc(week.position.phase.description)}</p>` : ''}
    ${totals.planned || totals.extras ? `<p class="small wk-sum">${summary}</p>` : '<p class="small muted">No sessions in the plan this week.</p>'}
    ${stripHTML(ctx, week)}
    ${banners.length ? `<div class="wk-banners">${banners.join('')}</div>` : ''}
    ${open.length || ui.drafts || pastOpen ? `<div class="wk-draft-row">
      <button type="button" class="btn" id="wk-draft" ${open.length ? '' : 'disabled'}>${!open.length ? 'No open sessions left' : ui.drafts ? 'Draft again' : `Draft the ${open.length === 1 ? 'open session' : `${open.length} open sessions`}`}</button>
      ${pastOpen ? `<label class="field inline wk-past"><input type="checkbox" id="wk-past" ${ui.past ? 'checked' : ''}> Include past days</label>` : ''}
      <p class="muted small">A first draft of each from your library, varied across the week. You look them over before anything is saved.</p>
    </div>` : ''}
  </section>`;
}

// ------------------------------------------------------------------- days

function sessionHTML(ctx, day, s, i, ui) {
  const { state, esc } = ctx;
  const r = s.record;
  const key = `${i}:${s.slot}`;
  const viewing = r && ui.view === r.id;
  let actions = '';
  if (!r) {
    actions = `<button type="button" class="btn small-btn" data-write="${key}">Write</button>
      ${coachOn(ctx) ? `<button type="button" class="btn secondary small-btn" data-ask="${key}">Ask the coach</button>` : ''}`;
  } else {
    actions = `${s.status === 'swum' ? `<button type="button" class="btn small-btn" data-debrief="${esc(r.id)}">Debrief</button>` : ''}
      <button type="button" class="btn secondary small-btn" data-view="${esc(r.id)}" aria-expanded="${!!viewing}">${viewing ? 'Hide' : 'View'}</button>
      <button type="button" class="btn secondary small-btn" data-edit="${esc(r.id)}">Edit</button>
      ${s.status === 'debriefed' ? `<button type="button" class="btn secondary small-btn" data-debrief="${esc(r.id)}">Edit debrief</button>` : ''}`;
  }
  const gears = gearsText(s.focus);
  return `<div class="wk-s st-${s.status}">
    <div class="wk-s-top"><span class="wk-slot">${esc(s.slot)}${s.extra ? ' · extra' : ''}</span><span class="wk-pill st-${s.status}">${STATUS[s.status]}</span></div>
    <div class="wk-focus"><b>${esc(focusLabel(s.focus) || 'Practice')}</b>${gears ? ` <span class="muted">${esc(gears)}</span>` : ''}</div>
    <div class="muted small">${s.minutes ? `${s.minutes} min` : ''}${s.theme ? ` · ${esc(s.theme)}` : ''}${s.extra ? `${s.minutes ? ' · ' : ''}not in the plan` : ''}</div>
    ${s.note ? `<div class="small wk-note">${esc(s.note)}</div>` : ''}
    ${r ? `<div class="wk-written"><b>${esc(recordTitle(r))}</b>${inDoc(r, weekDocFor(state.plan, mondayOf(day.date))) ? '<span class="doc-tag" title="Added to the week\'s Google Doc">In doc</span>' : ''}<span class="muted small">~${fmtDistance(r.distance || 0, r.unit || state.plan.unit)} · ${r.minutes} min</span></div>` : ''}
    <div class="wk-actions">${actions}</div>
    ${viewing ? `<pre class="text wk-inline">${esc(r.text || '')}</pre>` : ''}
  </div>`;
}

function dayHTML(ctx, day, i, ui) {
  const { state, esc } = ctx;
  const today = day.date === state.today;
  const rest = !day.sessions.length && !day.meet;
  const cls = ['wk-day', today && 'is-today', day.meet && 'is-meet', rest && 'is-rest', day.date < state.today && 'is-past'].filter(Boolean).join(' ');
  const tags = [
    today ? '<span class="wk-tag today">Today</span>' : '',
    day.meet ? '<span class="wk-tag meet">Meet</span>' : '',
    day.preMeet ? '<span class="wk-tag pre">Pre-meet</span>' : '',
  ].join('');
  return `<section class="${cls}" id="wk-d-${i}" aria-label="${esc(longDate(day.date))}">
    <header class="wk-day-head"><b>${WEEKDAYS[i]}</b><span>${esc(shortDate(day.date))}</span>${tags ? `<span class="wk-tags">${tags}</span>` : ''}</header>
    ${day.meet ? `<p class="wk-meet small"><b>${esc(day.meet.name)}</b>${day.meet.course ? ` · ${esc(day.meet.course)}` : ''}<br><span class="muted">No practice</span></p>` : ''}
    ${day.sessions.length ? `<div class="wk-sessions">${day.sessions.map((s) => sessionHTML(ctx, day, s, i, ui)).join('')}</div>` : ''}
    ${rest ? '<p class="muted small wk-rest">Rest day</p>' : ''}
  </section>`;
}

// The practice text for wide screens, under the grid (columns are too
// narrow for set lines); phones show it inline in the session instead.
function viewerHTML(ctx, s) {
  const { esc } = ctx;
  const r = s.record;
  return `<section class="card wk-viewer" id="wk-viewer">
    <div class="wk-viewer-head"><div><div class="eyebrow">${esc(`${longDate(r.date)} · ${r.slot || 'AM'}`)}</div><h3>${esc(recordTitle(r))}</h3></div>
      <div class="wk-viewer-btns"><button type="button" class="btn secondary small-btn" data-copy="${esc(r.id)}">Copy</button><button type="button" class="btn secondary small-btn" data-view="${esc(r.id)}">Close</button></div></div>
    <pre class="text">${esc(r.text || '')}</pre>
  </section>`;
}

// ----------------------------------------------------------------- totals

function bandBar(shares, cls, label, ctx) {
  const parts = BANDS.map((b) => [b, shares[b.key] || 0]).filter(([, v]) => v > 0.0005);
  const aria = BANDS.map((b) => `${b.label} ${pct(shares[b.key])}%`).join(', ');
  return `<div class="wk-bar-row ${cls}"><span class="wk-bar-label">${label}</span>
    <div class="wk-stack" role="img" aria-label="${ctx.esc(`${label}: ${aria}`)}">${parts.map(([b, v]) => `<i class="wk-b-${b.key}" style="flex-grow:${v}" title="${ctx.esc(`${b.label} ${BAND_NAME[b.key]}: ${pct(v)}%`)}"></i>`).join('')}</div></div>`;
}

function totalsHTML(ctx, week, t, gaps) {
  const { state, esc } = ctx;
  const unit = state.plan.unit;
  const phase = week.phase;
  const tg = t.targets;
  const targetText = `${BANDS.map((b) => `${b.label} ${pct(tg[b.key])}%`).join(' · ')} · kick ${pct(tg.kick)}%`;
  const yardsNote = t.targetYards
    ? ''
    : `<p class="muted small wk-hint">No yardage target: set a hard week's ${unit === 'm' ? 'metres' : 'yards'} on the Season tab (plan basics) and each phase's volume scales it. <button type="button" class="btn secondary small-btn" data-go="season">Season</button></p>`;

  if (!t.written && !t.extras) {
    return `<section class="card wk-totals" id="wk-totals">
      <h3>The week in numbers</h3>
      ${t.planned ? `<p>Nothing written for this week yet (${t.planned} session${t.planned === 1 ? '' : 's'} in the plan). Write a session or draft the open ones; yards, gears, kick and CNS fill in as practices are saved.</p>
      <p class="muted small">Targets for ${esc(phase?.name || 'the week')}: ${t.targetYards ? `about ${fmtDistance(t.targetYards, unit)} · ` : ''}${esc(targetText)}.</p>
      ${yardsNote}` : '<p>No sessions in the plan this week (meet or rest days), so nothing to write or count.</p>'}
    </section>`;
  }

  // Yards against the phase target.
  const over = t.targetYards ? t.distance - t.targetYards : 0;
  const yards = t.targetYards ? `<div class="wk-stat">
      <div class="wk-stat-head"><span>${unit === 'm' ? 'Metres' : 'Yards'} written</span><span><b>${fmtDistance(t.distance, unit)}</b> of about ${fmtDistance(t.targetYards, unit)} · ${Math.round((t.distance / t.targetYards) * 100)}%</span></div>
      <div class="wk-meter" role="img" aria-label="${esc(`${fmtDistance(t.distance, unit)} of about ${fmtDistance(t.targetYards, unit)}`)}"><i style="width:${Math.min(100, (t.distance / t.targetYards) * 100)}%"></i></div>
      <p class="muted small">${esc(phase?.name || 'Phase')} at ${pct(phase?.volume ?? 1)}% of a ${fmtDistance(state.plan.weeklyYards, unit)} hard week${over > 0 ? ` · ${fmtDistance(over, unit)} over` : ''}.</p>
    </div>` : `<div class="wk-stat"><div class="wk-stat-head"><span>${unit === 'm' ? 'Metres' : 'Yards'} written</span><span><b>${fmtDistance(t.distance, unit)}</b></span></div></div>`;

  // Gear bands: written (stacked) over the target (thin), numbers in a table.
  const rows = BANDS.map((b) => {
    const have = t.share[b.key] || 0;
    const want = tg[b.key] ?? 0;
    const d = Math.round((have - want) * 100);
    const off = Math.abs(have - want) > 0.04;
    return `<tr><th scope="row"><i class="wk-sw wk-b-${b.key}" aria-hidden="true"></i>${esc(b.label)} <span class="muted">${esc(BAND_NAME[b.key])}</span></th>
      <td><b>${pct(have)}%</b> <span class="muted">${fmtDistance(t.bands[b.key] || 0, unit)}</span></td><td>${pct(want)}%</td>
      <td class="${off ? 'wk-off' : 'muted'}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}</td></tr>`;
  }).join('');
  const kickHave = t.kickShare;

  // CNS: points written each day, and what is left at 6:00 each morning.
  const max = Math.max(1, ...t.cnsByDay);
  const warn = week.days.flatMap((day, i) => {
    const left = t.cnsMorning[i];
    const hard = day.sessions.find((s) => HIGH_CNS.has(s.focus));
    return left > 5 && hard ? [`${WEEKDAYS[i]}: ${left} points left at 6:00 before the ${hard.slot} ${focusLabel(hard.focus).toLowerCase()} session`] : [];
  });
  const cns = `<div class="wk-cns" role="list">${week.days.map((day, i) => {
    const v = t.cnsByDay[i];
    const left = t.cnsMorning[i];
    const hi = left > 5 && day.sessions.some((s) => HIGH_CNS.has(s.focus));
    const label = day.meet && !day.sessions.length ? 'meet' : !day.sessions.length ? 'rest' : '';
    return `<div class="wk-cns-day" role="listitem" aria-label="${esc(`${WEEKDAYS[i]}: ${v} CNS points written, ${left} left at 6:00`)}">
      <div class="wk-cns-col"><i style="height:${v ? Math.max(4, (v / max) * 100) : 0}%"></i></div>
      <b>${v ? v : label ? `<span class="muted">${label}</span>` : '<span class="muted">0</span>'}</b>
      <span class="wk-cns-wd">${WEEKDAYS[i]}</span>
      <span class="wk-cns-left ${hi ? 'hi' : ''}">${left}</span>
    </div>`;
  }).join('')}</div>`;

  return `<section class="card wk-totals" id="wk-totals">
    <h3>The week in numbers</h3>
    <p class="muted small">${t.written} of ${t.planned} planned session${t.planned === 1 ? '' : 's'} written${t.extras ? ` + ${t.extras} extra` : ''} · ${Math.round(t.minutes / 6) / 10} h in the water${t.written < t.planned ? ' · shares below are of what is written so far' : ''}.</p>
    <div class="wk-totals-grid">
      <div>
        ${yards}
        ${yardsNote}
        <div class="wk-stat">
          <div class="wk-stat-head"><span>Gears</span><span class="muted small">written vs ${esc(phase?.name || 'phase')} target</span></div>
          ${bandBar(t.share, '', 'Written', ctx)}
          ${bandBar(tg, 'thin', 'Target', ctx)}
          <table class="wk-band-table"><thead><tr><th scope="col">Band</th><th scope="col">Written</th><th scope="col">Target</th><th scope="col"><span class="sr-only">Difference, points</span><span aria-hidden="true">±</span></th></tr></thead><tbody>${rows}</tbody></table>
        </div>
        <div class="wk-stat">
          <div class="wk-stat-head"><span>Kick</span><span><b>${pct(kickHave)}%</b> of ${unit === 'm' ? 'metres' : 'yards'} (${fmtDistance(t.kick, unit)}) · target ${pct(tg.kick)}%</span></div>
          <div class="wk-meter kick" role="img" aria-label="${esc(`Kick ${pct(kickHave)}% of ${unit === 'm' ? 'metres' : 'yards'}, target ${pct(tg.kick)}%`)}"><i style="width:${Math.min(100, kickHave * 100)}%"></i><b class="wk-tick" style="left:${Math.min(100, tg.kick * 100)}%" title="Target ${pct(tg.kick)}%"></b></div>
        </div>
      </div>
      <div>
        <div class="wk-stat">
          <div class="wk-stat-head"><span>Off target</span></div>
          ${gaps.length ? `<ul class="wk-gaps">${gaps.map((g) => `<li>${esc(g.text)}</li>`).join('')}</ul>` : `<p class="small">On target so far: every band and kick within 4 points of the plan.</p>`}
        </div>
        <div class="wk-stat">
          <div class="wk-stat-head"><span>CNS by day</span><span class="muted small">points written · left at 6:00</span></div>
          ${cns}
          <p class="muted small">Bars: CNS points written for the day. Under each: what is still left at 6:00 that morning from the sessions before it (half gone every ${ctx.learned.writing.model.cnsHalfLifeHours || 12} h).</p>
          ${warn.length ? `<div class="banner alert"><span>${warn.map(esc).join('. ')}. A high-CNS session wants under 5: keep the G5–G6 work short, give it more rest, or move it.</span></div>` : ''}
        </div>
      </div>
    </div>
  </section>`;
}

// ----------------------------------------------------------------- drafts

function draftsHTML(ctx, drafts) {
  const { state, esc } = ctx;
  const unit = state.plan.unit;
  const n = drafts.list.length;
  const checked = drafts.list.filter((d) => d.checked).length;
  return `<section class="card wk-drafts" id="wk-drafts">
    <div class="eyebrow">Drafts · not saved yet</div>
    <h3>${n ? `${n} session${n === 1 ? '' : 's'} drafted` : 'Nothing could be drafted'}</h3>
    ${n ? '<p class="muted small">Picked from your library for each session\'s focus and minutes, varied across the week and against the log. Tick the ones to keep, or open one in the builder to change it first.</p>' : ''}
    ${drafts.list.length ? `<ul class="wk-dlist">${drafts.list.map((d, k) => {
      const s = d.suggestion;
      const main = s.blocks.filter(isMain).map((b) => b.name);
      return `<li class="wk-d ${d.checked ? '' : 'is-off'}">
        <label class="wk-dcheck"><input type="checkbox" data-dk="${k}" ${d.checked ? 'checked' : ''} aria-label="${esc(`Keep ${dayLabel(d.date)} ${d.slot}`)}"></label>
        <div class="wk-dinfo">
          <div class="wk-dhead"><b>${esc(dayLabel(d.date))} · ${esc(d.slot)}</b><span>${esc(focusLabel(s.focus))}</span></div>
          <div class="small">${esc(main.join(', ') || s.blocks.map((b) => b.name).join(', '))}</div>
          <div class="muted small">${d.composed.minutes} min · ~${fmtDistance(d.composed.distance, unit)}${s.minutes && Math.abs(d.composed.minutes - s.minutes) > 10 ? ` (session ${s.minutes} min)` : ''}</div>
          <details class="wk-dmore" data-dmore="${k}" ${d.more ? 'open' : ''}><summary>Show the set</summary>${d.more ? practiceHTML(d.composed, ctx, { slot: d.slot, showDetail: false, carry: false }) : ''}</details>
        </div>
        <button type="button" class="btn secondary small-btn" data-dopen="${k}">Open in builder</button>
      </li>`;
    }).join('')}</ul>` : ''}
    ${drafts.skipped.length ? `<p class="muted small">Not drafted (nothing in the library fits): ${esc(drafts.skipped.join(', '))}. Add blocks for those focuses or write them one by one.</p>` : ''}
    ${drafts.equipment ? `<p class="muted small">Only blocks for the equipment you picked on Today: ${esc(drafts.equipment.length ? drafts.equipment.join(', ') : 'no equipment')}.</p>` : ''}
    <div class="actions">
      ${n ? `<button type="button" class="btn" id="wk-dsave" ${checked ? '' : 'disabled'}>Save ${checked === n ? (n === 1 ? 'it' : 'all') : checked} as written practice${checked === 1 ? '' : 's'}</button>` : ''}
      <button type="button" class="btn secondary" id="wk-ddiscard">${n ? 'Discard drafts' : 'Close'}</button>
    </div>
  </section>`;
}

function makeDrafts(ctx, week, ui) {
  const { state } = ctx;
  const equipment = Array.isArray(state.prefs.equipment) ? state.prefs.equipment : null;
  const list = draftWeek({ plan: state.plan, library: state.blocks, week, log: state.log, weights: ctx.learned.weights, today: state.today, includePast: ui.past, equipment });
  const got = new Set(list.map((d) => `${d.date}|${d.slot}`));
  const skipped = week.days.filter((d) => ui.past || d.date >= state.today)
    .flatMap((d) => d.sessions.filter((s) => !s.record && !s.extra && !got.has(`${d.date}|${s.slot}`)).map((s) => `${dayLabel(d.date)} ${s.slot} (${focusLabel(s.focus).toLowerCase()})`));
  ui.drafts = {
    monday: week.monday,
    equipment,
    skipped,
    list: list.map((d) => {
      const blocks = d.suggestion.blocks.map((b) => ({ ...b }));
      const s = { ...d.suggestion, blocks };
      return { date: d.date, slot: d.slot, suggestion: s, checked: true, more: false, composed: composePractice({ blocks, rounds: s.rounds, pattern: s.pattern, pace: state.plan.pace, unit: state.plan.unit }) };
    }),
  };
}

async function saveDrafts(ctx, ui) {
  const { state } = ctx;
  const todo = ui.drafts.list.filter((d) => d.checked);
  let saved = 0;
  let taken = 0;
  let failed = 0;
  for (const d of todo) {
    // Written meanwhile (another tab, the coach chat): leave it alone. Its
    // own record from a save that failed is saved again instead.
    if (state.log.some((r) => r.date === d.date && (r.slot || 'AM') === d.slot && r.id !== d.unsaved)) { taken += 1; d.done = true; continue; }
    const s = d.suggestion;
    const { blocks } = s;
    const circuit = blocks.some((b) => b.circuit);
    const composed = composePractice({ blocks, rounds: s.rounds, pattern: s.pattern, pace: state.plan.pace, unit: state.plan.unit });
    const position = sessionsOn(state.plan, d.date).position;
    const text = practiceTextFor(composed, ctx, { title: '', date: d.date, focus: s.focus, phase: position.phase?.name || '', slot: d.slot, showDetail: state.prefs.showDetail !== false });
    // Saved as Build saves (the app's send-offs as printed).
    const rec = savedRecord(ctx, { date: d.date, title: '', focus: s.focus, slot: d.slot, position, blocks, rounds: circuit ? s.rounds : 1, pattern: s.pattern, composed, text });
    if (d.unsaved) rec.id = d.unsaved;
    if (await ctx.save.log(rec)) { saved += 1; d.done = true; } else { failed += 1; d.unsaved = rec.id; }
  }
  // Not saved: the app says so and offers Try again; those drafts stay here.
  const left = ui.drafts.list.filter((d) => !d.done);
  ui.drafts = failed && left.length ? { ...ui.drafts, list: left } : null;
  updateDebriefDot();
  if (saved || taken) ctx.toast(`Saved ${saved} practice${saved === 1 ? '' : 's'} as written${taken ? ` · ${taken} already written, left as is` : ''}${failed ? ` · ${failed} not saved` : ''}`);
  ctx.rerender();
}

// ------------------------------------------------------------------ write

async function writeSession(ctx, day, s) {
  const { state } = ctx;
  const d = state.draft;
  if (d.blocks?.length && d.date === day.date && d.slot === s.slot && !d.replaces) {
    ctx.toast(`Back to the ${s.slot} draft for ${dayLabel(day.date)}`);
    ctx.go('build');
    return;
  }
  if (!(await replaceDraft(ctx, `a draft for ${dayLabel(day.date)} ${s.slot}`))) return;
  const sug = suggestPractice({ plan: state.plan, library: state.blocks, date: day.date, slot: s.slot, history: state.log, weights: ctx.learned.weights });
  state.draft = {
    date: day.date,
    slot: s.slot,
    title: '',
    focus: s.focus,
    blocks: sug.blocks.map((b) => ({ ...b, circuit: !!b.circuit, key: ctx.uid('k') })),
    rounds: Math.max(2, sug.rounds),
    pattern: sug.pattern || 'even',
    back: 'week',
  };
  if (!sug.blocks.length && sug.notes[0]) ctx.toast(sug.notes[0]);
  ctx.go('build');
}

function askCoach(ctx, day, s) {
  const { state } = ctx;
  const gears = (FOCUSES[s.focus]?.gears || []).join(', ');
  const parts = [
    `Write the ${s.slot} practice for ${longDate(day.date)} (${day.date}): ${s.minutes} min, ${focusLabel(s.focus).toLowerCase()}${gears ? ` (${gears})` : ''}${s.theme ? `, theme: ${s.theme}` : ''}.`,
  ];
  if (s.note) parts.push(`${s.note}.`);
  parts.push('Fit it to the rest of the week: what is already written and the gear targets.');
  state.chat.pending = parts.join(' ');
  state.chat.pendingSlot = s.slot;
  state.chat.pendingDate = day.date;
  ctx.go('coach');
}

async function editRecord(ctx, r, debriefed) {
  const { state } = ctx;
  // Already editing this one in the builder: carry on there.
  if (state.draft.replaces === r.id && state.draft.blocks?.length) { ctx.go('build'); return; }
  if (debriefed && !(await ctx.confirmAction('This practice has a debrief. Edit the written practice anyway? The debrief stays as it is.', 'Edit', { danger: false }))) return;
  if (!(await replaceDraft(ctx, `the ${dayLabel(r.date)} ${r.slot || 'AM'} practice`))) return;
  // As the Log's "Build again": library blocks when they still exist, else
  // the saved copy; kept on its own date and slot, replacing it on save.
  let missing = 0;
  const blocks = (r.blocks || []).map((rb) => {
    const { block, missing: gone } = draftBlock(ctx, rb);
    if (gone) missing += 1;
    return block;
  });
  state.draft = { date: r.date, slot: r.slot || 'AM', title: r.title || '', focus: r.focus || null, rounds: r.rounds > 1 ? r.rounds : 3, pattern: r.pattern || 'even', blocks, replaces: r.id, back: 'week' };
  if (missing) ctx.toast(`${missing} block${missing === 1 ? ' is' : 's are'} no longer in the library; using the saved copy`);
  ctx.go('build');
}

async function debriefRecord(ctx, r, debrief) {
  if (await openDebrief(ctx, r, debrief)) ctx.go('debrief');
}

// ------------------------------------------------------------------- bind

function bind(ctx, el, week, ui) {
  const { state, $, $$ } = ctx;
  const rr = () => ctx.rerender();
  const show = (monday) => { state.ui.week = mondayOf(monday); ui.view = null; rr(); };
  const session = (key) => {
    const [i, slot] = key.split(':');
    const day = week.days[+i];
    return day ? [day, day.sessions.find((s) => s.slot === slot && !s.record)] : [null, null];
  };
  const rec = (id) => findSession(week, id);
  bindDocCard(ctx, el, week);

  $('#wk-prev', el).onclick = () => show(addDays(week.monday, -7));
  $('#wk-next', el).onclick = () => show(addDays(week.monday, 7));
  $('#wk-now', el).onclick = () => show(state.today);
  $('#wk-date', el).onchange = (e) => { if (ISO.test(e.target.value)) show(e.target.value); };
  $$('[data-go]', el).forEach((b) => { b.onclick = () => ctx.go(b.dataset.go); });
  $$('[data-jump]', el).forEach((b) => { b.onclick = () => $(`#wk-d-${b.dataset.jump}`, el)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });

  $$('[data-write]', el).forEach((b) => {
    b.onclick = () => { const [day, s] = session(b.dataset.write); if (s) writeSession(ctx, day, s); };
  });
  $$('[data-ask]', el).forEach((b) => {
    b.onclick = () => { const [day, s] = session(b.dataset.ask); if (s) askCoach(ctx, day, s); };
  });
  $$('[data-view]', el).forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.view;
      ui.view = ui.view === id ? null : id;
      if (ui.view && window.matchMedia?.('(min-width: 1000px)').matches) state.ui.wkScroll = '#wk-viewer';
      rr();
    };
  });
  $$('[data-copy]', el).forEach((b) => { b.onclick = () => ctx.copyText(rec(b.dataset.copy)?.record?.text || ''); });
  $$('[data-edit]', el).forEach((b) => {
    b.onclick = () => { const s = rec(b.dataset.edit); if (s) editRecord(ctx, s.record, !!s.debrief); };
  });
  $$('[data-debrief]', el).forEach((b) => {
    b.onclick = () => { const s = rec(b.dataset.debrief); if (s) debriefRecord(ctx, s.record, s.debrief); };
  });

  // Drafting the week.
  const past = $('#wk-past', el);
  if (past) past.onchange = () => { ui.past = past.checked; if (ui.drafts) makeDrafts(ctx, week, ui); rr(); };
  const draft = $('#wk-draft', el);
  if (draft) {
    draft.onclick = () => {
      makeDrafts(ctx, week, ui);
      state.ui.wkScroll = '#wk-drafts';
      rr();
    };
  }
  if (ui.drafts) {
    $$('[data-dk]', el).forEach((c) => { c.onchange = () => { ui.drafts.list[+c.dataset.dk].checked = c.checked; rr(); }; });
    $$('[data-dmore]', el).forEach((det) => {
      det.ontoggle = () => {
        const d = ui.drafts?.list[+det.dataset.dmore];
        if (d && d.more !== det.open) { d.more = det.open; rr(); }
      };
    });
    $$('[data-dopen]', el).forEach((b) => {
      b.onclick = async () => {
        const d = ui.drafts.list[+b.dataset.dopen];
        if (!d || !(await replaceDraft(ctx, `the draft for ${dayLabel(d.date)} ${d.slot}`))) return;
        const s = d.suggestion;
        state.draft = { date: d.date, slot: d.slot, title: '', focus: s.focus, blocks: s.blocks.map((x) => ({ ...x, key: ctx.uid('k') })), rounds: Math.max(2, s.rounds), pattern: s.pattern || 'even', back: 'week' };
        ui.drafts.list.splice(+b.dataset.dopen, 1);
        if (!ui.drafts.list.length) ui.drafts = null;
        ctx.go('build');
      };
    });
    const save = $('#wk-dsave', el);
    if (save) save.onclick = async () => { save.disabled = true; save.textContent = 'Saving…'; await saveDrafts(ctx, ui); };
    $('#wk-ddiscard', el).onclick = () => { ui.drafts = null; rr(); };
  }
}
