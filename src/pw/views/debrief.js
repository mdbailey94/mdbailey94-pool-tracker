// Debrief: the coach's feedback loop. After a practice, go through it block
// by block (how it went and why, what changed, the intervals, send-offs
// made, goal times, drills) and the app learns from it: send-offs per gear
// and stroke, which blocks come up more or less, and notes that come back
// the next time a block is used.

import { CATEGORIES, CATEGORY_GEAR, FOCUSES, longDate } from '../../practice.js';
import {
  DRILLS, GOALS, INTERVALS, MADE, VERDICTS, blockScores, blockTiming, debriefSummary, intervalCalibration, withTiming,
  learnedFrom, makeDebrief, sectionTouched,
} from '../../learn.js';
import { blockLines, focusLabel, linesHTML } from '../render.js';
import { debriefTouched, startDebrief } from '../guards.js';
import { updateDebriefDot } from '../app.js';

const opts = (table) => Object.entries(table);
// debriefSummary without the leading "4/5" (the stars show it).
export const summaryText = (d) => debriefSummary(d).replace(/^\d\/5( · )?/, '') || 'Overall only';
const stars = (n) => (n ? `${'★'.repeat(n)}${'☆'.repeat(5 - n)}` : '');
const recordFor = (state, d) => state.log.find((r) => r.id === d.practiceId) || null;
const titleOf = (r) => r?.title || (r?.focus ? `${focusLabel(r.focus)} ${r.slot === 'PM' ? 'double' : 'practice'}` : 'Practice');

// Blocks with no gear of their own still get one from their category, so
// "intervals too hard" on an aerobic block moves G2 send-offs. A debrief
// saved before sections kept their timing gets the gears its block's lines
// are timed in.
function fillGears(d, rec) {
  for (const s of d.sections) {
    const rb = rec?.blocks?.[s.index];
    if (rb && !s.timing?.length) Object.assign(s, blockTiming(rb));
    if (s.gear) continue;
    if (rb) s.gear = rb.gears?.[0] || CATEGORY_GEAR[rb.category] || null;
  }
}

// ------------------------------------------------------------------ list

function listHTML(ctx) {
  const { state, esc } = ctx;
  const ui = state.ui.debrief || {};
  const done = new Set(state.debriefs.map((d) => d.practiceId));
  const todo = state.log.filter((r) => r.date <= state.today && !done.has(r.id));
  const later = state.log.filter((r) => r.date > state.today && !done.has(r.id)).length;
  const recent = ui.all ? state.debriefs : state.debriefs.slice(0, 8);
  const res = state.ui.debriefResult;
  const cal = ctx.learned.calibration || {};
  const calLines = Object.entries(cal).sort().flatMap(([g, by]) => Object.entries(by).map(([st, v]) => `${g}${st === 'all' ? '' : ` ${st}`}: ${v > 0 ? '+' : ''}${v}s per 100`));
  // Only main-set blocks are picked by weight (warm-ups and cool-downs by length).
  const isMain = (id) => { const b = state.blocks.find((x) => x.id === id); return !b || CATEGORIES[b.category]?.main; };
  const weights = Object.entries(ctx.learned.weights || {}).filter(([id, w]) => Math.abs(w - 1) >= 0.05 && isMain(id));
  const nameOf = (id) => state.blocks.find((b) => b.id === id)?.name || state.debriefs.flatMap((d) => d.sections).find((s) => s.blockId === id)?.name || 'A block';
  const up = weights.filter(([, w]) => w > 1).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const down = weights.filter(([, w]) => w < 1).sort((a, b) => a[1] - b[1]).slice(0, 4);
  const unit = state.plan.unit;

  return `
    ${res ? `<section class="card b-learned" id="debrief-result">
      <div class="eyebrow">Debrief saved</div>
      <h3>${esc(res.title)}</h3>
      ${res.lines.length ? `<ul class="b-list">${res.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="muted">Nothing in the send-offs or block choices moved this time. It adds up over a few debriefs.</p>'}
      <div class="actions"><button type="button" class="btn secondary" id="res-ok">OK</button></div>
    </section>` : ''}

    <section class="card">
      <h2>Debrief</h2>
      <p class="muted small">How did it go? Rate each set and say why, what you changed, how the intervals and goal times were, and whether the drills worked. Send-offs, block choices and notes for next time come from this.</p>
      <h3>Waiting for a debrief</h3>
      <div class="rows">
        ${todo.length ? todo.map((r) => `<div class="brow">
          <div class="info"><div class="name">${esc(longDate(r.date))} · ${esc(r.slot || 'AM')}</div>
            <div class="meta">${esc(titleOf(r))}${r.focus && r.title ? ` · ${esc(focusLabel(r.focus))}` : ''} · ≈ ${r.minutes} min · ~${Math.round(r.distance || 0).toLocaleString('en-US')}${esc(r.unit || unit)}</div></div>
          <div class="ctl"><button type="button" class="btn small-btn" data-start="${esc(r.id)}">Debrief</button></div>
        </div>`).join('') : `<p class="muted">All caught up.${state.log.length ? '' : ' Save a practice from Build or Today, then debrief it after the swim.'}</p>`}
      </div>
      ${later ? `<p class="muted small">${later} saved practice${later === 1 ? '' : 's'} for later days will show here on the day.</p>` : ''}
    </section>

    ${state.debriefs.length ? `<section class="card">
      <h3>Recent debriefs</h3>
      <div class="rows">
        ${recent.map((d) => {
          const r = recordFor(state, d);
          return `<div class="brow">
            <div class="info"><div class="name">${esc(longDate(d.date))} · ${esc(d.slot || 'AM')}${d.overall ? ` <span class="b-stars-sm" aria-label="${d.overall} out of 5">${stars(d.overall)}</span>` : ''}</div>
              <div class="meta">${esc(titleOf(r))}${r ? '' : ' (no longer in the log)'}</div>
              <div class="meta b-clamp">${esc(summaryText(d))}</div></div>
            <div class="ctl"><button type="button" class="btn secondary small-btn" data-edit="${esc(d.id)}">Edit</button></div>
          </div>`;
        }).join('')}
      </div>
      ${state.debriefs.length > recent.length || ui.all ? `<div class="actions"><button type="button" class="btn secondary small-btn" id="d-all">${ui.all ? 'Show fewer' : `Show all ${state.debriefs.length}`}</button></div>` : ''}
    </section>` : ''}

    ${calLines.length || up.length || down.length ? `<section class="card">
      <h3>What the debriefs have taught it</h3>
      ${calLines.length ? `<p class="small"><b>Send-offs</b> (added to the gear chart's)</p><ul class="b-list small">${calLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${up.length ? `<p class="small"><b>Comes up more</b>: ${up.map(([id, w]) => `${esc(nameOf(id))} (×${w})`).join(', ')}</p>` : ''}
      ${down.length ? `<p class="small"><b>Comes up less</b>: ${down.map(([id, w]) => `${esc(nameOf(id))} (×${w})`).join(', ')}</p>` : ''}
      <p class="muted small">Recent debriefs count most; one three weeks old counts half.</p>
    </section>` : ''}
  `;
}

function bindList(ctx, el) {
  const { state, $, $$ } = ctx;
  $$('[data-start]', el).forEach((b) => {
    b.onclick = () => {
      const r = state.log.find((x) => x.id === b.dataset.start);
      if (!r) return;
      startDebrief(state, r);
      ctx.rerender();
      window.scrollTo({ top: 0 });
    };
  });
  $$('[data-edit]', el).forEach((b) => {
    b.onclick = () => {
      const d = state.debriefs.find((x) => x.id === b.dataset.edit);
      if (!d) return;
      startDebrief(state, d);
      ctx.rerender();
      window.scrollTo({ top: 0 });
    };
  });
  $('#d-all', el)?.addEventListener('click', () => { state.ui.debrief = { ...(state.ui.debrief || {}), all: !state.ui.debrief?.all }; ctx.rerender(); });
  $('#res-ok', el)?.addEventListener('click', () => { state.ui.debriefResult = null; ctx.rerender(); });
}

// ---------------------------------------------------------------- editor

function sectionHTML(ctx, d, s, i, rec) {
  const { esc, chips } = ctx;
  const rb = rec?.blocks?.[s.index] || null;
  // The set as it was saved (and swum): the send-offs the app printed that
  // day, not re-timed with what the debriefs have taught it since. Only a
  // line saved without a send-off (the coach's own) gets one filled in.
  const lines = rb?.lines?.length ? blockLines({ ...rb, source: 'saved' }, ctx, null, d.slot) : [];
  const unit = rec?.unit || ctx.state.plan.unit;
  const tag = [s.gear, s.stroke && s.stroke !== 'choice' ? s.stroke : '', rb?.circuit ? 'in the circuit' : ''].filter(Boolean).join(' · ');
  const planned = s.plannedDistance ? `~${s.plannedDistance.toLocaleString('en-US')}${unit} written` : '';
  const c = (field, table) => chips(`${field}.${i}`, opts(table), s[field]);
  // Sets nobody has said anything about stay short: the verdict, then the
  // rest of the questions once there is one (or on "More").
  const open = sectionTouched(s) || !!d._open?.[i];
  return `<section class="card b-sec ${s.skipped ? 'skipped' : ''}" data-sec="${i}">
    <div class="b-sec-head">
      <div class="info"><div class="eyebrow">Set ${i + 1}${tag ? ` · ${esc(tag)}` : ''}</div><h3>${esc(s.name || `Set ${i + 1}`)}</h3>${planned ? `<div class="muted small">${esc(planned)}</div>` : ''}</div>
      <label class="field inline b-skip"><input type="checkbox" data-skip="${i}" ${s.skipped ? 'checked' : ''}> Skipped</label>
    </div>
    ${lines.length ? `<details class="b-set"><summary>The set as written</summary>${linesHTML(lines)}</details>` : ''}
    ${s.skipped ? '' : `<div class="q"><span>How did it go?</span>${c('verdict', VERDICTS)}</div>`}
    ${open ? `
    <label class="q"><span>${s.skipped ? 'Why was it skipped?' : 'Why?'}</span><textarea data-f="why" data-i="${i}" rows="2" placeholder="${s.skipped ? 'e.g. ran out of time, pool closed early' : 'e.g. good energy, held their gears; or too long, lost focus by RD3'}">${esc(s.why)}</textarea></label>
    <label class="q"><span>What did you change?</span><textarea data-f="changed" data-i="${i}" rows="2" placeholder="e.g. went 3 rounds not 4; cut a rep for the slowest group">${esc(s.changed)}</textarea></label>
    ${s.skipped ? '' : `<div class="b-qgrid">
      <div class="q"><span>Intervals</span>${c('intervals', INTERVALS)}</div>
      <div class="q"><span>Made the send-offs</span>${c('made', MADE)}</div>
      <div class="q"><span>Goal times</span>${c('goal', GOALS)}<input type="text" data-f="times" data-i="${i}" value="${esc(s.times)}" placeholder="Times, e.g. 1:02-1:04 on the 100s" aria-label="Goal times for ${esc(s.name)}"></div>
      <div class="q"><span>Drills &amp; focus</span>${c('drills', DRILLS)}</div>
      <label class="q b-dist"><span>Actual distance (${esc(unit)})</span><input type="number" inputmode="numeric" min="0" step="25" data-f="actualDistance" data-i="${i}" value="${s.actualDistance ?? ''}" placeholder="${s.plannedDistance ?? ''}"></label>
    </div>`}` : `<button type="button" class="btn secondary small-btn b-more" data-more="${i}">Why, changes, intervals, goal times, drills…</button>`}
  </section>`;
}

function editorHTML(ctx, d, rec, existing) {
  const { esc } = ctx;
  return `
    <section class="card">
      <div class="eyebrow">${esc([longDate(d.date), d.slot, rec?.phase, rec?.focus && FOCUSES[rec.focus] ? focusLabel(rec.focus) : ''].filter(Boolean).join(' · '))}</div>
      <h2>${existing ? 'Edit debrief' : 'Debrief'}: ${esc(titleOf(rec))}</h2>
      ${rec ? `<p class="muted small">Written ≈ ${rec.minutes} min · ~${Math.round(rec.distance || 0).toLocaleString('en-US')}${esc(rec.unit || ctx.state.plan.unit)} · ${d.sections.length} set${d.sections.length === 1 ? '' : 's'}</p>` : '<p class="muted small">This practice is no longer in the log; the feedback still counts.</p>'}
      <div class="q"><span>Overall</span>
        <div class="stars" role="group" aria-label="Overall, 1 to 5">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="b-star ${d.overall >= n ? 'on' : ''}" data-star="${n}" aria-pressed="${d.overall === n}" aria-label="${n} of 5">★</button>`).join('')}</div>
      </div>
    </section>
    ${d.sections.length ? d.sections.map((s, i) => sectionHTML(ctx, d, s, i, rec)).join('') : '<section class="card"><p class="muted">This practice has no sets to go through; add your notes below.</p></section>'}
    <section class="card">
      <label class="q"><span>Notes on the whole practice</span><textarea id="d-notes" rows="3" placeholder="e.g. group was tired from the double; pool was warm">${esc(d.notes)}</textarea></label>
      <div class="actions">
        <button type="button" class="btn" id="d-save">Save debrief</button>
        <button type="button" class="btn secondary" id="d-cancel">Cancel</button>
        ${existing ? '<button type="button" class="btn secondary danger" id="d-del">Delete</button>' : ''}
      </div>
    </section>`;
}

// What this debrief changed, in words.
function whatChanged(ctx, before, after, wBefore, wAfter, d) {
  const out = learnedFrom(before, after);
  const seen = new Set();
  for (const s of d.sections) {
    if (!s.blockId || seen.has(s.blockId)) continue;
    seen.add(s.blockId);
    const lib = ctx.state.blocks.find((b) => b.id === s.blockId);
    if (lib && !CATEGORIES[lib.category]?.main) continue;
    const a = wBefore[s.blockId] ?? 1;
    const b = wAfter[s.blockId] ?? 1;
    if (Math.abs(b - a) < 0.02) continue;
    out.push(`${s.name} will come up ${b > a ? 'more' : 'less'} often.`);
  }
  const noted = d.sections.filter((s) => s.blockId && (s.why || s.changed || s.times || s.verdict)).length;
  if (noted) out.push(`Your notes on ${noted} set${noted === 1 ? '' : 's'} will show the next time ${noted === 1 ? 'it comes' : 'they come'} up.`);
  return out;
}

function bindEditor(ctx, el, d, rec, existing) {
  const { state, $, $$ } = ctx;
  const rr = () => ctx.rerender();

  ctx.bindChips(el, (name, value) => {
    const [field, i] = name.split('.');
    const s = d.sections[+i];
    if (s && field in s) s[field] = value;
    rr();
  });
  $$('[data-star]', el).forEach((b) => { b.onclick = () => { const n = +b.dataset.star; d.overall = d.overall === n ? null : n; rr(); }; });
  $$('[data-skip]', el).forEach((b) => { b.onchange = () => { d.sections[+b.dataset.skip].skipped = b.checked; rr(); }; });
  $$('[data-more]', el).forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.more;
      d._open = { ...(d._open || {}), [i]: true };
      rr();
      el.querySelector(`textarea[data-i="${i}"]`)?.focus();
    };
  });
  $$('[data-f]', el).forEach((inp) => {
    inp.oninput = () => {
      const s = d.sections[+inp.dataset.i];
      if (!s) return;
      if (inp.dataset.f === 'actualDistance') s.actualDistance = inp.value === '' ? null : Math.max(0, Math.round(+inp.value) || 0);
      else s[inp.dataset.f] = inp.value;
    };
  });
  $('#d-notes', el).oninput = (e) => { d.notes = e.target.value; };

  $('#d-save', el).onclick = async (e) => {
    e.target.disabled = true;
    const before = ctx.learned.calibration || {};
    const wBefore = ctx.learned.weights || {};
    const clean = makeDebrief(d);
    // Not saved: the app says so and offers Try again; the debrief stays open.
    if (!(await ctx.save.debrief(clean))) {
      updateDebriefDot();
      rr();
      return;
    }
    const after = intervalCalibration(withTiming(state.debriefs, state.log), state.today);
    const wAfter = blockScores(state.debriefs, state.today);
    state.ui.debriefResult = { title: `${longDate(clean.date)} · ${clean.slot} · ${titleOf(rec)}`, lines: whatChanged(ctx, before, after, wBefore, wAfter, clean) };
    state.debriefing = null;
    updateDebriefDot();
    ctx.toast('Debrief saved');
    rr();
    window.scrollTo({ top: 0 });
  };
  $('#d-cancel', el).onclick = async () => {
    if (!existing && debriefTouched(d) && !(await ctx.confirmAction('Throw away this debrief?', 'Discard'))) return;
    state.debriefing = null;
    rr();
  };
  $('#d-del', el)?.addEventListener('click', async () => {
    if (!(await ctx.confirmAction('Delete this debrief? What the app learned from it goes too.', 'Delete'))) return;
    // Not saved: the app says so and offers Try again (it stays off the list).
    const saved = await ctx.save.removeDebrief(d.id);
    state.debriefing = null;
    updateDebriefDot();
    if (saved) ctx.toast('Debrief deleted');
    rr();
  });
}

export function render(ctx, el) {
  const { state } = ctx;
  const d = state.debriefing;
  if (!d) {
    el.innerHTML = listHTML(ctx);
    bindList(ctx, el);
    return;
  }
  d.sections ||= [];
  const rec = recordFor(state, d);
  fillGears(d, rec);
  const existing = state.debriefs.some((x) => x.id === d.id);
  el.innerHTML = editorHTML(ctx, d, rec, existing);
  bindEditor(ctx, el, d, rec, existing);
}
