// Log: what the group has swum. Totals for the last 7 and 28 days, how the
// last week's distance splits across the gears, and every saved practice
// with its debrief (written vs actually swum), ready to view, copy, build
// again or debrief.

import { CATEGORY_GEAR, addDays, daysBetween, fmtDistance, logSummary, longDate, mondayOf } from '../../practice.js';
import { actualTotals } from '../../learn.js';
import { gearYards, parseSet } from '../../setlang.js';
import { focusLabel } from '../render.js';
import { draftBlock } from '../load.js';
import { openDebrief, replaceDraft } from '../guards.js';
import { updateDebriefDot } from '../app.js';
import { summaryText } from './debrief.js';
import { addToDoc, docBusy, inDoc, weekDocFor } from '../doc-card.js';

// Gear bands for the distribution, easiest first (an ordinal ramp: one hue,
// light → dark; the colours live in practice-b.css).
const BANDS = [
  { key: 'aer', label: 'G1–G2', name: 'aerobic', match: (n) => n <= 2 },
  { key: 'thr', label: 'G3–G3.5', name: 'threshold', match: (n) => n === 3 },
  { key: 'vo2', label: 'G4–G4.5', name: '1000 pace / VO2', match: (n) => n === 4 },
  { key: 'spd', label: 'G5–G6', name: 'race / speed', match: (n) => n >= 5 },
];
const PAGE = 20;

// Distance by gear over the last `days` days. A block with set lines counts
// the yards in its lines in their gears (a G3 → G6 build counts in each gear,
// as the practice preview and the Week do, also for practices saved with a
// minutes estimate); one without lines counts its distance in its first gear.
function gearTotalsByLines(log, today, days = 7) {
  const out = {};
  const add = (g, y) => { out[g] = (out[g] || 0) + y; };
  for (const r of log) {
    const age = daysBetween(r.date, today);
    if (age < 0 || age >= days) continue;
    for (const b of r.blocks || []) {
      const split = b.lines?.length ? gearYards(parseSet(b.lines.join('\n'))) : {};
      const sum = Object.values(split).reduce((a, y) => a + y, 0);
      if (sum) Object.entries(split).forEach(([g, y]) => add(g, y));
      else add((b.gears && b.gears[0]) || CATEGORY_GEAR[b.category] || 'G2', b.distance || 0);
    }
  }
  return out;
}

const hours = (min) => `${Math.round((min || 0) / 6) / 10}h`;
const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);

function gearHTML(ctx) {
  const { state, esc } = ctx;
  const totals = gearTotalsByLines(state.log, state.today, 7);
  const sums = BANDS.map(() => 0);
  for (const [g, y] of Object.entries(totals)) {
    const n = +(/^G(\d)/.exec(g)?.[1] || 2);
    sums[Math.max(0, BANDS.findIndex((b) => b.match(n)))] += y;
  }
  const total = sums.reduce((a, b) => a + b, 0);
  const unit = state.plan.unit;
  if (!total) return '<p class="muted small">No saved practices in the last 7 days.</p>';
  // Percentages that add up to 100 (largest remainder).
  const exact = sums.map((v) => (v / total) * 100);
  const p = exact.map(Math.floor);
  exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).slice(0, 100 - p.reduce((a, b) => a + b, 0)).forEach(([, i]) => { p[i] += 1; });
  return `<div class="b-gearbar" role="img" aria-label="${esc(BANDS.map((b, i) => `${b.label} ${p[i]}%`).join(', '))}">
      ${BANDS.map((b, i) => (sums[i] ? `<i class="b-g-${b.key}" style="flex-grow:${sums[i]}" title="${esc(`${b.label} ${b.name}: ${fmtDistance(sums[i], unit)} (${p[i]}%)`)}"></i>` : '')).join('')}
    </div>
    <ul class="b-gearlegend">
      ${BANDS.map((b, i) => `<li><i class="b-g-${b.key}" aria-hidden="true"></i><span><b>${esc(b.label)}</b> ${esc(b.name)}</span><span class="b-num">${fmtDistance(sums[i], unit)} · <b>${p[i]}%</b></span></li>`).join('')}
    </ul>`;
}

function recordHTML(ctx, r, debrief, open) {
  const { state, esc } = ctx;
  const unit = r.unit || state.plan.unit;
  const act = actualTotals(r, debrief);
  const title = r.title || (r.blocks || []).map((b) => b.name).join(', ') || 'Practice';
  const due = r.date <= state.today;
  return `<section class="card b-rec" data-rec="${esc(r.id)}">
    <div class="b-rec-top"><div class="eyebrow">${esc([longDate(r.date), r.slot || 'AM', r.phase, r.focus ? focusLabel(r.focus) : ''].filter(Boolean).join(' · '))}</div>
      <button type="button" class="icon-btn danger b-del" data-del="${esc(r.id)}" aria-label="Delete this practice" title="Delete">✕</button></div>
    <div class="b-rec-head"><b>${esc(title)}</b><span class="muted small">≈ ${r.minutes} min · ~${fmtDistance(r.distance || 0, unit)}</span></div>
    ${debrief && act.changed ? `<p class="small b-actual">Swum ≈ ${act.minutes} min · ~${fmtDistance(act.distance, unit)} <span class="muted">(${act.distance < r.distance ? `${fmtDistance(r.distance - act.distance, unit)} less` : `${fmtDistance(act.distance - r.distance, unit)} more`} than written)</span></p>` : ''}
    ${debrief ? `<div class="b-debriefed"><span class="b-check" aria-hidden="true">✓</span><div><b>Debriefed</b>${debrief.overall ? ` · ${debrief.overall}/5` : ''}<div class="muted small b-clamp">${esc(summaryText(debrief))}</div></div></div>`
      : due ? '<p class="small muted">Not debriefed yet.</p>' : '<p class="small muted">Planned. Debrief it after the swim.</p>'}
    ${open ? `<pre class="text">${esc(r.text || '')}</pre>` : ''}
    <div class="actions b-rec-actions">
      ${debrief ? `<button type="button" class="btn secondary small-btn" data-debrief="${esc(r.id)}">Edit debrief</button>` : due ? `<button type="button" class="btn small-btn" data-debrief="${esc(r.id)}">Debrief →</button>` : ''}
      <button type="button" class="btn secondary small-btn" data-open="${esc(r.id)}" aria-expanded="${open}">${open ? 'Hide' : 'View'}</button>
      <button type="button" class="btn secondary small-btn" data-copy="${esc(r.id)}">Copy</button>
      <button type="button" class="btn secondary small-btn" data-again="${esc(r.id)}">Build again</button>
      ${!ctx.isArtifact ? '' : inDoc(r, weekDocFor(state.plan, mondayOf(r.date))) ? '<span class="doc-tag" title="Added to the week\'s Google Doc">In doc</span>'
        : `<button type="button" class="btn secondary small-btn" data-doc="${esc(r.id)}" ${docBusy() ? 'disabled' : ''}>${docBusy() ? 'Adding…' : 'Add to Google Doc'}</button>`}
    </div>
  </section>`;
}

export function render(ctx, el) {
  const { state, esc, $, $$ } = ctx;
  const { log, plan } = state;
  const ui = (state.ui.log ||= {});
  ui.limit ||= PAGE;
  const unit = plan.unit;
  const debriefOf = new Map(state.debriefs.map((d) => [d.practiceId, d]));
  const week = logSummary(log, state.today, 7);
  const month = logSummary(log, state.today, 28);
  const swum7 = log.filter((r) => r.date <= state.today && r.date > addDays(state.today, -7))
    .reduce((s, r) => s + (actualTotals(r, debriefOf.get(r.id)).distance || 0), 0);
  const shown = log.slice(0, ui.limit);
  // Show the practice just saved from Build even if it is past the first page.
  if (ui.open && !shown.some((r) => r.id === ui.open)) {
    const i = log.findIndex((r) => r.id === ui.open);
    if (i >= 0) { ui.limit = i + 1; shown.push(...log.slice(shown.length, i + 1)); }
  }

  el.innerHTML = `
    <section class="card">
      <h2>Log</h2>
      <div class="stats">
        <div><b>${week.sessions}</b><span>sessions, 7 days</span></div>
        <div><b>${hours(week.minutes)}</b><span>hours, 7 days</span></div>
        <div><b>${fmtDistance(week.distance, unit)}</b><span>written, 7 days</span></div>
      </div>
      ${swum7 && swum7 !== week.distance ? `<p class="small">Swum after debriefs: <b>${fmtDistance(swum7, unit)}</b> of the ${fmtDistance(week.distance, unit)} written.</p>` : ''}
      <p class="muted small">Last 28 days: ${month.sessions} session${month.sessions === 1 ? '' : 's'} · ${hours(month.minutes)} · ${fmtDistance(month.distance, unit)}.</p>
    </section>

    <section class="card">
      <h3>Gears, last 7 days</h3>
      ${gearHTML(ctx)}
    </section>

    ${shown.length ? shown.map((r) => recordHTML(ctx, r, debriefOf.get(r.id), ui.open === r.id)).join('') : '<section class="card"><p class="muted">Nothing saved yet. Build a practice and save it here.</p></section>'}
    ${log.length > shown.length ? `<div class="actions"><button type="button" class="btn secondary" id="l-more">Show older (${log.length - shown.length} more)</button></div>` : ''}
  `;

  const rr = () => ctx.rerender();
  const find = (id) => log.find((r) => r.id === id);

  $$('[data-open]', el).forEach((b) => { b.onclick = () => { ui.open = ui.open === b.dataset.open ? null : b.dataset.open; rr(); }; });
  $$('[data-copy]', el).forEach((b) => { b.onclick = () => ctx.copyText(find(b.dataset.copy)?.text || ''); });
  $$('[data-doc]', el).forEach((b) => { b.onclick = () => { const r = find(b.dataset.doc); if (r) addToDoc(ctx, [r]); }; });
  $$('[data-debrief]', el).forEach((b) => {
    b.onclick = async () => {
      const r = find(b.dataset.debrief);
      if (!r || !(await openDebrief(ctx, r, debriefOf.get(r.id)))) return;
      ctx.go('debrief');
    };
  });
  $$('[data-again]', el).forEach((b) => {
    b.onclick = async () => {
      const r = find(b.dataset.again);
      if (!r) return;
      if (!(await replaceDraft(ctx, 'this one'))) return;
      let missing = 0;
      const blocks = (r.blocks || []).map((rb) => {
        const { block, missing: gone } = draftBlock(ctx, rb);
        if (gone) missing += 1;
        return block;
      });
      state.draft = { date: state.today, slot: r.slot || 'AM', title: r.title || '', focus: r.focus || null, rounds: r.rounds > 1 ? r.rounds : 3, pattern: r.pattern || 'even', blocks };
      if (missing) ctx.toast(`${missing} block${missing === 1 ? ' is' : 's are'} no longer in the library; using the saved copy`);
      ctx.go('build');
    };
  });
  $$('[data-del]', el).forEach((b) => {
    b.onclick = async () => {
      const r = find(b.dataset.del);
      if (!r) return;
      const has = debriefOf.has(r.id);
      if (!(await ctx.confirmAction(`Delete ${longDate(r.date)} ${r.slot || 'AM'} from the log?${has ? ' Its debrief is kept, so what the app learned stays.' : ''}`, 'Delete'))) return;
      // Not saved: the app says so and offers Try again (it stays off the list).
      const saved = await ctx.save.removeLog(r.id);
      if (ui.open === r.id) ui.open = null;
      updateDebriefDot();
      if (saved) ctx.toast('Deleted');
      rr();
    };
  });
  $('#l-more', el)?.addEventListener('click', () => { ui.limit += PAGE; rr(); });
}
