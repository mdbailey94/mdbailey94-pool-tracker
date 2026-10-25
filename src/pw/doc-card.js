// The week's Google Doc: the coach writes each week in one doc ("Week 3 B2")
// in a shared folder. This links or creates that doc and appends written
// sessions to it in their format. Each write is one click; nothing is sent
// on load. Records remember the doc they went to (record.doc), so the card
// can say what is still to add.

import { addDays, longDate, mondayOf, planPosition } from '../practice.js';
import { docIdFrom, weekDocTitle } from '../gdoc.js';
import { appendRecords, connectors, createDoc, docInfo, docsErrorText, DRIVE, findDocs, outcomeUnknown } from './gdocs.js';

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
    ${pending.length ? `<button type="button" class="btn" id="doc-add" ${docBusy() ? 'disabled' : ''}>${docBusy() ? 'Adding…' : `Add ${pending.length === 1 ? 'it' : `${pending.length} sessions`} to the doc`}</button>` : ''}
    ${linkForm}
  </section>`;
}

export function bindDocCard(ctx, el, week) {
  const { $ } = ctx;
  const monday = week.monday;
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
