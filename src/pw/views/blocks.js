// Blocks: the coach's library. Paste a set in your own notation and it is
// read, timed per group and learned from; edit blocks line by line with the
// send-offs filled from the gear chart; see what the app has learned about
// your style; back up and restore everything.

import {
  CATEGORIES, EQUIPMENT, INTENSITY, STROKES, STROKE_LABEL, blockDistance, blockMinutes, makeBlock, measureText, starterBlocks, subCategories,
} from '../../practice.js';
import { DEFAULT_GEAR_MODEL, fmtClock } from '../../gears.js';
import { blockCns, blockSecondsByGroup, generateBlock, parseSet, quickBlock, setDistance, setGears, writeLines } from '../../setlang.js';
import { exportAll, importAll, loadAll } from '../../practice-store.js';
import { blockLines, linesHTML } from '../render.js';
import { versionFor } from '../load.js';
import { ideaVersion, phaseKey } from '../../ideas.js';
import { updateDebriefDot } from '../app.js';

const OWN = ['coach', 'pasted', 'drive', 'claude'];
const GEARS = DEFAULT_GEAR_MODEL.gears.map((g) => g.name);
const SESSIONS = [['AM', 'AM'], ['PM', 'PM'], ['any', 'Either']];
const SOURCE = { pasted: 'pasted', generated: 'written by the app', claude: 'from the coach chat', coach: 'yours', drive: 'imported' };
// Which kind of block the writer makes for each category (warm-ups and
// cool-downs are written easy, never as drill + build work).
const WRITE_FOCUS = { warmup: 'warmup', aerobic: 'aerobic', threshold: 'threshold', race: 'race', speed: 'speed', kick: 'kick', pull: 'aerobic', technique: 'technique', cooldown: 'cooldown' };

const catLabel = (c) => CATEGORIES[c]?.label || c;
const sessionLabel = (s) => (s === 'AM' ? 'AM' : s === 'PM' ? 'PM' : 'AM or PM');

function uiOf(state) {
  const ui = (state.ui.blocks ||= {});
  ui.open ||= {};
  ui.paste ??= '';
  return ui;
}

// "41:39 | 43:30 | 45:10" for a block's lines, one value per group.
function groupTimes(lines, wctx) {
  if (!lines?.length) return '';
  const secs = blockSecondsByGroup(lines, wctx);
  if (!secs.some((s) => s > 0)) return '';
  return secs.map((s) => fmtClock(s)).join(' | ');
}

const groupNames = (wctx) => wctx.groups.map((g) => g.name).join(' | ');

// ---------------------------------------------------------------- render

export function render(ctx, el) {
  const { state } = ctx;
  const ui = uiOf(state);
  const editing = ui.editing ? formFor(ctx, ui) : null;
  el.innerHTML = [
    editing ? editorHTML(ctx, editing) : pasteHTML(ctx, ui),
    libraryHTML(ctx, ui),
    styleHTML(ctx),
    dataHTML(ctx),
  ].join('');
  bindLibrary(ctx, el, ui);
  if (editing) bindEditor(ctx, el, ui); else bindPaste(ctx, el, ui);
  bindStyle(ctx, el);
  bindData(ctx, el);
}

// ----------------------------------------------------------- paste a set

function pasteHTML(ctx, ui) {
  return `<section class="card" id="bk-paste">
    <div class="c-head"><h2>Paste a set</h2><button type="button" class="btn secondary small-btn" id="bk-new">New block</button></div>
    <p class="lead">Paste a block the way you write it (a <code>36 min FL/free switch</code> heading is fine). The app reads it, fills any missing send-offs for each group and learns your style from it.</p>
    <label class="field"><span class="sr-only">Set to paste</span><textarea id="bk-text" class="c-mono" rows="7" spellcheck="false" placeholder="40 min free aerobic base&#10;2 x 400 free, G2 → G3 by 200&#10;:20 REST&#10;3 rounds:&#10;6 x 100 free G2, steady      1:22 | 1:26 | 1:30&#10;4 x 25 free G6 sprint&#10;150 easy, any stroke">${ctx.esc(ui.paste)}</textarea></label>
    <div id="bk-preview">${pastePreview(ctx, ui.paste)}</div>
    <div class="actions">
      <button type="button" class="btn" id="bk-save-paste" ${ui.paste.trim() ? '' : 'disabled'}>Save as block</button>
      <button type="button" class="btn secondary" id="bk-clear-paste" ${ui.paste ? '' : 'disabled'}>Clear</button>
    </div>
  </section>`;
}

function pastePreview(ctx, text) {
  const { esc } = ctx;
  if (!text.trim()) return '';
  const wctx = ctx.learned.writing;
  let f;
  try { f = quickBlock(text, wctx); } catch (e) { console.error(e); return '<p class="form-error">That set could not be read.</p>'; }
  const swims = parseSet(f.lines.join('\n')).lines.filter((l) => l.type === 'swim');
  if (!swims.length) return '<p class="muted small">No swim lines yet. Lines look like <code>4 x 100 free G3   1:20 | 1:24</code>.</p>';
  const lines = writeLines(f.lines, wctx);
  const times = groupTimes(f.lines, wctx);
  const dist = setDistance(parseSet(lines.join('\n')));
  return `<div class="c-preview">
    <div class="c-preview-head"><b>${esc(f.name)}</b><span class="badge cat">${esc(catLabel(f.category))}</span></div>
    <div class="muted small">${esc([f.minutes ? `${f.minutes} min` : null, dist ? `${dist}${wctx.unit}` : null, f.stroke !== 'choice' ? STROKE_LABEL[f.stroke] : null, f.gears.join(' ') || null, f.equipment.join(', ') || null].filter(Boolean).join(' · '))}</div>
    ${linesHTML(lines)}
    ${times ? `<div class="c-times"><span>Time per group</span><b>${esc(times)}</b></div><div class="muted small">${esc(groupNames(wctx))}</div>` : ''}
  </div>`;
}

function bindPaste(ctx, el, ui) {
  const { $ } = ctx;
  const ta = $('#bk-text', el);
  const preview = $('#bk-preview', el);
  ta.oninput = () => {
    ui.paste = ta.value;
    preview.innerHTML = pastePreview(ctx, ui.paste);
    $('#bk-save-paste', el).disabled = !ui.paste.trim();
    $('#bk-clear-paste', el).disabled = !ui.paste;
  };
  $('#bk-clear-paste', el).onclick = () => { ui.paste = ''; ctx.rerender(); };
  $('#bk-new', el).onclick = () => { ui.editing = 'new'; ui.form = null; ctx.rerender(); window.scrollTo({ top: 0 }); };
  $('#bk-save-paste', el).onclick = async () => {
    let f;
    try { f = quickBlock(ui.paste, ctx.learned.writing); } catch { f = null; }
    if (!f || !f.lines.some((l) => l.trim())) { ctx.toast('Nothing to save yet'); return; }
    // Not saved: the app says so and offers Try again; the pasted set stays,
    // and saving the same set again replaces the block that was not saved.
    const again = ui.unsaved?.text === ui.paste ? ui.unsaved.id : undefined;
    const block = makeBlock({ ...f, id: again, source: 'pasted' });
    if (!(await ctx.save.block(block))) { ui.unsaved = { id: block.id, text: ui.paste }; ctx.rerender(); return; }
    ui.unsaved = null;
    const style = await ctx.save.relearn();
    ui.paste = '';
    ui.open[block.id] = true;
    ui.flash = block.id;
    ctx.toast(style ? `Saved. Learned from ${style.learnedFrom.blocks} block${style.learnedFrom.blocks === 1 ? '' : 's'}` : 'Block saved');
    ctx.rerender();
    el.querySelector(`[data-row="${CSS.escape(block.id)}"]`)?.scrollIntoView({ block: 'center' });
  };
}

// ---------------------------------------------------------------- library

// What the search box matches: name, sub-category, description, category and lines.
const searchText = (b) => [b.name, b.sub, b.detail, b.idea ? 'idea' : '', ...Object.values(b.stages || {}), catLabel(b.category), STROKE_LABEL[b.stroke], ...(b.lines || [])].join(' ').toLowerCase();
const matches = (b, q) => !q || q.split(/\s+/).every((w) => searchText(b).includes(w));

// A category's blocks by sub-category: those without one first, then each
// sub-category A–Z (written as its first block has it).
function bySub(list) {
  const out = new Map([['', []]]);
  const names = new Map();
  for (const b of list) {
    const k = (b.sub || '').toLowerCase();
    if (!names.has(k)) names.set(k, b.sub || '');
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(b);
  }
  return [...out.entries()].filter(([, rows]) => rows.length)
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([k, rows]) => [names.get(k), rows]);
}

function libraryHTML(ctx, ui) {
  const { state, esc } = ctx;
  const unit = state.plan.unit;
  const q = String(ui.q || '').trim().toLowerCase();
  const pool = ui.noDesc ? state.blocks.filter((b) => !b.detail) : state.blocks;
  const groups = Object.keys(CATEGORIES).map((c) => [c, pool.filter((b) => b.category === c)]).filter(([, l]) => l.length);
  const inDraft = state.draft.blocks?.length || 0;
  const without = state.blocks.filter((b) => !b.detail).length;
  return `<section class="card" id="bk-library">
    <div class="c-head"><h2>Library</h2><span class="muted small">${state.blocks.length} block${state.blocks.length === 1 ? '' : 's'}${inDraft ? ` · ${inDraft} in the practice being built` : ''}</span></div>
    ${state.blocks.length ? `<div class="bk-find">
      <input type="search" id="bk-q" value="${esc(ui.q || '')}" placeholder="Search names, descriptions and lines" aria-label="Search the library" autocomplete="off">
      <button type="button" class="chip ${ui.noDesc ? 'on' : ''}" id="bk-nodesc" aria-pressed="${!!ui.noDesc}">No description yet (${without})</button>
    </div>` : ''}
    ${groups.length ? '' : `<p class="muted">${state.blocks.length ? 'Every block has a description.' : 'No blocks yet. Paste a set above or restore the starter blocks below.'}</p>`}
    ${groups.map(([c, list]) => `<div class="bk-group" data-group="${esc(c)}">
      <div class="group-title">${esc(catLabel(c))}</div>
      ${bySub(list).map(([sub, rows]) => `<div class="bk-sub" ${rows.some((b) => matches(b, q)) ? '' : 'hidden'}>${sub ? `<div class="sub-title">${esc(sub)}</div>` : ''}
      <div class="rows">${rows.map((b) => rowHTML(ctx, b, unit, !!ui.open[b.id], ui.flash === b.id, !matches(b, q), ui)).join('')}</div></div>`).join('')}</div>`).join('')}
    <p class="muted small" id="bk-none" ${groups.length && !groups.some(([, l]) => l.some((b) => matches(b, q))) ? '' : 'hidden'}>Nothing matches “${esc(ui.q || '')}”.</p>
  </section>`;
}

// Shows only the rows that match the search, without a redraw (which would
// take the cursor out of the box).
function applySearch(ctx, el, ui) {
  const q = String(ui.q || '').trim().toLowerCase();
  let any = false;
  ctx.$$('.bk-group', el).forEach((g) => {
    let shown = 0;
    ctx.$$('[data-row]', g).forEach((row) => {
      const b = ctx.state.blocks.find((x) => x.id === row.dataset.row);
      const hit = !!b && matches(b, q);
      row.hidden = !hit;
      if (hit) shown += 1;
    });
    ctx.$$('.bk-sub', g).forEach((sub) => { sub.hidden = !ctx.$$('[data-row]', sub).some((row) => !row.hidden); });
    g.hidden = !shown;
    if (shown) any = true;
  });
  const none = ctx.$('#bk-none', el);
  if (none) { none.hidden = any || !ctx.$$('.bk-group', el).length; none.textContent = `Nothing matches “${ui.q || ''}”.`; }
}

function rowHTML(ctx, b, unit, open, flash, hidden = false, ui = {}) {
  const { esc } = ctx;
  const meta = [
    measureText(b, unit),
    b.stroke !== 'choice' ? STROKE_LABEL[b.stroke] : null,
    b.gears.length ? b.gears.join(' ') : null,
    sessionLabel(b.session),
    b.equipment.length ? b.equipment.join(', ') : null,
  ].filter(Boolean).join(' · ');
  const lines = open ? blockLines(b, ctx) : [];
  const desc = ui.desc?.[b.id] ?? b.detail ?? '';
  return `<div class="brow c-row ${flash ? 'c-flash' : ''}" data-row="${esc(b.id)}" ${hidden ? 'hidden' : ''}>
    <button type="button" class="c-disc" data-open="${esc(b.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} the lines of ${esc(b.name)}">${open ? '▾' : '▸'}</button>
    <div class="info"><div class="name">${esc(b.name)}${b.idea ? ' <span class="badge">idea</span>' : ''}</div><div class="meta">${esc(meta)}</div>
      ${!open && b.detail ? `<div class="b-desc-peek">${esc(b.detail.split('\n')[0].slice(0, 120))}</div>` : ''}</div>
    <div class="ctl">
      <button type="button" class="icon-btn" data-add="${esc(b.id)}" title="Add to the practice being built" aria-label="Add ${esc(b.name)} to the practice">＋</button>
      <button type="button" class="icon-btn" data-edit="${esc(b.id)}">Edit</button>
    </div>
    ${open ? `<div class="c-lines">
      ${lines.length ? linesHTML(lines) : '<p class="muted small">No set lines yet. Edit the block to write them, or let the app write them.</p>'}
      ${b.lines.length ? `<div class="c-times"><span>Time per group</span><b>${esc(groupTimes(b.lines, ctx.learned.writing))}</b></div>` : ''}
      <label class="field b-desc">Description <span class="muted small">(what to watch for, cues, why this block; prints under its heading)</span>
        <textarea data-bdesc="${esc(b.id)}" rows="2" placeholder="e.g. Hold stroke count on the 100s; fast feet off every wall">${esc(desc)}</textarea></label>
      <div class="b-desc-actions" data-bdesc-actions="${esc(b.id)}" ${desc !== (b.detail || '') ? '' : 'hidden'}>
        <button type="button" class="btn small-btn" data-bdesc-save="${esc(b.id)}">Save description</button>
        <button type="button" class="btn secondary small-btn" data-bdesc-undo="${esc(b.id)}">Undo</button>
      </div>
      ${b.source && SOURCE[b.source] ? `<p class="muted small">Source: ${esc(SOURCE[b.source])}</p>` : ''}
    </div>` : ''}
  </div>`;
}

function bindLibrary(ctx, el, ui) {
  const { $, $$, state } = ctx;
  ui.flash = null;
  ui.desc ||= {};
  const q = $('#bk-q', el);
  if (q) q.oninput = () => { ui.q = q.value; applySearch(ctx, el, ui); };
  $('#bk-nodesc', el)?.addEventListener('click', () => { ui.noDesc = !ui.noDesc; ctx.rerender(); });
  // A description typed in a row is kept (across redraws) until it is saved.
  $$('[data-bdesc]', el).forEach((t) => {
    t.oninput = () => {
      const id = t.dataset.bdesc;
      const b = state.blocks.find((x) => x.id === id);
      ui.desc[id] = t.value;
      const actions = $(`[data-bdesc-actions="${id}"]`, el);
      if (actions) actions.hidden = !b || t.value === (b.detail || '');
    };
  });
  $$('[data-bdesc-undo]', el).forEach((btn) => { btn.onclick = () => { delete ui.desc[btn.dataset.bdescUndo]; ctx.rerender(); }; });
  $$('[data-bdesc-save]', el).forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.bdescSave;
      const b = state.blocks.find((x) => x.id === id);
      if (!b) return;
      btn.disabled = true;
      // Not saved: the app says so and offers Try again; the text stays in the box.
      if (await ctx.save.block({ ...b, detail: String(ui.desc[id] ?? '').trim() })) {
        delete ui.desc[id];
        ctx.toast(`Saved the description of ${b.name}`);
      }
      ctx.rerender();
    };
  });
  $$('[data-open]', el).forEach((b) => { b.onclick = () => { ui.open[b.dataset.open] = !ui.open[b.dataset.open]; ctx.rerender(); }; });
  $$('[data-edit]', el).forEach((b) => {
    b.onclick = () => { ui.editing = b.dataset.edit; ui.form = null; ui.returnTo = null; ctx.rerender(); window.scrollTo({ top: 0 }); };
  });
  $$('[data-add]', el).forEach((b) => {
    b.onclick = () => {
      const src = state.blocks.find((x) => x.id === b.dataset.add);
      if (!src) return;
      addToDraft(ctx, src);
      ctx.rerender();
    };
  });
}

function addToDraft(ctx, src) {
  const d = ctx.state.draft;
  d.blocks ||= [];
  const entry = { ...versionFor(ctx, d, src), circuit: false, key: ctx.uid('k') };
  const cool = d.blocks.findIndex((b) => b.category === 'cooldown');
  if (cool >= 0 && src.category !== 'cooldown') d.blocks.splice(cool, 0, entry); else d.blocks.push(entry);
  ctx.toast(`Added ${src.name} to the ${d.slot === 'PM' ? 'PM' : 'AM'} practice (${d.blocks.length} block${d.blocks.length === 1 ? '' : 's'})`);
}

// ----------------------------------------------------------------- editor

// The working copy of the block being edited (kept across re-renders).
function formFor(ctx, ui) {
  const key = `${ui.editing}|${ui.returnTo || ''}`;
  if (ui.form && ui.form.for === key) return ui.form;
  const { state } = ctx;
  let b = ui.editing === 'new' ? null : state.blocks.find((x) => x.id === ui.editing);
  if (ui.editing !== 'new' && !b) { ui.editing = null; return null; }
  b ||= makeBlock({ name: '', category: 'aerobic', minutes: 40, session: ui.session || 'any', source: 'coach' });
  ui.form = {
    for: key,
    isNew: ui.editing === 'new',
    id: ui.editing === 'new' ? null : b.id,
    name: b.name,
    category: b.category,
    stroke: b.stroke,
    measure: b.distance ? 'distance' : 'minutes',
    amount: b.distance || b.minutes || '',
    intensity: b.intensity,
    session: b.session,
    gears: [...b.gears],
    equipment: [...b.equipment],
    lines: b.lines.join('\n'),
    detail: b.detail,
    sub: b.sub || '',
    idea: !!b.idea,
    stages: { ...(b.stages || {}) },
    version: 0,
    source: b.source || '',
    origLines: b.lines.join('\n'),
    generatedLines: null,
    variant: 0,
  };
  return ui.form;
}

function editorHTML(ctx, f) {
  const { esc, chips, state } = ctx;
  const unit = state.plan.unit;
  return `<section class="card" id="bk-form">
    <div class="c-head"><h2>${f.isNew ? 'New block' : 'Edit block'}</h2>${ctx.state.ui.blocks.returnTo === 'build' ? '<span class="muted small">Goes into the practice when saved</span>' : ''}</div>
    <label class="field">Name<input type="text" data-f="name" value="${esc(f.name)}" placeholder="e.g. 36 min FL/free switch" autocomplete="off"></label>
    <div class="row">
      <label class="field">Category<select data-f="category">${Object.keys(CATEGORIES).map((c) => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${esc(catLabel(c))}</option>`).join('')}</select></label>
      <label class="field">Sub-category <span class="muted small">(optional)</span><input type="text" data-f="sub" value="${esc(f.sub)}" list="bk-subs" placeholder="e.g. Socks, Underwater" autocomplete="off" maxlength="40">
        <datalist id="bk-subs">${subCategories(state.blocks, f.category).map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></label>
    </div>
    <div class="row">
      <label class="field">Stroke<select data-f="stroke">${STROKES.map((s) => `<option value="${s}" ${f.stroke === s ? 'selected' : ''}>${esc(STROKE_LABEL[s])}</option>`).join('')}</select></label>
    </div>
    <div class="grid3">
      <label class="field">Measured by<select data-f="measure"><option value="minutes" ${f.measure === 'minutes' ? 'selected' : ''}>time (min)</option><option value="distance" ${f.measure === 'distance' ? 'selected' : ''}>distance (${esc(unit)})</option></select></label>
      <label class="field">Amount<input type="number" data-f="amount" min="1" step="1" inputmode="numeric" value="${esc(f.amount)}"></label>
      <label class="field">Effort<select data-f="intensity">${Object.entries(INTENSITY).map(([k, l]) => `<option value="${k}" ${+k === +f.intensity ? 'selected' : ''}>${k} · ${l}</option>`).join('')}</select></label>
    </div>
    <div class="field">Session${chips('session', SESSIONS, f.session, { allowNone: false })}</div>
    <div class="field">Gears <span class="muted small">(blank = read from the lines)</span>
      <div class="chips c-gears">${GEARS.map((g) => `<button type="button" class="chip ${f.gears.includes(g) ? 'on' : ''}" data-gear="${g}" aria-pressed="${f.gears.includes(g)}">${g}</button>`).join('')}</div></div>
    <div class="field">Equipment
      <div class="chips">${EQUIPMENT.map((e) => `<button type="button" class="chip ${f.equipment.includes(e) ? 'on' : ''}" data-eq="${esc(e)}" aria-pressed="${f.equipment.includes(e)}">${esc(e)}</button>`).join('')}</div></div>
    <label class="field">Lines <span class="muted small">(one per row, your notation; leave send-offs off and the app fills them for each group)</span>
      <textarea data-f="lines" class="c-mono" rows="9" spellcheck="false" placeholder="G3 pace       1:02 | 1:05 | 1:08&#10;3 x 300 free&#10;:15 REST&#10;3 rounds:&#10;6 x 50 FL, G2 → G5 by 25&#10;4 x 25 BK G6 sprint&#10;150 easy, any stroke">${esc(f.lines)}</textarea></label>
    <div class="actions c-tight">
      <button type="button" class="btn secondary" id="bk-write">${f.lines.trim() ? 'Write new lines for me' : 'Write lines for me'}</button>
    </div>
    <div id="bk-lines-preview">${linesPreview(ctx, f)}</div>
    <label class="field">${f.idea ? 'The idea' : 'Description'} <span class="muted small">(prints under the block's heading; each practice can change it)</span><textarea data-f="detail" rows="3" placeholder="${f.idea ? 'e.g. Fly with socks, mixed in with other focuses' : 'What to watch for, cues, why this block'}">${esc(f.detail)}</textarea></label>
    ${ideaHTML(ctx, f)}
    <p class="form-error" id="bk-err" hidden></p>
    <div class="actions">
      <button type="button" class="btn" id="bk-save">${ctx.state.ui.blocks.returnTo === 'build' ? 'Save and add to practice' : 'Save block'}</button>
      ${f.isNew ? '' : '<button type="button" class="btn secondary" id="bk-copy">Save as a copy</button>'}
      <button type="button" class="btn secondary" id="bk-cancel">Cancel</button>
      ${f.isNew ? '' : '<button type="button" class="btn secondary danger" id="bk-del">Delete</button>'}
    </div>
  </section>`;
}

const formLines = (f) => f.lines.split('\n');

// An idea: the switch, and what changes in each phase of the plan (plus
// notes kept for phase names the plan no longer has).
function ideaHTML(ctx, f) {
  const { esc, state } = ctx;
  const phases = state.plan.phases.map((p) => p.name);
  const keys = new Set(phases.map(phaseKey));
  const names = [...phases.filter((n, i) => phases.findIndex((x) => phaseKey(x) === phaseKey(n)) === i),
    ...Object.keys(f.stages).filter((n) => !keys.has(phaseKey(n)))];
  const value = (n) => f.stages[Object.keys(f.stages).find((k) => phaseKey(k) === phaseKey(n)) ?? n] || '';
  return `<div class="field bk-idea">
    <label class="field inline"><input type="checkbox" id="bk-idea" ${f.idea ? 'checked' : ''}> <b>An idea, not a fixed set</b></label>
    <p class="muted small">Written fresh for each practice: the reps, distances and rounds split differently with about the same yards, unlike the last time it was swum, with send-offs for each group.${f.idea ? ' The lines above are one way to swim it.' : ''}</p>
    ${f.idea ? `<div class="bk-stages">
      <div class="eyebrow">By phase <span class="muted small">(prints with the block in that phase)</span></div>
      ${names.length ? names.map((n) => `<label class="field">${esc(n)}${keys.has(phaseKey(n)) ? '' : ' <span class="muted small">(not in the plan now)</span>'}
        <input type="text" data-stage="${esc(n)}" value="${esc(value(n))}" placeholder="What changes in ${esc(n)}" autocomplete="off"></label>`).join('')
        : '<p class="muted small">Add the season’s phases in Season to write what changes in each.</p>'}
    </div>` : ''}
  </div>`;
}

function linesPreview(ctx, f) {
  const { esc } = ctx;
  const raw = formLines(f).filter((l) => l.trim());
  if (!raw.length) return '<p class="muted small">No lines yet: the block prints its name and notes only.</p>';
  const wctx = ctx.learned.writing;
  const shown = f.idea ? ideaVersion({ id: f.id || 'new', idea: true, lines: formLines(f) }, { date: ctx.state.today, variant: f.version }).lines : formLines(f);
  let lines;
  try { lines = writeLines(shown, wctx, { single: f.session === 'PM', retimeAll: f.source === 'generated' && f.lines === f.origLines }); } catch (e) { console.error(e); return '<p class="form-error">Those lines could not be read.</p>'; }
  const parsed = parseSet(lines.join('\n'));
  const times = groupTimes(formLines(f), wctx);
  const cns = blockCns(lines, wctx.model);
  const dist = setDistance(parsed);
  const gears = setGears(parsed);
  return `<div class="c-preview">
    <div class="eyebrow">${f.idea ? 'One version' : 'As it will print'}</div>
    ${linesHTML(lines)}
    ${f.idea ? '<div class="actions c-tight"><button type="button" class="btn secondary small-btn" id="bk-version">Another version</button></div>' : ''}
    ${times ? `<div class="c-times"><span>Time per group</span><b>${esc(times)}</b></div><div class="muted small">${esc(groupNames(wctx))}</div>` : ''}
    <div class="metrics"><span>Distance <b>${dist}${esc(wctx.unit)}</b></span><span>CNS load <b>${cns}</b></span>${gears.length ? `<span>Gears <b>${esc(gears.join(' '))}</b></span>` : ''}</div>
  </div>`;
}

function bindEditor(ctx, el, ui) {
  const { $, $$, state } = ctx;
  const f = ui.form;
  const form = $('#bk-form', el);
  // The preview is redrawn in place, with its "Another version" button.
  const refreshPreview = () => {
    $('#bk-lines-preview', el).innerHTML = linesPreview(ctx, f);
    bindVersion();
  };
  const bindVersion = () => {
    const btn = $('#bk-version', el);
    if (btn) btn.onclick = () => { f.version += 1; refreshPreview(); };
  };
  bindVersion();
  $$('[data-f]', form).forEach((input) => {
    const key = input.dataset.f;
    input.addEventListener('input', () => {
      f[key] = input.value;
      if (key === 'lines') refreshPreview();
    });
    input.addEventListener('change', () => { f[key] = input.value; if (key === 'measure') convertAmount(ctx, f); });
  });
  ctx.bindChips(form, (name, value) => { if (name === 'session') { f.session = value || 'any'; ctx.rerender(); } });
  $$('[data-gear]', form).forEach((c) => {
    c.onclick = () => {
      const g = c.dataset.gear;
      f.gears = f.gears.includes(g) ? f.gears.filter((x) => x !== g) : [...f.gears, g].sort((a, b) => GEARS.indexOf(a) - GEARS.indexOf(b));
      c.classList.toggle('on'); c.setAttribute('aria-pressed', String(f.gears.includes(g)));
    };
  });
  $$('[data-eq]', form).forEach((c) => {
    c.onclick = () => {
      const k = c.dataset.eq;
      f.equipment = f.equipment.includes(k) ? f.equipment.filter((x) => x !== k) : [...f.equipment, k];
      c.classList.toggle('on'); c.setAttribute('aria-pressed', String(f.equipment.includes(k)));
    };
  });

  $('#bk-idea', el).onchange = (e) => { f.idea = e.target.checked; ctx.rerender(); };
  $$('[data-stage]', form).forEach((input) => {
    input.oninput = () => {
      const k = Object.keys(f.stages).find((x) => phaseKey(x) === phaseKey(input.dataset.stage)) ?? input.dataset.stage;
      f.stages[k] = input.value;
    };
  });

  $('#bk-write', el).onclick = () => {
    const minutes = f.measure === 'minutes' ? +f.amount || 40 : blockMinutes({ category: f.category, distance: +f.amount || 1000 }, state.plan.pace || 100);
    let g;
    try {
      g = generateBlock({
        // An IM race-pace block is the IM gears set; an aerobic or threshold IM block stays aerobic or threshold.
        focus: f.stroke === 'IM' && f.category === 'race' ? 'im' : WRITE_FOCUS[f.category] || 'aerobic',
        minutes: Math.max(10, Math.min(90, minutes)),
        stroke: f.stroke,
        slot: f.session === 'PM' ? 'PM' : 'AM',
        ctx: ctx.learned.writing,
        variant: f.variant++,
      });
    } catch (e) { console.error(e); ctx.toast('Could not write lines for this block'); return; }
    f.lines = g.lines.join('\n');
    if (!f.name.trim()) f.name = g.name;
    if (!f.gears.length) f.gears = [...g.gears];
    f.generatedLines = f.lines;
    ctx.toast(`Wrote ${g.minutes} min for the fastest group`);
    ctx.rerender();
  };

  $('#bk-cancel', el).onclick = () => close(ctx, ui);
  $('#bk-del', el)?.addEventListener('click', async () => {
    if (!(await ctx.confirmAction(`Delete "${f.name || 'this block'}" from the library?`, 'Delete'))) return;
    // Not saved: the app says so and offers Try again (the block stays off the list).
    if (await ctx.save.removeBlock(f.id)) ctx.toast('Block deleted');
    close(ctx, ui);
  });
  // A variant of this block: the form as it is, saved as a new block (the
  // original stays as it was).
  $('#bk-copy', el)?.addEventListener('click', () => {
    const orig = ctx.state.blocks.find((x) => x.id === f.id);
    if (orig && f.name.trim() === orig.name) f.name = `${orig.name} (copy)`;
    f.id = null;
    f.isNew = true;
    $('#bk-save', el).click();
  });
  $('#bk-save', el).onclick = async () => {
    const err = $('#bk-err', el);
    const amount = +f.amount;
    const lines = formLines(f);
    if (!f.name.trim() || !(amount > 0)) { err.textContent = 'Give the block a name and an amount.'; err.hidden = false; return; }
    const gears = f.gears.length ? f.gears : setGears(parseSet(lines.join('\n')));
    // Lines the app wrote and the coach left alone are not the coach's style.
    let source = f.source;
    if (f.generatedLines != null && f.lines === f.generatedLines) source = 'generated';
    else if (f.lines.trim() && f.lines !== f.origLines) source = OWN.includes(source) ? source : 'coach';
    const block = makeBlock({
      id: f.id || undefined, name: f.name, category: f.category, stroke: f.stroke,
      minutes: f.measure === 'minutes' ? amount : null, distance: f.measure === 'distance' ? amount : null,
      intensity: +f.intensity, session: f.session, gears, equipment: f.equipment, lines, detail: f.detail, source,
      sub: f.sub, idea: f.idea, stages: f.stages,
    });
    // Not saved: the app says so and offers Try again; the editor stays open
    // with the edits, and saving again replaces this block (a new one too).
    if (!(await ctx.save.block(block))) {
      f.id = block.id;
      ctx.rerender();
      return;
    }
    let learnedMsg = '';
    if (block.lines.length && OWN.includes(block.source)) {
      const style = await ctx.save.relearn();
      if (style) learnedMsg = ` · learned from ${style.learnedFrom.blocks} block${style.learnedFrom.blocks === 1 ? '' : 's'}`;
    }
    const back = ui.returnTo;
    if (back === 'build') {
      addToDraft(ctx, block);
    } else {
      ctx.toast(`Block saved${learnedMsg}`);
    }
    ui.open[block.id] = true;
    ui.flash = block.id;
    close(ctx, ui, block.id);
  };
}

// Switching time ↔ distance keeps the amount sensible.
function convertAmount(ctx, f) {
  const pace = ctx.state.plan.pace || 100;
  const a = +f.amount;
  if (!(a > 0)) return;
  // With set lines, the other measure comes from the lines (as the preview counts them).
  const lines = formLines(f).filter((l) => l.trim());
  f.amount = f.measure === 'distance'
    ? blockDistance(makeBlock({ category: f.category, minutes: a, lines }), pace)
    : blockMinutes(makeBlock({ category: f.category, distance: a, lines }), pace);
  ctx.rerender();
}

function close(ctx, ui, scrollTo = null) {
  const back = ui.returnTo;
  ui.editing = null;
  ui.form = null;
  ui.returnTo = null;
  ui.session = null;
  if (back) { ctx.go(back); return; }
  ctx.rerender();
  if (scrollTo) document.querySelector(`[data-row="${CSS.escape(scrollTo)}"]`)?.scrollIntoView({ block: 'center' });
}

// ------------------------------------------------------------------ style

function styleHTML(ctx) {
  const { state, esc } = ctx;
  const s = state.style;
  const learned = s?.learnedFrom?.blocks;
  const own = state.blocks.filter((b) => OWN.includes(b.source) && b.lines.length).length;
  const reps = Object.entries(s?.repsByGear || {}).filter(([g]) => /^G\d/.test(g)).sort(([a], [b]) => (a < b ? -1 : 1));
  return `<section class="card" id="bk-style">
    <h2>Your style</h2>
    ${learned ? `<p class="lead">Learned from ${learned} block${learned === 1 ? '' : 's'} (${s.learnedFrom.lines} swim line${s.learnedFrom.lines === 1 ? '' : 's'}). New send-offs and written blocks follow it.</p>
    <dl class="c-facts">
      <div><dt>Interval columns</dt><dd>${s.columns}</dd></div>
      <div><dt>Rest line</dt><dd>${esc(s.restLine)}</dd></div>
      <div><dt>Typical rounds</dt><dd>${s.rounds}</dd></div>
      <div><dt>Typical block</dt><dd>${s.blockMinutes} min</dd></div>
      <div><dt>Easy send-off</dt><dd>${esc(fmtClock(s.easyPer100))} /100</dd></div>
      <div><dt>Interval ratios</dt><dd>${Object.keys(s.ratios || {}).length}</dd></div>
      ${s.roundLongTo5 != null ? `<div><dt>150s and up</dt><dd>${s.roundLongTo5 ? 'on the :05' : 'to the second'}</dd></div>` : ''}
      ${reps.length ? `<div class="c-wide"><dt>Usual reps</dt><dd>${esc(reps.map(([g, d]) => `${g} ${d}s`).join(' · '))}</dd></div>` : ''}
    </dl>` : `<p class="lead">Nothing learned yet. Paste a few of your blocks (with send-offs and a <code>G3 pace</code> row) and the app learns your interval columns, rest and send-off ratios.</p>`}
    <label class="field">Style guide <span class="muted small">(how you write; the coach chat reads this)</span>
      <textarea id="bk-guide" rows="5" placeholder="e.g. Head each block with its minutes. Columns fastest group first. Easy swim between hard sets. Name the drill on every drill line.">${esc(s?.guide || '')}</textarea></label>
    <div class="actions">
      <button type="button" class="btn secondary" id="bk-guide-save" ${uiOf(state).guideUnsaved ? '' : 'disabled'}>Save style guide</button>
      <button type="button" class="btn secondary" id="bk-relearn" ${own || state.log.length ? '' : 'disabled'}>Re-learn from my blocks</button>
    </div>
    <p class="muted small">${own} of your own block${own === 1 ? '' : 's'} with lines${state.log.length ? `, plus ${state.log.length} saved practice${state.log.length === 1 ? '' : 's'}` : ''}. Starter and app-written blocks are not learned from.</p>
  </section>`;
}

function bindStyle(ctx, el) {
  const { $, state } = ctx;
  const ta = $('#bk-guide', el);
  const btn = $('#bk-guide-save', el);
  const ui = uiOf(state);
  const saveGuide = async () => {
    const guide = ta.value.trim();
    if (guide === (state.style?.guide || '') && !ui.guideUnsaved) return;
    state.style = { ...(state.style || {}), guide };
    // Not saved: the app says so and offers Try again; the button stays on.
    ui.guideUnsaved = !(await ctx.save.style());
    if (ui.guideUnsaved) { btn.disabled = false; return; }
    btn.disabled = true;
    ctx.toast('Style guide saved');
  };
  ta.oninput = () => { btn.disabled = !ui.guideUnsaved && ta.value.trim() === (state.style?.guide || ''); };
  ta.onchange = saveGuide;
  btn.onclick = saveGuide;
  $('#bk-relearn', el).onclick = async () => {
    const s = await ctx.save.relearn();
    ctx.toast(s ? `Learned from ${s.learnedFrom.blocks} block${s.learnedFrom.blocks === 1 ? '' : 's'}` : 'Paste or write a block with lines first');
    ctx.rerender();
  };
}

// ------------------------------------------------------------------- data

function dataHTML(ctx) {
  const { state } = ctx;
  const missing = starterBlocks().filter((s) => !state.blocks.some((b) => b.name === s.name));
  return `<section class="card" id="bk-data">
    <h2>Data</h2>
    <p class="muted small">${state.storeKind === 'db' ? 'Blocks, plan, log and debriefs are saved privately with this page and follow you to other devices.' : 'Blocks, plan, log and debriefs live on this device only. Export to back them up or move them.'}</p>
    <div class="actions">
      ${missing.length ? `<button type="button" class="btn secondary" id="bk-restore">Restore ${missing.length} starter block${missing.length === 1 ? '' : 's'}</button>` : ''}
      <button type="button" class="btn secondary" id="bk-export">Export everything</button>
      <label class="btn secondary file-btn">Import<input type="file" id="bk-import" accept="application/json,.json"></label>
    </div>
  </section>`;
}

function bindData(ctx, el) {
  const { $, state } = ctx;
  $('#bk-restore', el)?.addEventListener('click', async () => {
    const missing = starterBlocks().filter((s) => !state.blocks.some((b) => b.name === s.name));
    let saved = 0;
    for (const b of missing) if (await ctx.save.block(b)) saved += 1;
    // Any not saved: the app says so and offers Try again.
    if (saved === missing.length) ctx.toast(`Restored ${missing.length} starter block${missing.length === 1 ? '' : 's'}`);
    ctx.rerender();
  });
  $('#bk-export', el).onclick = async () => {
    const json = await exportAll(ctx.store);
    await ctx.saveFile(`practice-writer-${state.today}.json`, json);
  };
  $('#bk-import', el).onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    let text;
    try { text = await file.text(); JSON.parse(text); } catch { ctx.toast('That file could not be read'); return; }
    if (!(await ctx.confirmAction(`Import ${file.name}? Blocks, practices and debriefs in it are added, or replace the ones here with the same id; nothing here is deleted. Its season plan, settings and style replace the ones here.`, 'Import', { danger: false }))) { e.target.value = ''; return; }
    let saved;
    try {
      saved = await importAll(ctx.store, text);
    } catch (err) {
      console.error(err);
      ctx.toast('That file could not be imported');
      e.target.value = '';
      ctx.rerender();
      return;
    }
    // A failed write has already said "Not saved" (and offers Try again).
    try {
      Object.assign(state, await loadAll(ctx.store));
      updateDebriefDot();
      if (saved) ctx.toast('Imported');
    } catch (err) {
      console.error(err);
      ctx.toast("Imported, but your saved data couldn't be read back just now. Reload the page to see it.", { error: true });
    }
    e.target.value = '';
    ctx.rerender();
  };
}
