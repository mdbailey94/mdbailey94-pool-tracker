// The week's Google Doc: the coach writes each week in one doc ("Week 3 B2")
// in a shared folder. This links or creates that doc and appends written
// sessions to it in their format. Each write is one click; nothing is sent
// on load. Records remember the doc they went to (record.doc), so the card
// can say what is still to add.

import { CATEGORIES, addDays, composePractice, dayLabel, longDate, makeBlock, mondayOf, planPosition, sessionsOn } from '../practice.js';
import { docIdFrom, weekDocTitle } from '../gdoc.js';
import { blockFromDoc, docSessions, nameKey, scanPlan } from '../docscan.js';
import { appendRecords, connectors, createDoc, docInfo, docsErrorText, DRIVE, findDocs, outcomeUnknown, readDoc } from './gdocs.js';
import { practiceTextFor } from './render.js';
import { savedRecord } from './load.js';

export const weekDocFor = (plan, monday) => plan.weekDocs?.[monday] || null;

// The title the coach would give this week's doc.
export function docTitleFor(plan, monday) {
  const pos = planPosition(plan, monday);
  return pos.phase && pos.status === 'in' ? weekDocTitle(pos.phase, pos.phaseWeek, plan.phases, pos.phaseIndex) : `Week of ${monday}`;
}

export const inDoc = (r, doc) => !!(doc && r?.doc?.id === doc.id);

// Adds run one after another: a second click while one is running waits its
// turn instead of being dropped (and re-checks what is already in).
let queue = Promise.resolve();
let running = 0;
export const docBusy = () => running > 0;

// Weeks whose last append or create got no answer (outcome unknown): the
// card says so and the next try asks first. Kept for this page's life.
const unsure = new Map(); // monday → { docId } after an append, { title } after a create

const ui = { linking: false, link: '', week: null, busy: false };
const NO_MCP = "Google Docs isn't available to this page right now. Reload the page and try again.";
const plainRecord = (r) => { const { doc, docEdited, ...rest } = r || {}; return rest; };

// Resolves true when the link was saved. A doc the coach made (found in
// Drive or linked by URL) also sets the folder new week docs go in, when
// none is set; a doc the app created does not (it may be in My Drive).
async function linkWeek(ctx, monday, doc, { adoptFolder = true } = {}) {
  const { plan } = ctx.state;
  plan.weekDocs = { ...(plan.weekDocs || {}), [monday]: { id: doc.id, title: doc.title, url: doc.url } };
  if (adoptFolder && !plan.docs?.folderId && doc.folderId) plan.docs = { ...(plan.docs || {}), folderId: doc.folderId, folderFrom: doc.title };
  return ctx.save.plan();
}

// The week's doc, set up on first use: a doc already in Drive with the
// week's title is used (in the folder first, then anywhere), else, after
// asking, a new one in the folder.
async function ensureWeekDoc(ctx, mcp, monday, note) {
  const { plan } = ctx.state;
  const have = weekDocFor(plan, monday);
  if (have) return have;
  const title = docTitleFor(plan, monday);
  const folderId = plan.docs?.folderId || null;
  let found = await findDocs(mcp, title, folderId);
  if (!found.length && folderId) found = await findDocs(mcp, title, null);
  if (found.length) {
    if (found.length > 1 && !(await ctx.confirmAction(`There are ${found.length} docs named “${title}”. Use the one edited most recently?`, 'Use it', { danger: false }))) return null;
    if (!(await linkWeek(ctx, monday, found[0]))) note.linkNotSaved = true;
    return found[0];
  }
  const askedBefore = unsure.get(monday)?.title === title;
  const ask = askedBefore
    ? `Google Drive didn't answer when “${title}” was created last time, so it may already exist. Look in Drive first. Create it anyway?`
    : `There's no doc named “${title}”${folderId ? ' in your practice folder' : ' in your Drive'}. Create it?`;
  if (!(await ctx.confirmAction(ask, askedBefore ? 'Create anyway' : 'Create the doc', { danger: false }))) return null;
  let doc;
  try {
    doc = await createDoc(mcp, { title, folderId });
  } catch (e) {
    if (outcomeUnknown(e)) unsure.set(monday, { title });
    throw e;
  }
  unsure.delete(monday);
  if (!(await linkWeek(ctx, monday, doc, { adoptFolder: false }))) note.linkNotSaved = true;
  return doc;
}

async function send(ctx, records) {
  const mcp = await connectors();
  if (!mcp) { ctx.toast(NO_MCP, { error: true }); return 0; }
  const current = (r) => ctx.state.log.find((x) => x.id === r.id) || null;
  let added = 0;
  try {
    const weeks = new Map();
    for (const r of records) {
      const m = mondayOf(r.date);
      if (!weeks.has(m)) weeks.set(m, []);
      weeks.get(m).push(r);
    }
    for (const [monday, recs] of [...weeks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const note = {};
      const doc = await ensureWeekDoc(ctx, mcp, monday, note);
      if (!doc) break;
      // What is still to add, now that the doc is known (and as the records
      // are now: one deleted meanwhile is skipped).
      const todo = recs.map(current).filter((r) => r && !inDoc(r, doc));
      if (!todo.length) { ctx.toast(`Already in “${doc.title}”`); continue; }
      if (unsure.get(monday)?.docId === doc.id
        && !(await ctx.confirmAction(`Google Docs didn't answer the last time sessions were added to “${doc.title}”, so they may already be in it. Open the doc to check. Add ${todo.length === 1 ? 'it' : 'them'} anyway?`, 'Add anyway', { danger: false }))) break;
      ctx.toast(`Adding ${todo.length === 1 ? 'the session' : `${todo.length} sessions`} to “${doc.title}”…`);
      const sent = new Map(todo.map((r) => [r.id, JSON.stringify(plainRecord(r))]));
      try {
        await appendRecords(mcp, doc.id, todo, ctx);
      } catch (e) {
        if (outcomeUnknown(e)) unsure.set(monday, { docId: doc.id });
        throw e;
      }
      unsure.delete(monday);
      // Mark each record on its current copy. One edited while it was being
      // sent went in as it was before: it is marked edited-after, not in.
      const at = Date.now();
      let noted = true;
      for (const r of todo) {
        const cur = current(r);
        if (!cur) continue;
        const changed = JSON.stringify(plainRecord(cur)) !== sent.get(r.id);
        const mark = changed ? { docEdited: { id: doc.id, at } } : { doc: { id: doc.id, at } };
        if (!(await ctx.save.log({ ...plainRecord(cur), ...mark }))) noted = false;
      }
      added += todo.length;
      // In the doc, but the record of that was not saved: say so (over the
      // app's "Not saved"), so the coach doesn't add them a second time.
      if (!noted) {
        ctx.toast(`Added to “${doc.title}”, but the app couldn't record that. Don't add ${todo.length === 1 ? 'it' : 'them'} again.`, { error: true });
        break;
      }
      if (note.linkNotSaved) ctx.toast(`Added to “${doc.title}” (the link to this week wasn't saved)`, { force: true });
      else ctx.toast(`Added to “${doc.title}”`);
    }
  } catch (e) {
    console.warn('Google Docs', e);
    ctx.toast(docsErrorText(e), { error: true });
  }
  return added;
}

// Append records (any weeks) to their weeks' docs, in day order. Resolves
// with how many were added.
export function addToDoc(ctx, records) {
  running += 1;
  if (running > 1) ctx.toast('Adding after the one in progress…');
  ctx.rerender();
  const run = queue.then(() => send(ctx, records)).finally(() => { running -= 1; ctx.rerender(); });
  queue = run.catch(() => 0);
  return run;
}

// Records of the week that are written but not in its doc yet.
function pendingFor(ctx, week) {
  const doc = weekDocFor(ctx.state.plan, week.monday);
  return week.days.flatMap((d) => d.sessions.map((s) => s.record).filter(Boolean)).filter((r) => !inDoc(r, doc));
}

function statusText(written, pending, doc) {
  const n = written.length;
  if (!n) return 'Nothing written this week yet.';
  if (!doc) return `${n} written session${n === 1 ? '' : 's'} to add.`;
  if (!pending.length) return n === 1 ? 'The written session is in the doc.' : `All ${n} written sessions are in the doc.`;
  return n === 1 ? 'The written session is not in the doc yet.' : `${n - pending.length} of ${n} written sessions are in the doc.`;
}

export function docCardHTML(ctx, week) {
  const { state, esc } = ctx;
  const doc = weekDocFor(state.plan, week.monday);
  const title = doc?.title || docTitleFor(state.plan, week.monday);
  const written = week.days.flatMap((d) => d.sessions.map((s) => s.record).filter(Boolean));
  const pending = pendingFor(ctx, week);
  if (!ctx.isArtifact) {
    return `<section class="card wk-doc"><div class="eyebrow">Google Doc</div>
      <p class="small muted">Open this page in claude.ai to write each week into your Google Doc (“${esc(title)}”). Here, use Copy in the Log.</p></section>`;
  }
  if (ui.linking && ui.week !== week.monday) Object.assign(ui, { linking: false, link: '' });
  const edited = doc ? pending.filter((r) => r.docEdited?.id === doc.id).length : 0;
  const editedNote = edited ? ` ${edited === 1 ? 'One was' : `${edited} were`} edited after going in: the doc still has the earlier version, and adding puts the new one at the end.` : '';
  const u = unsure.get(week.monday);
  const unsureNote = doc && u?.docId === doc.id ? '<p class="small wk-doc-warn">Google Docs didn\'t answer the last add, so those sessions may already be in the doc. Open it to check before adding again.</p>'
    : !doc && u?.title ? `<p class="small wk-doc-warn">Google Drive didn't answer when “${esc(u.title)}” was created, so it may already exist. Look in Drive, or link it here.</p>` : '';
  const folder = state.plan.docs?.folderId;
  const folderNote = folder ? `New week docs are created ${state.plan.docs.folderFrom ? `next to “${esc(state.plan.docs.folderFrom)}”` : 'in your practice folder'}.` : 'New week docs are created in My Drive. Linking a doc you made sets its folder for the next ones.';
  const linkForm = ui.linking ? `<form class="wk-doc-link" id="doc-link-form">
      <label class="field">Link to the week's Google Doc<input type="url" id="doc-link" value="${esc(ui.link)}" placeholder="https://docs.google.com/document/d/…" required ${ui.busy ? 'disabled' : ''}></label>
      <p class="small muted">${folderNote}</p>
      <div class="actions"><button type="submit" class="btn small-btn" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Checking…' : 'Use this doc'}</button>
      ${doc ? '<button type="button" class="btn secondary small-btn" id="doc-unlink">Unlink</button>' : ''}
      ${folder ? '<button type="button" class="btn secondary small-btn" id="doc-folder-clear">Use My Drive for new docs</button>' : ''}
      <button type="button" class="btn secondary small-btn" id="doc-link-cancel">Cancel</button></div>
    </form>` : '';
  return `<section class="card wk-doc">
    <div class="wk-doc-head">
      <div><div class="eyebrow">Google Doc</div>
        <h3>${doc ? `<a href="${esc(doc.url)}" target="_blank" rel="noopener">${esc(title)}</a>` : esc(title)}</h3></div>
      ${ui.linking ? '' : `<button type="button" class="btn secondary small-btn" id="doc-change">${doc ? 'Change doc' : 'Link a doc'}</button>`}
    </div>
    <p class="small muted">${esc(statusText(written, pending, doc) + editedNote)}${doc ? '' : ' The doc is found in your Drive by its title, or created when you add the first session.'}</p>
    ${unsureNote}
    <div class="actions wk-doc-actions">
      ${pending.length ? `<button type="button" class="btn" id="doc-add" ${docBusy() ? 'disabled' : ''}>${docBusy() ? 'Adding…' : `Add ${pending.length === 1 ? 'it' : `${pending.length} sessions`} to the doc`}</button>` : ''}
      ${doc && !(scan?.monday === week.monday) ? `<button type="button" class="btn secondary" id="doc-scan" ${scanBusy ? 'disabled' : ''}>${scanBusy ? 'Reading the doc…' : 'Fill in from the doc'}</button>` : ''}
    </div>
    ${scan?.monday === week.monday ? scanHTML(ctx, scan) : ''}
    ${linkForm}
  </section>`;
}

export function bindDocCard(ctx, el, week) {
  const { $ } = ctx;
  const monday = week.monday;
  bindScan(ctx, el, week);
  $('#doc-add', el)?.addEventListener('click', () => addToDoc(ctx, pendingFor(ctx, week)));
  $('#doc-change', el)?.addEventListener('click', () => { Object.assign(ui, { linking: true, link: '', week: monday }); ctx.rerender(); $('#doc-link')?.focus(); });
  $('#doc-link-cancel', el)?.addEventListener('click', () => { Object.assign(ui, { linking: false, link: '' }); ctx.rerender(); });
  $('#doc-unlink', el)?.addEventListener('click', async () => {
    const { plan } = ctx.state;
    const rest = { ...(plan.weekDocs || {}) };
    delete rest[monday];
    plan.weekDocs = rest;
    ui.linking = false;
    await ctx.save.plan();
    ctx.rerender();
  });
  $('#doc-folder-clear', el)?.addEventListener('click', async () => {
    const { plan } = ctx.state;
    plan.docs = { ...(plan.docs || {}), folderId: null, folderFrom: null };
    if (await ctx.save.plan()) ctx.toast('New week docs will go in My Drive');
    ctx.rerender();
  });
  $('#doc-link-form', el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    const link = $('#doc-link', el).value;
    const id = docIdFrom(link);
    if (!id) { ctx.toast('Paste the link of a Google Doc (docs.google.com/document/…).', { error: true }); return; }
    Object.assign(ui, { busy: true, link });
    ctx.rerender();
    try {
      const mcp = await connectors();
      if (!mcp) { ctx.toast(NO_MCP, { error: true }); return; }
      const doc = await docInfo(mcp, id);
      // Not saved: the app says so and offers Try again; the form stays open
      // with the link, to press Use this doc again.
      if (await linkWeek(ctx, monday, doc)) {
        Object.assign(ui, { linking: false, link: '' });
        unsure.delete(monday);
        const shown = mondayOf(ctx.state.ui?.week || monday) === monday;
        ctx.toast(shown ? `This week now goes into “${doc.title}”` : `The week of ${longDate(monday)} – ${longDate(addDays(monday, 6))} now goes into “${doc.title}”`);
      }
    } catch (err) {
      ctx.toast(err?.code === 'not_a_doc' ? 'That link is not a Google Doc.' : docsErrorText(err, DRIVE), { error: true });
    } finally {
      ui.busy = false;
      ctx.rerender();
    }
  });
}

// ------------------------------------------------- filling in from the doc
//
// "Fill in from the doc" reads the week's doc and lists what is written
// there: each session, whether the app already has a practice for it, and
// the blocks it doesn't know (to add to the library, in a category). Nothing
// is saved until the coach presses Fill in. Practices filled in are marked
// as in the doc, so "Add to the doc" never writes them a second time.

let scan = null; // { monday, docId, sessions, pick: { key: 'add'|'skip'|'replace' }, lib: { key: { add, category } } }
let scanBusy = false;
const sessionKey = (s) => `${s.date}|${s.slot}`;
const blockKey = (b) => `${nameKey(b.name)}|${b.lines.join('\n')}`;

// The blocks of the picked sessions that aren't in the library, once each.
function newBlocks(sc) {
  const out = new Map();
  for (const s of sc.sessions) {
    if (sc.pick[sessionKey(s)] === 'skip') continue;
    for (const b of s.blocks) if (!b.match && !out.has(blockKey(b))) out.set(blockKey(b), b);
  }
  return [...out.entries()];
}

function scanHTML(ctx, sc) {
  const { esc } = ctx;
  if (!sc.sessions.length) {
    return `<div class="wk-scan"><p class="small">Nothing written for this week in the doc yet (it reads day headings like “Tuesday” or “Tuesday PM” and the blocks under them).</p>
      <div class="actions"><button type="button" class="btn secondary small-btn" id="scan-cancel">Close</button></div></div>`;
  }
  const rows = sc.sessions.map((s) => {
    const k = sessionKey(s);
    const pick = sc.pick[k];
    const fromDoc = s.existing?.doc?.id === sc.docId;
    return `<div class="wk-scan-s ${pick === 'skip' ? 'is-off' : ''}">
      <div class="wk-scan-head"><b>${esc(dayLabel(s.date))} · ${esc(s.slot)}</b>${s.copies > 1 ? `<span class="muted small">written ${s.copies} times in the doc; using the first</span>` : ''}</div>
      ${s.existing ? `<label class="field inline small"><select data-scan-pick="${esc(k)}">
          <option value="skip" ${pick === 'skip' ? 'selected' : ''}>${fromDoc ? 'Already filled in from the doc: keep' : 'Keep the practice already in the app'}</option>
          <option value="replace" ${pick === 'replace' ? 'selected' : ''}>Replace it with the doc's</option></select></label>`
        : `<label class="field inline small"><input type="checkbox" data-scan-pick="${esc(k)}" ${pick !== 'skip' ? 'checked' : ''}> Fill in</label>`}
      <ul class="wk-scan-blocks">${s.blocks.map((b) => `<li><span>${esc(b.name)}${b.minutes ? ` · ${b.minutes} min` : ''}</span>${b.match ? `<span class="doc-tag">in your library${nameKey(b.match.name) === nameKey(b.name) ? '' : `: ${esc(b.match.name)}`}</span>` : '<span class="doc-tag new">new</span>'}</li>`).join('')}</ul>
    </div>`;
  }).join('');
  const fresh = newBlocks(sc);
  const lib = fresh.length ? `<div class="wk-scan-new">
      <p class="small"><b>${fresh.length === 1 ? 'This block isn\'t' : `These ${fresh.length} blocks aren't`} in your library.</b> Add ${fresh.length === 1 ? 'it' : 'them'} so ${fresh.length === 1 ? 'it' : 'they'} can be suggested and reused, and your style is learned from ${fresh.length === 1 ? 'it' : 'them'}:</p>
      ${fresh.map(([k, b]) => {
        const c = sc.lib[k] ||= { add: true, category: blockFromDoc(b, ctx.learned.writing).category };
        return `<div class="wk-scan-b"><label class="field inline small"><input type="checkbox" data-lib-add="${esc(k)}" ${c.add ? 'checked' : ''}> <b>${esc(b.name)}</b>${b.minutes ? ` · ${b.minutes} min` : ''} · ${b.lines.length} line${b.lines.length === 1 ? '' : 's'}</label>
          <select data-lib-cat="${esc(k)}" aria-label="Category of ${esc(b.name)}" ${c.add ? '' : 'disabled'}>${Object.entries(CATEGORIES).map(([v, x]) => `<option value="${v}" ${c.category === v ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div>`;
      }).join('')}
    </div>` : '';
  const n = sc.sessions.filter((s) => sc.pick[sessionKey(s)] !== 'skip').length;
  return `<div class="wk-scan">
    <p class="small"><b>In the doc:</b> ${sc.sessions.length} session${sc.sessions.length === 1 ? '' : 's'}. Pick what to fill in.</p>
    ${rows}
    ${lib}
    <div class="actions">
      <button type="button" class="btn" id="scan-go" ${n && !scanBusy ? '' : 'disabled'}>${scanBusy ? 'Filling in…' : `Fill in ${n} session${n === 1 ? '' : 's'}`}</button>
      <button type="button" class="btn secondary" id="scan-cancel">Cancel</button>
    </div>
  </div>`;
}

async function readWeek(ctx, week) {
  const doc = weekDocFor(ctx.state.plan, week.monday);
  if (!doc || scanBusy) return;
  const mcp = await connectors();
  if (!mcp) { ctx.toast(NO_MCP, { error: true }); return; }
  scanBusy = true;
  ctx.rerender();
  try {
    const raw = await readDoc(mcp, doc.id);
    const sessions = scanPlan(docSessions(raw, week.monday), { library: ctx.state.blocks, log: ctx.state.log });
    scan = { monday: week.monday, docId: doc.id, sessions, lib: {}, pick: Object.fromEntries(sessions.map((s) => [sessionKey(s), s.existing ? 'skip' : 'add'])) };
  } catch (e) {
    console.warn('Google Docs', e);
    ctx.toast(docsErrorText({ ...e, op: e?.op || 'read' }, e?.server || 'Google Docs'), { error: true });
  } finally {
    scanBusy = false;
    ctx.rerender();
  }
}

// Saves what was picked: the new blocks chosen for the library, then a
// practice per session (replacing the app's one where asked), marked as
// in the doc. Returns how many practices were filled in.
async function fillIn(ctx) {
  const sc = scan;
  const { state } = ctx;
  scanBusy = true;
  ctx.rerender();
  let filled = 0;
  let added = 0;
  try {
    const made = new Map();
    for (const [k, b] of newBlocks(sc)) {
      const c = sc.lib[k] || { add: true };
      const block = makeBlock({ ...blockFromDoc(b, ctx.learned.writing), ...(c.category ? { category: c.category } : {}) });
      if (c.add && (await ctx.save.block(block))) added += 1;
      made.set(k, block);
    }
    const at = Date.now();
    for (const s of sc.sessions) {
      const pick = sc.pick[sessionKey(s)];
      if (pick === 'skip') continue;
      const blocks = s.blocks.map((b) => {
        const base = b.match || made.get(blockKey(b));
        return { ...base, name: b.name, minutes: b.minutes || base.minutes || null, distance: b.minutes ? null : base.distance, lines: b.lines, detail: b.extra || base.detail || '', circuit: false };
      });
      const plan = state.plan;
      const composed = composePractice({ blocks, rounds: 1, pace: plan.pace, unit: plan.unit });
      const focus = sessionsOn(plan, s.date).sessions.find((x) => x.slot === s.slot)?.focus || 'aerobic';
      const title = s.note.length > 80 ? `${s.note.slice(0, 78)}…` : s.note;
      const meta = { title, date: s.date, focus, slot: s.slot };
      const rec = savedRecord(ctx, { ...meta, position: planPosition(plan, s.date), blocks, rounds: 1, pattern: 'even', composed, text: practiceTextFor(composed, ctx, meta) });
      if (pick === 'replace' && s.existing) { rec.id = s.existing.id; rec.createdAt = s.existing.createdAt || rec.createdAt; }
      rec.doc = { id: sc.docId, at };
      if (await ctx.save.log(rec)) filled += 1;
    }
    if (added) await ctx.save.relearn();
    scan = null;
    ctx.toast(`Filled in ${filled} session${filled === 1 ? '' : 's'} from the doc${added ? ` · ${added} block${added === 1 ? '' : 's'} added to your library` : ''}`);
  } finally {
    scanBusy = false;
    ctx.rerender();
  }
  return filled;
}

function bindScan(ctx, el, week) {
  const { $, $$ } = ctx;
  $('#doc-scan', el)?.addEventListener('click', () => readWeek(ctx, week));
  $('#scan-cancel', el)?.addEventListener('click', () => { scan = null; ctx.rerender(); });
  $('#scan-go', el)?.addEventListener('click', () => { if (scan && !scanBusy) fillIn(ctx); });
  $$('[data-scan-pick]', el).forEach((input) => {
    input.onchange = () => {
      scan.pick[input.dataset.scanPick] = input.type === 'checkbox' ? (input.checked ? 'add' : 'skip') : input.value;
      ctx.rerender();
    };
  });
  $$('[data-lib-add]', el).forEach((input) => {
    input.onchange = () => { (scan.lib[input.dataset.libAdd] ||= {}).add = input.checked; ctx.rerender(); };
  });
  $$('[data-lib-cat]', el).forEach((select) => {
    select.onchange = () => { (scan.lib[select.dataset.libCat] ||= { add: true }).category = select.value; };
  });
}
