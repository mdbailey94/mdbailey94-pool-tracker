import test from 'node:test';
import assert from 'node:assert/strict';
import { composePractice, defaultPlan, practiceRecord, starterBlocks } from '../src/practice.js';
import { writingContext } from '../src/setlang.js';
import { appendRecords, docsErrorText, findDocs, recordsParagraphs } from '../src/pw/gdocs.js';
import { docTitleFor } from '../src/pw/doc-card.js';

const plan = defaultPlan('2026-10-19');
const ctx = { state: { plan, debriefs: [] }, learned: { writing: writingContext(plan, {}) } };
const lib = starterBlocks();
function rec(date, slot, blocks, rounds = 1, pattern = 'even') {
  const composed = composePractice({ blocks, rounds, pattern, pace: plan.pace, unit: plan.unit });
  return practiceRecord({ date, slot, focus: 'aerobic', blocks, rounds, pattern, composed, text: '' });
}
const emptyDoc = (rev = 'r1') => ({ content: { documentId: 'D', revisionId: rev, title: 'Week 3 B2', body: { content: [{ endIndex: 1 }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n', textStyle: {} } }] } }] } } });

test('records go into the doc in day order, AM before PM, with block and circuit headings', () => {
  const lined = { ...lib[1], lines: ['4 x 100 free   1:20 | 1:25'], circuit: true };
  const recs = [
    rec('2026-10-22', 'PM', [lib[0]]),
    rec('2026-10-20', 'AM', [lib[0], lined, { ...lib[2], circuit: true }], 3, 'descend'),
    rec('2026-10-22', 'AM', [lib[0]]),
  ];
  const texts = recordsParagraphs(recs, ctx).filter((p) => p.bold).map((p) => p.text);
  assert.deepEqual(texts.filter((t) => /day/.test(t)), ['Tuesday', 'Thursday', 'Thursday PM']);
  assert.ok(texts.includes(`${lined.name} + ${lib[2].name} - ${recs[1].minutes - lib[0].minutes} min`), texts.join(' / '));
  assert.ok(texts.includes('3 rounds:'));
});

test('a refused write because the doc changed is read again and sent once more', async () => {
  const calls = [];
  let n = 0;
  const mcp = { callTool: async (server, tool, input) => {
    calls.push(tool);
    if (tool === 'read_doc') return { payload: emptyDoc(`r${calls.length}`) };
    if (n++ === 0) throw { code: 'tool_error', message: 'Required revision ID does not match' };
    assert.equal(input.writeControl.requiredRevisionId, 'r3');
    return { payload: {} };
  } };
  const out = await appendRecords(mcp, 'D', [rec('2026-10-20', 'AM', [lib[0]])], ctx);
  assert.deepEqual(calls, ['read_doc', 'update_doc', 'read_doc', 'update_doc']);
  assert.equal(out.title, 'Week 3 B2');
});

test('a write with an unknown outcome is never sent twice', async () => {
  const calls = [];
  const mcp = { callTool: async (server, tool) => {
    calls.push(tool);
    if (tool === 'read_doc') return { payload: emptyDoc() };
    throw { code: 'server_unavailable', retryable: true, message: 'timeout' };
  } };
  await assert.rejects(appendRecords(mcp, 'D', [rec('2026-10-20', 'AM', [lib[0]])], ctx), (e) => e.code === 'server_unavailable');
  assert.deepEqual(calls, ['read_doc', 'update_doc']);
  assert.match(docsErrorText({ code: 'server_unavailable' }), /may or may not/);
  assert.match(docsErrorText({ code: 'needs_reauth', server: 'Google Drive' }), /Reconnect Google Drive/);
});

test('finding the week doc keeps exact titles, newest first, and escapes quotes', async () => {
  let query = '';
  const mcp = { callTool: async (server, tool, input) => {
    query = input.query;
    return { payload: { files: [
      { id: 'old', title: "Coach's Week 4", modifiedTime: '2026-10-01T00:00:00Z' },
      { id: 'other', title: "Coach's Week 4 copy" },
      { id: 'new', title: "Coach's Week 4", modifiedTime: '2026-10-20T00:00:00Z', parentId: 'F' },
      { id: 'new', title: "Coach's Week 4", modifiedTime: '2026-10-20T00:00:00Z', parentId: 'F' },
    ] } };
  } };
  const found = await findDocs(mcp, "Coach's Week 4", 'F');
  assert.deepEqual(found.map((f) => f.id), ['new', 'old']);
  assert.equal(found[0].folderId, 'F');
  assert.match(query, /title = 'Coach\\'s Week 4'/);
  assert.match(query, /parentId = 'F'/);
});

test('the doc title counts weeks across phases with the same short name', () => {
  const p = { ...plan, start: '2026-08-31', phases: [{ name: 'B1 · aerobic base', weeks: 4 }, { name: 'B2 · threshold', weeks: 2 }, { name: 'B2 · race pace', weeks: 1 }].map((x) => ({ ...plan.phases[0], ...x })) };
  assert.equal(docTitleFor(p, '2026-10-12'), 'Week 3 B2');
  assert.equal(docTitleFor(p, '2026-09-28'), 'Week 1 B2');
  assert.equal(docTitleFor(p, '2026-09-21'), 'Week 4 B1');
});

test('a circuit round cuts the count of a repeat group before the swims inside it', () => {
  const kick = { ...lib[1], name: '14 min steady', category: 'aerobic', minutes: 14, circuit: true, lines: ['4 x', '100 kick   1:45', '2 x 50 swim   :50'] };
  const other = { ...lib[2], name: '10 min', category: 'kick', minutes: 10, circuit: true, lines: ['3 x 50 kick   1:05'] };
  const lines = recordsParagraphs([rec('2026-10-20', 'AM', [kick, other], 2, 'even')], ctx).map((p) => p.text.replace(/\t+/g, ' '));
  assert.ok(lines.includes('steady + Kick - 24 min'), lines.join(' / '));
  assert.ok(lines.includes('2 x'), lines.join(' / '));
  assert.ok(lines.includes('100 kick 1:45'), lines.join(' / '));
});

// ---------------------------------------------------------------- the card
//
// One fake connector for the whole file (the page keeps the namespace once
// it has one); each test sets what its tools answer.
const tools = {};
const calls = [];
const fakeMcp = { callTool: async (server, tool, input) => {
  calls.push(tool);
  if (!tools[tool]) throw { code: 'tool_error', message: `unexpected ${tool}` };
  return { payload: await tools[tool](input) };
} };
globalThis.window = { claude: { use: async (n) => (n === 'mcp' ? fakeMcp : null) } };
const { addToDoc, docCardHTML } = await import('../src/pw/doc-card.js');
const { connectors, recordSections } = await import('../src/pw/gdocs.js');

function cardCtx(over = {}) {
  const p = { ...defaultPlan('2026-10-19'), weekDocs: {}, docs: { folderId: null } };
  const c = {
    state: { plan: p, log: [], debriefs: [], ui: {} }, learned: { writing: writingContext(p, {}) }, isArtifact: true,
    toasts: [], confirms: [], answer: true, rerender() {}, esc: (t) => String(t),
    toast(msg, opts = {}) { c.toasts.push([msg, opts]); },
    async confirmAction(msg) { c.confirms.push(msg); return c.answer; },
    save: {
      async plan() { return true; },
      async log(r) { c.state.log = [r, ...c.state.log.filter((x) => x.id !== r.id)]; return true; },
    },
    ...over,
  };
  return c;
}
const reset = () => { calls.length = 0; for (const k of Object.keys(tools)) delete tools[k]; };
const docAnswer = (id) => async () => emptyDoc(`rev-${id}-${calls.length}`).content;

test('a block measured in yards keeps its yards in a circuit; one round has no rounds header', () => {
  const kick = { ...lib[1], minutes: null, distance: 800, circuit: true, lines: ['8 x 100 kick   2:00'] };
  const drill = { ...lib[2], minutes: null, distance: 500, circuit: true, lines: [] };
  const r = rec('2026-10-20', 'AM', [kick, drill], 2, 'even');
  r.blocks.forEach((b) => { b.measure = 'distance'; });
  const [circuit] = recordSections(r, ctx);
  assert.ok(circuit.lines.includes('4 x 100 kick   2:00') || circuit.lines.some((l) => /^4 x 100 kick/.test(l)), circuit.lines.join(' / '));
  assert.ok(circuit.lines.some((l) => /250y/.test(l)), circuit.lines.join(' / '));
  const one = recordSections(rec('2026-10-20', 'AM', [kick, drill], 1), ctx)[0];
  assert.ok(!one.lines.some((l) => /round/.test(l)), one.lines.join(' / '));
});

test('adding to a re-found doc skips sessions already in it, and two clicks make one doc', async () => {
  reset();
  const c = cardCtx();
  const tue = { ...rec('2026-10-20', 'AM', [lib[0]]), doc: { id: 'FOUND', at: 1 } };
  const thu = rec('2026-10-22', 'AM', [lib[0]]);
  c.state.log = [tue, thu];
  tools.search_files = async () => ({ files: [{ id: 'FOUND', title: docTitleFor(c.state.plan, '2026-10-19'), parentId: 'P' }] });
  tools.read_doc = docAnswer('FOUND');
  const sent = [];
  tools.update_doc = async (input) => { sent.push(input.requests[0].insertText.text); return {}; };
  assert.equal(await addToDoc(c, [tue, thu]), 1);
  assert.equal(sent.length, 1);
  assert.ok(!/Tuesday/.test(sent[0]) && /Thursday/.test(sent[0]), 'only Thursday');

  // Two quick clicks on a week with no doc: one search, one create; the
  // second click waits and then finds everything already in.
  reset();
  const c2 = cardCtx();
  const a = rec('2026-10-27', 'AM', [lib[0]]);
  c2.state.log = [a];
  tools.search_files = async () => ({ files: [] });
  tools.create_file = async (input) => ({ id: 'NEW1', title: input.title, parentId: 'ROOT' });
  tools.read_doc = docAnswer('NEW1');
  tools.update_doc = async () => ({});
  const [x, y] = await Promise.all([addToDoc(c2, [a]), addToDoc(c2, [a])]);
  assert.deepEqual([x, y], [1, 0]);
  assert.equal(calls.filter((t) => t === 'create_file').length, 1);
  assert.equal(calls.filter((t) => t === 'update_doc').length, 1);
  assert.ok(c2.toasts.some(([m]) => /Adding after the one in progress/.test(m)));
  assert.equal(c2.state.plan.docs.folderId, null, 'a doc the app made does not set the folder');
});

test('a practice deleted or edited while it is being added is not overwritten', async () => {
  reset();
  const c = cardCtx();
  const gone = rec('2026-10-20', 'AM', [lib[0]]);
  const edited = rec('2026-10-21', 'AM', [lib[0]]);
  c.state.plan.weekDocs['2026-10-19'] = { id: 'D', title: 'Week', url: 'u' };
  c.state.log = [gone, edited];
  tools.read_doc = docAnswer('D');
  tools.update_doc = async () => {
    c.state.log = c.state.log.filter((r) => r.id !== gone.id);
    c.state.log = c.state.log.map((r) => (r.id === edited.id ? { ...r, title: 'changed meanwhile' } : r));
    return {};
  };
  await addToDoc(c, [gone, edited]);
  assert.ok(!c.state.log.some((r) => r.id === gone.id), 'stays deleted');
  const e = c.state.log.find((r) => r.id === edited.id);
  assert.equal(e.title, 'changed meanwhile');
  assert.equal(e.doc, undefined);
  assert.equal(e.docEdited.id, 'D');
});

test('an append with no answer is remembered: the card warns and the next add asks first', async () => {
  reset();
  const c = cardCtx();
  const r = rec('2026-11-03', 'AM', [lib[0]]);
  c.state.log = [r];
  c.state.plan.weekDocs['2026-11-02'] = { id: 'D2', title: 'Week', url: 'u' };
  tools.read_doc = docAnswer('D2');
  tools.update_doc = async () => { throw { code: 'server_unavailable', retryable: true, message: 'timeout' }; };
  assert.equal(await addToDoc(c, [r]), 0);
  assert.equal(calls.filter((t) => t === 'update_doc').length, 1, 'never repeated on its own');
  const [msg, opts] = c.toasts.at(-1);
  assert.match(msg, /may or may not be in the doc/);
  assert.equal(opts.error, true);
  const week = { monday: '2026-11-02', days: [{ date: '2026-11-03', sessions: [{ record: r }] }] };
  assert.match(docCardHTML(c, week), /may already be in the doc/);
  c.answer = false;
  assert.equal(await addToDoc(c, [r]), 0);
  assert.match(c.confirms.at(-1), /didn't answer the last time/);
  assert.equal(calls.filter((t) => t === 'update_doc').length, 1, 'declined: nothing sent');
});

test('error copy says whether anything may have changed', () => {
  assert.match(docsErrorText({ code: 'server_unavailable', op: 'read', server: 'Google Docs' }), /Nothing was changed/);
  assert.match(docsErrorText({ code: 'server_unavailable', op: 'find', server: 'Google Drive' }), /Nothing was changed/);
  assert.match(docsErrorText({ code: 'upstream_error', op: 'create', server: 'Google Drive', title: 'Week 2 B1' }), /may or may not have been created\. Look for “Week 2 B1”/);
  assert.match(docsErrorText({ code: 'cancelled', op: 'append' }), /may or may not be in the doc/);
  assert.match(docsErrorText({ code: 'bad_request', op: 'read', server: 'Google Docs' }), /Reload the page/);
});

test('the folder search falls back to the whole Drive; a null connector is asked again next time', async () => {
  reset();
  const c = cardCtx();
  c.state.plan.docs = { folderId: 'F' };
  const r = rec('2026-11-10', 'AM', [lib[0]]);
  c.state.log = [r];
  const queries = [];
  tools.search_files = async (input) => { queries.push(input.query); return { files: /parentId/.test(input.query) ? [] : [{ id: 'ELSEWHERE', title: docTitleFor(c.state.plan, '2026-11-09'), parentId: 'G' }] }; };
  tools.read_doc = docAnswer('ELSEWHERE');
  tools.update_doc = async () => ({});
  assert.equal(await addToDoc(c, [r]), 1);
  assert.deepEqual(queries.map((q) => /parentId = 'F'/.test(q)), [true, false]);
  assert.equal(c.state.plan.weekDocs['2026-11-09'].id, 'ELSEWHERE');

  assert.ok(await connectors(), 'the namespace is kept once there is one');
});

test('connectors(): a null answer is not kept, so the next click asks again', async () => {
  const fresh = await import('../src/pw/gdocs.js?fresh');
  const saved = globalThis.window.claude;
  let answer = null;
  globalThis.window.claude = { use: async () => answer };
  try {
    assert.equal(await fresh.connectors(), null);
    answer = fakeMcp;
    assert.equal(await fresh.connectors(), fakeMcp);
    answer = null;
    assert.equal(await fresh.connectors(), fakeMcp, 'kept once it came');
  } finally {
    globalThis.window.claude = saved;
  }
});

test('block descriptions: kept in saved practices, back when editing, in the doc under each block', async () => {
  const { draftBlock } = await import('../src/pw/load.js');
  const main = { ...lib[1], detail: 'Hold stroke count.\nFast feet off walls', lines: ['4 x 100 free   1:20'] };
  const r = rec('2026-10-20', 'AM', [lib[0], main]);
  assert.equal(r.blocks[1].detail, 'Hold stroke count.\nFast feet off walls');
  assert.deepEqual(r.blocks[0].equipment, lib[0].equipment);
  // Editing it again: the library block (as it is now) with this practice's description.
  const c = { state: { blocks: [{ ...main, detail: 'library text', lines: ['5 x 100 free   1:20'] }] }, uid: () => 'k1' };
  const { block, missing } = draftBlock(c, r.blocks[1]);
  assert.equal(missing, false);
  assert.equal(block.detail, 'Hold stroke count.\nFast feet off walls');
  assert.deepEqual(block.lines, ['5 x 100 free   1:20']);
  // In the doc: italic lines under the heading; inside a circuit, after the block's lines.
  const ps = recordsParagraphs([r], { ...ctx, state: { ...ctx.state, prefs: {} } });
  const at = ps.findIndex((p) => /^Short warm-up|^Aerobic/.test(p.text) && p.bold);
  assert.ok(ps.some((p) => p.italic && p.text === 'Hold stroke count.') && ps.some((p) => p.italic && p.text === 'Fast feet off walls'), at);
  const circ = rec('2026-10-20', 'AM', [{ ...main, circuit: true }, { ...lib[2], circuit: true, detail: 'Long glide' }], 2);
  const [section] = recordSections(circ, { ...ctx, state: { ...ctx.state, prefs: {} } });
  assert.deepEqual(section.lines.filter((l) => typeof l !== 'string'), [{ note: 'Hold stroke count.\nFast feet off walls' }, { note: 'Long glide' }]);
  // Hidden descriptions stay out of the doc.
  const hidden = recordsParagraphs([r], { ...ctx, state: { ...ctx.state, prefs: { showDetail: false } } });
  assert.ok(!hidden.some((p) => /stroke count/.test(p.text)));
});
