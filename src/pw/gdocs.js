// Google Docs from the page: the claude.ai Artifact `mcp` capability calls the
// coach's own Google Drive and Google Docs connectors (their credentials,
// their consent). Creates the week's doc and appends practices to it in the
// coach's format (src/gdoc.js). Every write is one click, never repeated
// on its own: a write whose outcome is unknown is reported, not retried.

import { CATEGORIES, recordComposed, shareLine, weekdayIndex } from '../practice.js';
import { appendRequests, docEnd, sessionParagraphs } from '../gdoc.js';
import { blockLines, circuitLines } from './render.js';

export const DRIVE = 'Google Drive';
export const DOCS = 'Google Docs';

let mcpReady = null;
let mcpAsking = null;
// The capability namespace, or null outside claude.ai or without the grant
// (the platform answers null within about 10 s when no viewer serves it).
// Only a namespace is kept: after a null the next click asks again.
export async function connectors() {
  if (mcpReady) return mcpReady;
  const use = globalThis.window?.claude?.use;
  if (typeof use !== 'function') return null;
  if (!mcpAsking) {
    let timer;
    mcpAsking = Promise.race([window.claude.use('mcp'), new Promise((r) => { timer = setTimeout(() => r(null), 12000); })])
      .catch(() => null)
      .finally(() => { clearTimeout(timer); mcpAsking = null; });
  }
  const m = await mcpAsking;
  if (m) mcpReady = m;
  return m;
}

// Errors carry the step that failed (find, read, create, append, link), so
// the coach is told whether anything may have been written.
const tagged = (e, op, server) => ({ ...(e && typeof e === 'object' ? e : { code: 'upstream_error', message: String(e) }), op, server: e?.server || server });
const UNKNOWN = new Set(['server_unavailable', 'upstream_error', 'cancelled', 'rate_limited']);
// A write whose answer never came may or may not have happened.
export const outcomeUnknown = (e) => !e?.code || UNKNOWN.has(e.code);

const payloadOf = (res) => res?.payload ?? res;
const docJson = (p) => (p?.content?.documentId ? p.content : p);

// What to tell the coach, by error code and by the step that failed: only a
// create or an append can have changed Drive when the answer never came.
export function docsErrorText(e, server = DOCS) {
  const name = e?.server || server;
  const op = e?.op || 'append';
  const unknown = outcomeUnknown(e);
  if (unknown && op === 'create') return `${name} didn't answer, so the doc may or may not have been created. Look for “${e.title || 'it'}” in Drive (or link it here) before trying again.`;
  if (unknown && op === 'append') return `${name} didn't answer, so the sessions may or may not be in the doc. Open it to check before adding again.`;
  if (unknown) return `${name} didn't answer. Nothing was changed; try again in a moment.`;
  switch (e?.code) {
    case 'needs_reauth': return `Reconnect ${name} in claude.ai Settings → Connectors, then try again.`;
    case 'server_not_connected': return `Add the ${name} connector in claude.ai Settings → Connectors to write practices into Google Docs.`;
    case 'selection_required': return `Choose which ${name} connector this page should use (claude.ai asks once), then try again.`;
    case 'approval_required': return `${name} needs your approval for this page. claude.ai asks when you press the button with the page open there.`;
    case 'consent_required': return `Allow ${name} for this page when claude.ai asks, then try again.`;
    case 'user_changed': return 'You signed in as someone else. Reload the page.';
    case 'not_in_manifest': return `${name} is turned off for this page. Turn it on in the page's Permissions menu.`;
    case 'blocked_by_policy': return `Your organization blocks ${name} for this page.`;
    case 'server_not_found': return `${name} isn't connected any more. Add it again in claude.ai Settings → Connectors.`;
    case 'not_granted': case 'capability_disabled': case 'capability_removed':
      return 'Google Docs only works in the claude.ai version of this page.';
    case 'tool_error': return `${name} refused: ${String(e.message || '').slice(0, 200)}`;
    default: return `This page couldn't call ${name} (${e.code}). Reload the page and try again.`;
  }
}

// A block's name without its own "N min" / "500y" lead ("14 min steady" →
// "steady"), or its category when that leaves nothing.
function bareName(b) {
  const n = String(b.name || '').replace(/^\s*\d+(?:\.\d+)?\s*(?:min|y|yd|m)\b\s*/i, '').replace(/^[-–:·\s]+/, '').trim();
  return n || CATEGORIES[b.category]?.label || 'Set';
}

// One record → the doc sections: each block as written that day (its saved
// send-offs kept, not re-timed by later debriefs); blended blocks as one
// circuit with its rounds.
export function recordSections(record, ctx) {
  // Composed as the app composes saved practices (a block measured in yards
  // shares out its yards), so the doc matches the log.
  const blocks = (record.blocks || []).map((b) => ({ equipment: [], ...b, source: 'saved', circuit: !!b.circuit }));
  const composed = recordComposed({ ...record, blocks }, ctx.state.plan);
  const unit = composed.unit;
  // Descriptions go in when the coach shows them (Build's "Show block descriptions").
  const desc = (b) => (ctx.state.prefs?.showDetail === false ? '' : String(b.detail || '').trim());
  return composed.sections.map((s) => {
    if (s.type === 'block') {
      const lines = blockLines(s.block, ctx, null, record.slot || 'AM');
      return { title: s.block.name, minutes: s.block.minutes || s.minutes, note: desc(s.block), lines };
    }
    const lines = s.rounds > 1 ? [`${s.rounds} rounds:`] : [];
    s.items.forEach((it, i) => {
      const ls = circuitLines(it, ctx, record.slot || 'AM');
      if (i) lines.push('');
      lines.push(...(ls.length ? ls : [shareLine(it, unit)]));
      if (desc(it.block)) lines.push({ note: desc(it.block) });
    });
    return { title: s.items.map((it) => bareName(it.block)).join(' + '), minutes: s.minutes, lines };
  });
}

// Records → paragraphs in day order (AM before PM).
export function recordsParagraphs(records, ctx) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.slot || 'AM') < (b.slot || 'AM') ? -1 : 1));
  const groups = ctx.learned?.writing?.groups || [];
  return sorted.flatMap((r) => sessionParagraphs({ weekday: weekdayIndex(r.date), slot: r.slot || 'AM', sections: recordSections(r, ctx), groups }));
}

// A read retried once when the runtime says a retry can work (a first
// consent prompt that could not be answered, an upstream blip), after the
// wait it asks for plus a little jitter; a wait over 15 s is not worth it.
async function read(mcp, server, tool, input, op = 'read') {
  try {
    return payloadOf(await mcp.callTool(server, tool, input, { cache: false }));
  } catch (e) {
    if (!e?.retryable || (e.retryAfterMs ?? 0) > 15000) throw tagged(e, op, server);
    await new Promise((r) => setTimeout(r, (e.retryAfterMs ?? 1000) + Math.random() * 1000));
    try {
      return payloadOf(await mcp.callTool(server, tool, input, { cache: false }));
    } catch (e2) {
      throw tagged(e2, op, server);
    }
  }
}

export async function readDoc(mcp, documentId) {
  return docJson(await read(mcp, DOCS, 'read_doc', { documentId }));
}

const fileRef = (f, title = '') => ({ id: f.id, title: f.title || title || 'Google Doc', url: `https://docs.google.com/document/d/${f.id}/edit`, folderId: f.parentId || null });

// Docs with exactly this title (in the folder when one is set), newest first.
export async function findDocs(mcp, title, folderId = null) {
  const q = [`title = '${String(title).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, "mimeType = 'application/vnd.google-apps.document'"];
  if (folderId) q.push(`parentId = '${folderId}'`);
  const res = await read(mcp, DRIVE, 'search_files', { query: q.join(' and '), excludeContentSnippets: true, pageSize: 10 }, 'find');
  const seen = new Set();
  return (res?.files || [])
    .filter((f) => f.id && f.title === title && !seen.has(f.id) && seen.add(f.id))
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')))
    .map((f) => fileRef(f));
}

// A new empty Google Doc in the chosen folder (or My Drive).
export async function createDoc(mcp, { title, folderId = null }) {
  const input = { title, contentMimeType: 'application/vnd.google-apps.document' };
  if (folderId) input.parentId = folderId;
  let f;
  try {
    f = payloadOf(await mcp.callTool(DRIVE, 'create_file', input));
  } catch (e) {
    throw { ...tagged(e, 'create', DRIVE), title };
  }
  if (!f?.id) throw { code: 'upstream_error', server: DRIVE, op: 'create', title, message: 'no file id' };
  return fileRef(f, title);
}

// Append practices to the end of a doc. A refused batch because the doc
// changed (revision mismatch) applied nothing, so it is read again and sent
// once more; any other failure is thrown to the caller.
export async function appendRecords(mcp, documentId, records, ctx) {
  const paragraphs = recordsParagraphs(records, ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const doc = await readDoc(mcp, documentId);
    const args = appendRequests(doc, paragraphs);
    if (!args.writeControl.requiredRevisionId) throw { code: 'upstream_error', server: DOCS, op: 'read', message: 'no revision' };
    try {
      await mcp.callTool(DOCS, 'update_doc', { documentId, requests: args.requests, writeControl: args.writeControl });
      return { title: docEnd(doc).title, paragraphs: paragraphs.length };
    } catch (e) {
      const changed = e?.code === 'tool_error' && /revision/i.test(String(e.message || ''));
      if (!changed || attempt) throw tagged(e, 'append', DOCS);
    }
  }
  return null;
}

// Title, link and folder of an existing doc (to link it to a week).
export async function docInfo(mcp, documentId) {
  const f = await read(mcp, DRIVE, 'get_file_metadata', { fileId: documentId, excludeContentSnippets: true }, 'link');
  if (f?.mimeType && f.mimeType !== 'application/vnd.google-apps.document') throw { code: 'not_a_doc', message: f.title || '' };
  return fileRef({ ...f, id: f?.id || documentId });
}
