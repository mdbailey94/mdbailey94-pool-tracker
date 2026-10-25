// Build: put a practice together for one session (AM or PM) from library
// blocks, blocks written from the gear chart, or the plan's suggestion;
// blend some into a circuit with rounds that differ, preview it with the
// group send-offs filled in, and save it to the log.

import {
  CATEGORIES, FOCUSES, PATTERNS, STROKE_LABEL, composePractice, longDate, makeBlock, measureText,
  mondayOf, sessionsOn, suggestPractice,
} from '../../practice.js';
import { carryForward, VERDICTS } from '../../learn.js';
import { blockSecondsByGroup, generateBlock } from '../../setlang.js';
import { fmtClock } from '../../gears.js';
import { blockLines, focusLabel, linesHTML, practiceHTML, practiceTextFor } from '../render.js';
import { savedRecord } from '../load.js';
import { updateDebriefDot } from '../app.js';
import { addToDoc } from '../doc-card.js';

// What the block writer can write (generateBlock focus) and in which stroke.
const WRITE_FOCUS = [['aerobic', 'Aerobic'], ['threshold', 'Threshold'], ['race', 'Race pace'], ['speed', 'Speed'], ['technique', 'Drill / technique'], ['recovery', 'Recovery'], ['kick', 'Kick'], ['im', 'IM gears']];
const WRITE_STROKE = [['free', 'FR'], ['back', 'BK'], ['breast', 'BR'], ['fly', 'FL'], ['IM', 'IM'], ['choice', 'choice']];
const WRITE_MINUTES = [15, 20, 30, 40, 45, 60];
const FOCUS_TO_WRITE = { aerobic: 'aerobic', threshold: 'threshold', race: 'race', speed: 'speed', technique: 'technique', recovery: 'recovery' };

const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// The draft as other screens may have left it, made whole.
function normaliseDraft(ctx) {
  const d = ctx.state.draft;
  d.date ||= ctx.state.today;
  d.slot = d.slot === 'PM' ? 'PM' : 'AM';
  d.blocks ||= [];
  d.blocks.forEach((b) => { b.key ||= ctx.uid('k'); });
  d.rounds = Math.min(8, Math.max(1, Math.round(+d.rounds) || 3));
  d.pattern = PATTERNS[d.pattern] ? d.pattern : 'even';
  d.title = String(d.title || '');
  return d;
}

function dayInfo(ctx, draft) {
  const day = sessionsOn(ctx.state.plan, draft.date);
  const session = day.sessions.find((s) => s.slot === draft.slot) || null;
  const focus = draft.focus || session?.focus || null;
  return { day, session, focus, position: day.position };
}

function planLine(ctx, draft, { day, session }) {
  const wd = new Date(`${draft.date}T12:00`).toLocaleDateString(undefined, { weekday: 'long' });
  if (day.meet) return `Meet day: ${day.meet.name}. No practice in the plan.`;
  if (!session) {
    const other = day.sessions.find((s) => s.slot !== draft.slot);
    return `No ${draft.slot} session in the plan on ${wd}${other ? ` (there is an ${other.slot} session)` : ''}.`;
  }
  const gears = FOCUSES[session.focus]?.gears || [];
  return [`Plan: ${draft.slot} · ${session.minutes} min · ${focusLabel(session.focus)}${gears.length ? ` (${gears.join(', ')})` : ''}`, session.theme, session.note].filter(Boolean).join(' · ');
}

const strokeTag = (b) => (b.stroke && b.stroke !== 'choice' ? STROKE_LABEL[b.stroke] : '');

function metaText(b, unit) {
  return [measureText(b, unit), strokeTag(b), CATEGORIES[b.category]?.label, b.gears?.length ? b.gears.join(' ') : '', b.equipment?.length ? b.equipment.join(', ') : '', b.session && b.session !== 'any' ? `${b.session} only` : '']
    .filter(Boolean).join(' · ');
}

// The first line of a description, for the collapsed row.
const peek = (t) => { const l = String(t || '').split('\n')[0].trim(); return l.length > 90 ? `${l.slice(0, 88)}…` : l; };

// The library block a practice block came from, when it is still there.
const libraryBlock = (ctx, b) => ctx.state.blocks.find((x) => x.id === b.id) || null;

// "Save to the block" / "Use the block's" when this practice's description
// differs from the library block's.
function descActions(ctx, b) {
  const lib = libraryBlock(ctx, b);
  const differs = !!lib && (lib.detail || '') !== (b.detail || '');
  return `<div class="b-desc-actions" data-desc-actions="${ctx.esc(b.key)}" ${differs ? '' : 'hidden'}>
    <span class="muted small">Only this practice so far.</span>
    <button type="button" class="btn secondary small-btn" data-desc-save="${ctx.esc(b.key)}">Save to the block</button>
    <button type="button" class="btn secondary small-btn" data-desc-reset="${ctx.esc(b.key)}">Use the block's</button>
  </div>`;
}

function blockRow(ctx, b, i, n, slot, open) {
  const { esc } = ctx;
  const notes = carryForward(ctx.state.debriefs, b.id, 2);
  const last = notes[0];
  const lines = open ? blockLines(b, ctx, null, slot) : [];
  return `<div class="brow ${b.circuit ? 'in-circuit' : ''}">
    <div class="info">
      <button type="button" class="b-disc" data-lines="${esc(b.key)}" aria-expanded="${open}"><span class="b-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${esc(b.name)}</button>
      <div class="meta">${esc(metaText(b, ctx.state.plan.unit))}${b.circuit ? ' <span class="badge circuit">circuit</span>' : ''}${last?.verdict ? ` <span class="badge">last: ${esc(VERDICTS[last.verdict].toLowerCase())}</span>` : ''}</div>
      ${!open && b.detail ? `<div class="b-desc-peek">${esc(peek(b.detail))}</div>` : ''}
    </div>
    <div class="ctl">
      <button type="button" class="icon-btn ${b.circuit ? 'on' : ''}" data-circ="${i}" title="Blend into the circuit" aria-pressed="${!!b.circuit}" ${CATEGORIES[b.category]?.main ? '' : 'disabled'}>Circuit</button>
      <button type="button" class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(b.name)} up">↑</button>
      <button type="button" class="icon-btn" data-down="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${esc(b.name)} down">↓</button>
      <button type="button" class="icon-btn danger" data-rm="${i}" aria-label="Remove ${esc(b.name)}">✕</button>
    </div>
    ${open ? `<div class="b-lines">
      ${lines.length ? linesHTML(lines) : '<p class="muted small">No set lines written for this block yet. Add them in Blocks, or use Write a block.</p>'}
      <label class="field b-desc">Description <span class="muted small">(prints under the block's heading)</span>
        <textarea data-desc="${esc(b.key)}" rows="2" placeholder="Cues, focus, what you want from this block today">${esc(b.detail || '')}</textarea></label>
      ${descActions(ctx, b)}
      ${notes.map((x) => `<div class="carry"><b>${esc(x.date)}${x.verdict ? ` · ${esc(VERDICTS[x.verdict])}` : ''}</b>${x.why ? ` — ${esc(x.why)}` : ''}${x.changed ? `<br>Changed: ${esc(x.changed)}` : ''}${x.times ? `<br>Times: ${esc(x.times)}` : ''}</div>`).join('')}
    </div>` : ''}
  </div>`;
}

// The library as a select: blocks for this session first (grouped by
// category), then the ones written for the other session.
function addOptions(ctx, slot) {
  const { esc } = ctx;
  const unit = ctx.state.plan.unit;
  const fits = (b) => !b.session || b.session === 'any' || b.session === slot;
  const order = (a, b) => (a.session === slot ? 0 : 1) - (b.session === slot ? 0 : 1) || a.name.localeCompare(b.name);
  const opt = (b) => `<option value="${esc(b.id)}">${esc(b.name)} — ${esc(measureText(b, unit))}${b.session === slot ? ` · ${slot}` : ''}</option>`;
  const mine = ctx.state.blocks.filter(fits);
  const other = ctx.state.blocks.filter((b) => !fits(b)).sort(order);
  const groups = Object.keys(CATEGORIES).map((c) => [c, mine.filter((b) => b.category === c).sort(order)]).filter(([, l]) => l.length);
  return `${groups.map(([c, l]) => `<optgroup label="${esc(CATEGORIES[c].label)}">${l.map(opt).join('')}</optgroup>`).join('')}
    ${other.length ? `<optgroup label="Written for ${slot === 'PM' ? 'AM' : 'PM'}">${other.map(opt).join('')}</optgroup>` : ''}`;
}

function writerHTML(ctx, w) {
  const { esc, chips } = ctx;
  const wctx = ctx.learned.writing;
  let result = '';
  if (w.result) {
    const secs = blockSecondsByGroup(w.result.lines, wctx);
    const per = secs.some((s) => s > 0) ? secs.map((s) => fmtClock(s)).join(' | ') : '';
    result = `<div class="b-result">
      <div class="b-result-head"><b>${esc(w.result.name)}</b><span class="muted small">${esc([[...w.result.gears].sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1))).join(' '), per && `${per} by group`].filter(Boolean).join(' · '))}</span></div>
      ${Math.abs(w.result.minutes - w.minutes) > 4 ? `<p class="muted small">You asked for ${w.minutes} min; this shape comes out at ${w.result.minutes}.${w.result.minutes > w.minutes ? ' Remove a round or a line in Blocks after adding it, or try another focus.' : ''}</p>` : ''}
      ${linesHTML(w.result.lines)}
      <div class="actions">
        <button type="button" class="btn" id="w-add">Add to practice</button>
        <button type="button" class="btn secondary" id="w-again">Another version</button>
      </div>
    </div>`;
  }
  return `<div class="b-writer" id="writer">
    <div class="b-writer-head"><h3>Write a block</h3><button type="button" class="icon-btn" id="w-close" aria-label="Close the block writer">✕</button></div>
    <p class="muted small">Written from your gear chart and the style learned from your blocks, with send-offs for each group.${wctx.groups?.[0]?.assumed ? ' Add your groups in Season for real send-offs.' : ''}</p>
    <div class="q"><span>Focus</span>${chips('w-focus', WRITE_FOCUS, w.focus, { allowNone: false })}</div>
    <div class="q"><span>Stroke</span>${chips('w-stroke', WRITE_STROKE, w.stroke, { allowNone: false })}</div>
    <div class="q"><span>Minutes</span>${chips('w-min', WRITE_MINUTES.map((m) => [String(m), `${m}`]), String(w.minutes), { allowNone: false })}</div>
    ${w.result ? '' : '<div class="actions"><button type="button" class="btn" id="w-go">Write it</button></div>'}
    ${result}
  </div>`;
}

export function render(ctx, el) {
  const { state, esc, chips, $, $$ } = ctx;
  const { plan } = state;
  const draft = normaliseDraft(ctx);
  const ui = (state.ui.build ||= { open: {}, writer: null, notes: null, variant: 0 });
  const info = dayInfo(ctx, draft);
  const hasCircuit = draft.blocks.some((b) => b.circuit);
  const composed = composePractice({ blocks: draft.blocks, rounds: draft.rounds, pattern: draft.pattern, pace: plan.pace, unit: plan.unit });
  const showDetail = state.prefs.showDetail !== false;
  const meta = { title: draft.title.trim(), date: draft.date, focus: info.focus || '', phase: info.position.phase?.name || '', slot: draft.slot, showDetail };
  let text = draft.blocks.length ? practiceTextFor(composed, ctx, meta) : '';
  const target = info.session?.minutes || null;
  const planFocus = info.session?.focus;
  // Editing a saved practice (from the Week tab): Save replaces it.
  const replacing = draft.replaces ? state.log.find((r) => r.id === draft.replaces) || null : null;
  if (draft.replaces && !replacing) draft.replaces = null;

  el.innerHTML = `
    <section class="card">
      <h2>${replacing ? 'Edit a practice' : 'Build a practice'}</h2>
      ${replacing ? `<p class="banner"><span>Editing the practice saved for ${esc(longDate(replacing.date))} ${esc(replacing.slot || 'AM')}${replacing.title ? ` (${esc(replacing.title)})` : ''}. <b>Save changes</b> replaces it.</span></p>` : ''}
      <div class="row">
        <label class="field">Date<input type="date" id="d-date" value="${esc(draft.date)}"></label>
        <label class="field">Focus<select id="d-focus"><option value="">${planFocus ? `Plan: ${esc(focusLabel(planFocus))}` : 'No plan focus'}</option>
          ${Object.keys(FOCUSES).filter((f) => f !== 'rest').map((f) => `<option value="${f}" ${draft.focus === f ? 'selected' : ''}>${esc(focusLabel(f))}</option>`).join('')}</select></label>
      </div>
      <div class="field">Session${chips('d-slot', [['AM', 'AM'], ['PM', 'PM (double)']], draft.slot, { allowNone: false })}</div>
      <p class="muted small" id="d-plan">${esc(planLine(ctx, draft, info))}</p>
      <label class="field">Title (optional)<input type="text" id="d-title" value="${esc(draft.title)}" placeholder="e.g. Tuesday FL/free switch"></label>
    </section>

    <section class="card">
      <div class="b-head"><h3>Blocks</h3>${draft.blocks.length ? `<span class="muted small">≈ ${composed.minutes}${target ? ` of ${target}` : ''} min</span>` : ''}</div>
      <p class="muted small">Tap a block to see its lines. Order them, then turn on <b>Circuit</b> for the ones to blend into rounds.</p>
      <div class="rows">
        ${draft.blocks.length ? draft.blocks.map((b, i) => blockRow(ctx, b, i, draft.blocks.length, draft.slot, !!ui.open[b.key])).join('') : '<p class="muted">No blocks yet. Add from the library, write one, or fill from the plan.</p>'}
      </div>
      ${ui.notes?.length ? `<ul class="notes">${ui.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${hasCircuit ? `<div class="b-rounds">
        <div class="field inline">Rounds
          <span class="stepper"><button type="button" class="icon-btn" id="r-minus" ${draft.rounds <= 1 ? 'disabled' : ''} aria-label="Fewer rounds">−</button><b id="r-val">${draft.rounds}</b><button type="button" class="icon-btn" id="r-plus" ${draft.rounds >= 8 ? 'disabled' : ''} aria-label="More rounds">+</button></span></div>
        <div class="q"><span>Round pattern</span>${chips('d-pattern', Object.entries(PATTERNS).map(([k, v]) => [k, v.label]), draft.pattern, { allowNone: false })}</div>
      </div>` : ''}
      <label class="field">Add a block<select id="d-add"><option value="">Choose from the library…</option>${addOptions(ctx, draft.slot)}</select></label>
      <div class="actions">
        <button type="button" class="btn secondary" id="d-write" aria-expanded="${!!ui.writer}">Write a block</button>
        <button type="button" class="btn secondary" id="d-suggest">Fill from the plan</button>
        <button type="button" class="btn secondary" id="d-new">New block…</button>
        ${draft.blocks.length ? '<button type="button" class="btn secondary danger" id="d-clear">Clear</button>' : ''}
      </div>
      ${ui.writer ? writerHTML(ctx, ui.writer) : ''}
    </section>

    ${draft.blocks.length ? `<section class="card" id="preview">
      <div class="eyebrow">${esc([longDate(draft.date), draft.slot, meta.phase, info.focus && `${focusLabel(info.focus)}`].filter(Boolean).join(' · '))}</div>
      <h3 id="d-head">${esc(meta.title || 'Written practice')}</h3>
      ${practiceHTML(composed, ctx, { slot: draft.slot, showDetail })}
      <label class="field inline"><input type="checkbox" id="d-detail" ${showDetail ? 'checked' : ''}> Show block descriptions</label>
      <div class="actions">
        <button type="button" class="btn" id="d-save">${replacing ? 'Save changes' : 'Save to log'}</button>
        ${replacing ? '<button type="button" class="btn secondary" id="d-save-new">Save as a new practice</button>' : ''}
        ${ctx.isArtifact && !replacing ? '<button type="button" class="btn secondary" id="d-save-doc">Save and add to Google Doc</button>' : ''}
        <button type="button" class="btn secondary" id="d-copy">Copy text</button>
        ${navigator.share ? '<button type="button" class="btn secondary" id="d-share">Share</button>' : ''}
      </div>
      <details><summary>Plain text</summary><pre class="text" id="d-text">${esc(text)}</pre></details>
    </section>` : ''}
  `;

  const rr = () => ctx.rerender();

  $('#d-date', el).onchange = (e) => { if (e.target.value) { draft.date = e.target.value; rr(); } };
  $('#d-focus', el).onchange = (e) => { draft.focus = e.target.value || null; rr(); };
  // The title only shows in the preview's heading and the text: both follow
  // it in place as it is typed. A redraw on change (which fires when the
  // coach presses a button) would swallow that press.
  const title = $('#d-title', el);
  title.oninput = () => {
    draft.title = title.value;
    meta.title = draft.title.trim();
    if (!draft.blocks.length) return;
    text = practiceTextFor(composed, ctx, meta);
    const head = $('#d-head', el);
    if (head) head.textContent = meta.title || 'Written practice';
    const pre = $('#d-text', el);
    if (pre) pre.textContent = text;
  };

  ctx.bindChips(el, (name, value) => {
    if (name === 'd-slot') draft.slot = value;
    else if (name === 'd-pattern') draft.pattern = value;
    else if (name === 'w-focus') { ui.writer.focus = value; ui.writer.result = null; }
    else if (name === 'w-stroke') { ui.writer.stroke = value; ui.writer.result = null; }
    else if (name === 'w-min') { ui.writer.minutes = +value; ui.writer.result = null; }
    rr();
  });

  $$('[data-lines]', el).forEach((b) => { b.onclick = () => { ui.open[b.dataset.lines] = !ui.open[b.dataset.lines]; rr(); }; });

  // Descriptions: typed into this practice's copy of the block. The preview
  // and the text follow in place (a redraw would take the cursor away).
  const byKey = (key) => draft.blocks.find((x) => x.key === key);
  const refreshPreview = () => {
    const box = $('#preview .practice', el);
    if (box) box.outerHTML = practiceHTML(composed, ctx, { slot: draft.slot, showDetail });
    text = practiceTextFor(composed, ctx, meta);
    const pre = $('#d-text', el);
    if (pre) pre.textContent = text;
  };
  $$('[data-desc]', el).forEach((t) => {
    t.oninput = () => {
      const b = byKey(t.dataset.desc);
      if (!b) return;
      b.detail = t.value;
      const lib = libraryBlock(ctx, b);
      const actions = $(`[data-desc-actions="${b.key}"]`, el);
      if (actions) actions.hidden = !lib || (lib.detail || '') === (b.detail || '');
      refreshPreview();
    };
  });
  $$('[data-desc-save]', el).forEach((btn) => {
    btn.onclick = async () => {
      const b = byKey(btn.dataset.descSave);
      const lib = b && libraryBlock(ctx, b);
      if (!lib) return;
      btn.disabled = true;
      const detail = String(b.detail || '').trim();
      const saved = await ctx.save.block({ ...lib, detail });
      b.detail = detail;
      ctx.toast(saved ? `Saved the description to ${lib.name}` : `${lib.name}: description not saved yet`);
      rr();
    };
  });
  $$('[data-desc-reset]', el).forEach((btn) => {
    btn.onclick = () => {
      const b = byKey(btn.dataset.descReset);
      const lib = b && libraryBlock(ctx, b);
      if (!lib) return;
      b.detail = lib.detail || '';
      rr();
    };
  });
  $$('[data-circ]', el).forEach((b) => { b.onclick = () => { const x = draft.blocks[+b.dataset.circ]; x.circuit = !x.circuit; rr(); }; });
  $$('[data-up]', el).forEach((b) => { b.onclick = () => { const i = +b.dataset.up; [draft.blocks[i - 1], draft.blocks[i]] = [draft.blocks[i], draft.blocks[i - 1]]; rr(); }; });
  $$('[data-down]', el).forEach((b) => { b.onclick = () => { const i = +b.dataset.down; [draft.blocks[i + 1], draft.blocks[i]] = [draft.blocks[i], draft.blocks[i + 1]]; rr(); }; });
  $$('[data-rm]', el).forEach((b) => { b.onclick = () => { draft.blocks.splice(+b.dataset.rm, 1); rr(); }; });

  const addToDraft = (src) => {
    const circuit = !!(CATEGORIES[src.category]?.circuit && draft.blocks.some((b) => b.circuit));
    const entry = { ...src, circuit, key: ctx.uid('k') };
    // Keep the cool-down last.
    const cool = draft.blocks.findIndex((b) => b.category === 'cooldown');
    if (cool >= 0 && src.category !== 'cooldown') draft.blocks.splice(cool, 0, entry); else draft.blocks.push(entry);
    return entry;
  };

  $('#d-add', el).onchange = (e) => {
    const src = state.blocks.find((b) => b.id === e.target.value);
    if (!src) return;
    addToDraft(src);
    rr();
  };

  $('#d-new', el).onclick = () => {
    state.ui.blocks = { ...(state.ui.blocks || {}), editing: 'new', form: null, returnTo: 'build', session: draft.slot };
    ctx.go('blocks');
  };

  $('#d-suggest', el).onclick = async () => {
    if (!info.session && !draft.focus) {
      ctx.toast(info.day.meet ? 'Meet day. Pick a focus to write one anyway.' : `No ${draft.slot} session that day. Pick a focus first.`);
      $('#d-focus', el).focus();
      return;
    }
    if (draft.blocks.length && !(await ctx.confirmAction(`Replace the ${draft.blocks.length} block${draft.blocks.length === 1 ? '' : 's'} in this practice with the plan's suggestion?`, 'Replace', { danger: false }))) return;
    const s = suggestPractice({
      plan, library: state.blocks, date: draft.date, history: state.log, focus: draft.focus, slot: draft.slot,
      equipment: state.prefs.equipment || null, weights: ctx.learned.weights, variant: ui.variant++,
    });
    draft.blocks = s.blocks.map((b) => ({ ...b, key: ctx.uid('k') }));
    if (s.rounds > 1) draft.rounds = s.rounds;
    ui.notes = s.notes.length ? s.notes : null;
    if (!draft.blocks.length) ctx.toast(s.notes[0] || 'Nothing to suggest for this session');
    else ctx.toast(`Filled from the plan: ${focusLabel(s.focus).toLowerCase()}, ${s.minutes} min`);
    rr();
  };

  $('#d-clear', el)?.addEventListener('click', async () => {
    if (!(await ctx.confirmAction('Clear every block from this practice?', 'Clear'))) return;
    draft.blocks = [];
    ui.notes = null;
    rr();
  });

  // Block writer.
  $('#d-write', el).onclick = () => {
    if (ui.writer) { ui.writer = null; rr(); return; }
    const room = (target || (draft.slot === 'PM' ? 45 : 120)) - (draft.blocks.length ? composed.minutes : Math.round((target || 120) * 0.3));
    ui.writer = {
      focus: FOCUS_TO_WRITE[info.focus] || 'aerobic',
      stroke: 'free',
      minutes: nearest(WRITE_MINUTES, Math.min(60, Math.max(15, room))),
      variant: 0,
      result: null,
    };
    rr();
    $('#writer', el)?.scrollIntoView({ block: 'nearest' });
  };
  const write = () => {
    const w = ui.writer;
    try {
      w.result = generateBlock({ focus: w.focus, minutes: w.minutes, stroke: w.stroke, slot: draft.slot, ctx: ctx.learned.writing, variant: w.variant });
    } catch (e) {
      console.error(e);
      ctx.toast('Could not write that block');
      w.result = null;
    }
    rr();
  };
  $('#w-close', el)?.addEventListener('click', () => { ui.writer = null; rr(); });
  $('#w-go', el)?.addEventListener('click', write);
  $('#w-again', el)?.addEventListener('click', () => { ui.writer.variant += 1; write(); });
  $('#w-add', el)?.addEventListener('click', async () => {
    const block = makeBlock({ ...ui.writer.result, source: 'generated' });
    // Not saved to Blocks (the app says so and offers Try again): it still
    // goes into the practice, which is what the coach asked for.
    const saved = await ctx.save.block(block);
    const entry = addToDraft(block);
    ui.open[entry.key] = true;
    ui.writer = null;
    ctx.toast(saved ? `Added ${block.name} and saved it to Blocks` : `Added ${block.name} · not saved to Blocks yet`);
    rr();
  });

  // Rounds and pattern.
  $('#r-minus', el)?.addEventListener('click', () => { draft.rounds = Math.max(1, draft.rounds - 1); rr(); });
  $('#r-plus', el)?.addEventListener('click', () => { draft.rounds = Math.min(8, draft.rounds + 1); rr(); });

  // Preview.
  $('#d-detail', el)?.addEventListener('change', async (e) => {
    state.prefs = { ...state.prefs, showDetail: e.target.checked };
    await ctx.save.prefs();
    rr();
  });
  $('#d-copy', el)?.addEventListener('click', () => ctx.copyText(text));
  $('#d-share', el)?.addEventListener('click', () => navigator.share({ title: meta.title || 'Practice', text }).catch(() => {}));
  const saveDraft = async (e, replace, toDoc = false) => {
    e.target.disabled = true;
    // The send-offs the app wrote are kept as they were printed today.
    const rec = savedRecord(ctx, {
      date: draft.date, title: meta.title, focus: info.focus, slot: draft.slot, position: info.position,
      blocks: draft.blocks, rounds: hasCircuit ? draft.rounds : 1, pattern: draft.pattern, composed, text,
    });
    if (replace && replacing) {
      rec.id = replacing.id; rec.createdAt = replacing.createdAt || rec.createdAt;
      // Already in the week's Google Doc: the doc keeps the earlier version.
      const sent = replacing.doc || replacing.docEdited;
      if (sent) rec.docEdited = sent;
    } else {
      // A save of this draft that failed is on screen already: saving again
      // replaces that record instead of adding a second one.
      const failed = draft.unsaved && state.log.find((r) => r.id === draft.unsaved && r.date === draft.date && (r.slot || 'AM') === draft.slot);
      if (failed) { rec.id = failed.id; rec.createdAt = failed.createdAt || rec.createdAt; }
    }
    const saved = await ctx.save.log(rec);
    updateDebriefDot();
    // Not saved: the app says so and offers Try again; the draft stays here.
    if (!saved) {
      draft.unsaved = rec.id;
      rr();
      return;
    }
    draft.unsaved = null;
    draft.replaces = null;
    ctx.toast(replace && replacing ? `Saved changes to the ${draft.slot} practice` : `Saved ${draft.slot} practice to the log`);
    if (toDoc) addToDoc(ctx, [rec]);
    // Started from the Week planner: back to that week, else to the Log.
    if (draft.back === 'week') {
      draft.back = null;
      state.ui.week = mondayOf(rec.date);
      ctx.go('week');
      return;
    }
    state.ui.log = { ...(state.ui.log || {}), open: rec.id };
    ctx.go('log');
  };
  $('#d-save', el)?.addEventListener('click', (e) => saveDraft(e, true));
  $('#d-save-new', el)?.addEventListener('click', (e) => saveDraft(e, false));
  $('#d-save-doc', el)?.addEventListener('click', (e) => saveDraft(e, true, true));
}
