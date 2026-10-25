// Practice Writer screens: pressing buttons after typing, asking before the
// coach's work is thrown away, the same CNS for a practice everywhere, the
// debrief showing the set as it was swum, and the coach chat's errors.
// Made-up season, groups and blocks (no real coach data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { composePractice, defaultPlan, makeBlock, practiceRecord, starterBlocks } from '../src/practice.js';
import { blockCns, generateBlock, writingContext } from '../src/setlang.js';
import { debriefFor, intervalCalibration, makeDebrief } from '../src/learn.js';
import { blockLines, linesHTML, practiceMetrics } from '../src/pw/render.js';
import { chips, esc } from '../src/pw/ui.js';
import { cnsBefore, draftBlock, recordCns, savedRecord } from '../src/pw/load.js';
import { draftSaved, openDebrief, replaceDraft } from '../src/pw/guards.js';
import { weekOf, weekTotals } from '../src/week.js';

// The views import the shell (../app.js) for one helper; the shell boots the
// page, so the tests load a stand-in for it instead.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === '../app.js' && context.parentURL?.includes('/src/pw/views/')) {
      return { url: 'data:text/javascript,export const updateDebriefDot = () => {};', shortCircuit: true };
    }
    return next(specifier, context);
  }`)}`);
globalThis.window ??= { scrollTo() {}, matchMedia: () => ({ matches: false }) };
globalThis.document ??= { documentElement: { scrollHeight: 0 }, getElementById: () => null };

const today = await import('../src/pw/views/today.js');
const build = await import('../src/pw/views/build.js');
const debriefView = await import('../src/pw/views/debrief.js');
const coach = await import('../src/pw/views/coach.js');

// ------------------------------------------------------------ the page

const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[c]));
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// A stand-in for the page: a view sets el.innerHTML and looks nodes up with
// ctx.$ ('#id') and ctx.$$ ('[data-x]'); they are found in that HTML and
// keep their handlers until the next redraw, so a test can type and press.
function fakePage() {
  let html = '';
  let renders = 0;
  let nodes = new Map();
  const attrsOf = (tag) => {
    const out = { dataset: {} };
    for (const [, k, v] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (k.startsWith('data-')) out.dataset[camel(k.slice(5))] = unesc(v);
      else out[k] = unesc(v);
    }
    return out;
  };
  const node = (key, tag) => {
    if (nodes.has(key)) return nodes.get(key);
    const a = attrsOf(tag);
    const classes = new Set((a.class || '').split(/\s+/).filter(Boolean));
    const listeners = {};
    const n = {
      key, id: a.id, dataset: a.dataset, value: a.value ?? '', checked: / checked/.test(tag), disabled: / disabled/.test(tag),
      textContent: '', style: {}, scrollHeight: 0, attrs: { ...a },
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on = !classes.has(c)) => { if (on) classes.add(c); else classes.delete(c); return on; },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      focus() {}, scrollIntoView() {},
      fire(type) {
        const e = { type, target: n, currentTarget: n, preventDefault() {}, stopPropagation() {} };
        n[`on${type}`]?.(e);
        (listeners[type] || []).forEach((fn) => fn(e));
      },
    };
    nodes.set(key, n);
    return n;
  };
  const $ = (sel) => {
    const id = /^#([\w-]+)$/.exec(sel)?.[1];
    if (!id) throw new Error(`fake page: unsupported selector ${sel}`);
    const tag = new RegExp(`<\\w+[^>]*\\sid="${id}"[^>]*>`).exec(html)?.[0];
    return tag ? node(sel, tag) : null;
  };
  const $$ = (sel) => {
    const attr = /^\[(data-[\w-]+)\]$/.exec(sel)?.[1];
    if (!attr) throw new Error(`fake page: unsupported selector ${sel}`);
    return [...html.matchAll(new RegExp(`<\\w+[^>]*\\s${attr}="[^"]*"[^>]*>`, 'g'))].map((m, i) => node(`${sel}#${i}`, m[0]));
  };
  const el = {
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; renders += 1; nodes = new Map(); },
    querySelector: (sel) => (sel.startsWith('#') ? $(sel) : null), // scrolling to a row: nothing to do here
    contains: () => true,
  };
  const find = (sel, value) => (sel.startsWith('#') ? $(sel) : $$(sel).find((n) => Object.values(n.dataset).includes(value)));
  return {
    el, $, $$, find, renders: () => renders,
    // Type into a field (input events, as a keyboard does).
    type(sel, text) { const n = $(sel); n.value = text; n.fire('input'); return n; },
    // Press a button as a person does: the field being typed in loses focus
    // first (its change fires), then the click lands, but only on a button
    // that is still on the page: a redraw in between swallows the press.
    async press(sel, { value, from = null } = {}) {
      const target = find(sel, value);
      assert.ok(target, `no ${sel} ${value || ''} on the page`);
      const before = renders;
      from?.fire('change');
      await settle();
      if (renders !== before) return false;
      target.fire('click');
      await settle();
      return true;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------ test data

const plan = defaultPlan('2026-10-19'); // Monday; Base phase
plan.groups = [{ name: 'Lane 1', key: '1:02', g3: 62 }, { name: 'Lane 2', key: '1:05', g3: 65 }, { name: 'Lane 3', key: '1:08', g3: 68 }];
const aerobic = makeBlock({ id: 'b-aero', name: '40 min free aerobic', category: 'aerobic', stroke: 'free', minutes: 40, gears: ['G2', 'G3'], lines: ['8 x 100 free G2', '6 x 100 free G3', '4 x 50 free G4'], source: 'pasted' });
const kick = makeBlock({ id: 'b-kick', name: '20 min kick socks', category: 'kick', minutes: 20, gears: ['G3'], equipment: ['socks'], lines: ['8 x 50 kick G3', '4 x 25 kick G5'], source: 'pasted' });
const speed = makeBlock({ id: 'b-speed', name: 'Made-up 50s', category: 'speed', distance: 600, gears: ['G5'], lines: ['8 x 50 free G5', '4 x 25 free G6'], source: 'coach' });
const library = [...starterBlocks(), aerobic, kick, speed];

function makeCtx(page, view, over = {}) {
  const state = {
    tab: 'today', today: '2026-10-27', plan, blocks: library, log: [], debriefs: [], prefs: {}, style: null,
    draft: { date: '2026-10-27', slot: 'AM', title: '', focus: null, blocks: [], rounds: 3, pattern: 'even' },
    ask: null, suggestion: null, chat: { history: [], busy: false, controller: null, error: null }, debriefing: null, ui: {},
    ...over,
  };
  const asked = [];
  const saved = [];
  const ctx = {
    state, asked, saved, answer: true,
    store: null, isArtifact: false, claude: { sample: null, downloads: null },
    learned: { weights: {}, calibration: {}, writing: writingContext(plan) },
    uid: (() => { let n = 0; return (p = 'x') => `${p}${++n}`; })(),
    $: (sel) => page.$(sel), $$: (sel) => page.$$(sel), esc, chips,
    bindChips: (root, onPick) => page.$$('[data-chip]').forEach((b) => { b.onclick = () => onPick(b.dataset.chip, b.dataset.value); }),
    toasts: [],
    toast: (m, o) => { ctx.toasted = m; ctx.toasts.push([m, o || {}]); },
    confirmAction: async (message) => { asked.push(message); return ctx.answer; },
    copyText: async () => {}, saveFile: async () => {},
    go: (tab) => { state.tab = tab; },
    rerender: () => view.render(ctx, page.el),
    // As the app's saves: the change goes into the state, then true when it
    // was stored, false when it was not (ctx.storeOk = false).
    storeOk: true,
    save: {
      log: async (rec) => { saved.push(rec); state.log = [rec, ...state.log.filter((r) => r.id !== rec.id)]; return ctx.storeOk; },
      block: async (b) => { saved.push(b); state.blocks = [...state.blocks.filter((x) => x.id !== b.id), b]; return ctx.storeOk; },
      removeBlock: async (id) => { state.blocks = state.blocks.filter((x) => x.id !== id); return ctx.storeOk; },
      debrief: async (d) => { saved.push(d); state.debriefs = [d, ...state.debriefs.filter((x) => x.id !== d.id)]; return ctx.storeOk; },
      removeDebrief: async (id) => { state.debriefs = state.debriefs.filter((x) => x.id !== id); return ctx.storeOk; },
      removeLog: async (id) => { state.log = state.log.filter((r) => r.id !== id); return ctx.storeOk; },
      prefs: async () => ctx.storeOk, plan: async () => ctx.storeOk, style: async () => ctx.storeOk, relearn: async () => null,
    },
  };
  return ctx;
}

// ------------------------------------------------- 12: typed, then pressed

test('Today: minutes typed under "other", then Next, moves on the first press', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today);
  ctx.rerender();
  assert.ok(await page.press('[data-write]', { value: 'AM' }));
  const min = page.type('#t-min', '75');
  assert.equal(await page.press('#t-next', { from: min }), true, 'the press on Next landed');
  assert.equal(ctx.state.ask.step, 1);
  assert.equal(ctx.state.ask.minutes, 75);
  assert.match(page.el.innerHTML, /AM · 2 of 5/);
});

test('Today: minutes typed under "other" count and light it up as they are typed', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today);
  ctx.rerender();
  await page.press('[data-write]', { value: 'AM' });
  const renders = page.renders();
  page.type('#t-min', '75');
  assert.equal(page.renders(), renders, 'no redraw while typing');
  assert.equal(ctx.state.ask.minutes, 75);
  assert.equal(page.$('#t-min-chip').classList.contains('on'), true);
  assert.deepEqual(page.$$('[data-min]').filter((n) => n.classList.contains('on')), []);
  page.type('#t-min', '7'); // on the way to 70: not a time yet, nothing changes
  assert.equal(ctx.state.ask.minutes, 75);
});

test('Build: a title typed, then Save to log, saves on the first press with the title', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, build, { tab: 'build' });
  ctx.state.draft.blocks = [{ ...aerobic, key: 'k1' }];
  ctx.rerender();
  const title = page.type('#d-title', ' Tuesday threshold ');
  assert.equal(await page.press('#d-save', { from: title }), true, 'the press on Save landed');
  assert.equal(ctx.saved.length, 1);
  assert.equal(ctx.saved[0].title, 'Tuesday threshold');
  assert.match(ctx.saved[0].text, /^Tuesday threshold · /);
  assert.equal(ctx.state.tab, 'log');
});

test("Build: the preview's heading and text follow the title as it is typed, without a redraw", () => {
  const page = fakePage();
  const ctx = makeCtx(page, build, { tab: 'build' });
  ctx.state.draft.blocks = [{ ...aerobic, key: 'k1' }];
  ctx.rerender();
  const renders = page.renders();
  page.type('#d-title', ' Tuesday threshold ');
  assert.equal(page.renders(), renders);
  assert.equal(ctx.state.draft.title, ' Tuesday threshold '); // as typed; trimmed where it is used
  assert.equal(page.$('#d-head').textContent, 'Tuesday threshold');
  assert.match(page.$('#d-text').textContent, /^Tuesday threshold · /);
});

test('Build: Copy text and Fill from the plan also work on the first press after typing a title', async () => {
  for (const btn of ['#d-copy', '#d-suggest']) {
    const page = fakePage();
    const ctx = makeCtx(page, build, { tab: 'build' });
    let copied = null;
    ctx.copyText = async (text) => { copied = text; };
    ctx.answer = false;
    ctx.state.draft.blocks = [{ ...aerobic, key: 'k1' }];
    ctx.rerender();
    const title = page.type('#d-title', 'Made-up Tuesday');
    assert.equal(await page.press(btn, { from: title }), true, `${btn} landed`);
    if (btn === '#d-copy') assert.match(copied, /^Made-up Tuesday · /);
    else assert.equal(ctx.asked.length, 1); // "Replace the 1 block … with the plan's suggestion?"
  }
});

// ------------------------------------------------- 14: equipment

test('Today: tapping an item while Everything is on turns on just that item', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today);
  ctx.rerender();
  await page.press('[data-write]', { value: 'AM' });
  await page.press('#t-next');
  await page.press('#t-next'); // Equipment on deck, Everything on
  assert.equal(ctx.state.ask.equipment, null);
  await page.press('[data-kit]', { value: 'socks' });
  assert.deepEqual(ctx.state.ask.equipment, ['socks']);
  const on = page.$$('[data-kit]').filter((n) => n.classList.contains('on')).map((n) => n.dataset.kit);
  assert.deepEqual(on, ['socks']);
  await page.press('[data-kit]', { value: 'fins' });
  assert.deepEqual(ctx.state.ask.equipment, ['socks', 'fins']);
  await page.press('[data-kit]', { value: 'socks' });
  assert.deepEqual(ctx.state.ask.equipment, ['fins']);
  assert.deepEqual(today.toggleKit(['fins'], 'fins'), []); // = Nothing
});

// ------------------------------------------------- 15: the draft

async function suggestionOnToday(ctx, page) {
  ctx.rerender();
  await page.press('[data-write]', { value: 'AM' });
  for (let i = 0; i < 4; i++) await page.press('#t-next');
  await page.press('#t-write');
  assert.ok(ctx.state.suggestion?.blocks.length);
}

test('Today: Open in builder asks before replacing a practice being built', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today);
  const mine = { date: '2026-10-27', slot: 'AM', title: 'My made-up Tuesday', focus: null, blocks: [{ ...aerobic, key: 'k1' }, { ...kick, key: 'k2' }], rounds: 3, pattern: 'even' };
  ctx.state.draft = mine;
  await suggestionOnToday(ctx, page);

  ctx.answer = false; // Cancel
  await page.press('#t-open');
  assert.equal(ctx.asked.length, 1);
  assert.match(ctx.asked[0], /^Replace the practice you are building \(Tue .*27 AM\) with today's suggestion\?$/);
  assert.equal(ctx.state.draft, mine, 'the hand-built practice is kept');
  assert.equal(ctx.state.tab, 'today');

  ctx.answer = true; // Replace
  await page.press('#t-open');
  assert.notEqual(ctx.state.draft, mine);
  assert.equal(ctx.state.draft.blocks.length, ctx.state.suggestion.blocks.length);
  assert.equal(ctx.state.tab, 'build');
});

test('Today: Open in builder does not ask when the draft is empty or already saved', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today);
  await suggestionOnToday(ctx, page);
  await page.press('#t-open');
  assert.equal(ctx.asked.length, 0);
  assert.equal(ctx.state.tab, 'build');

  // Saved to the log and left in the builder: nothing to lose.
  const page2 = fakePage();
  const ctx2 = makeCtx(page2, today);
  const draft = { date: '2026-10-26', slot: 'AM', title: 'Made-up Monday', focus: null, blocks: [{ ...aerobic, key: 'k1' }], rounds: 3, pattern: 'even' };
  const composed = composePractice({ blocks: draft.blocks });
  ctx2.state.draft = draft;
  ctx2.state.log = [practiceRecord({ date: draft.date, title: draft.title, slot: 'AM', blocks: draft.blocks, rounds: 1, composed, text: '' })];
  assert.equal(draftSaved(ctx2.state), true);
  await suggestionOnToday(ctx2, page2);
  await page2.press('#t-open');
  assert.equal(ctx2.asked.length, 0);
  assert.equal(ctx2.state.tab, 'build');
  // …but a change after saving counts as unsaved work.
  draft.title = 'Made-up Monday, changed';
  assert.equal(draftSaved(ctx2.state, draft), false);
});

test('Coach: Open in builder asks before replacing a practice being built', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, coach, { tab: 'coach' });
  ctx.claude.sample = { json: async () => ({}) };
  const mine = { date: '2026-10-27', slot: 'AM', title: 'My made-up Tuesday', focus: null, blocks: [{ ...aerobic, key: 'k1' }], rounds: 3, pattern: 'even' };
  ctx.state.draft = mine;
  const practice = { title: 'Made-up AM', slot: 'AM', rounds: 1, pattern: 'even', blocks: [makeBlock({ name: '20 min kick', category: 'kick', minutes: 20, lines: ['8 x 50 kick G3'] })] };
  ctx.state.chat.history = [{ role: 'user', content: "Write today's AM" }, { role: 'assistant', content: '{}', reply: 'Here it is.', practice, blocks: [], saved: {} }];
  ctx.rerender();
  ctx.answer = false;
  await page.press('[data-open]', { value: '1' });
  assert.equal(ctx.asked.length, 1);
  assert.match(ctx.asked[0], /with the coach's practice\?$/);
  assert.equal(ctx.state.draft, mine);
  ctx.answer = true;
  await page.press('[data-open]', { value: '1' });
  assert.equal(ctx.state.draft.title, 'Made-up AM');
  assert.equal(ctx.state.tab, 'build');
});

test('replaceDraft: asks whenever unsaved blocks would be lost, also for the same day and session', async () => {
  const ctx = makeCtx(fakePage(), today);
  ctx.state.draft = { date: '2026-10-28', slot: 'AM', title: '', blocks: [{ ...aerobic, key: 'k1' }], rounds: 3, pattern: 'even' };
  ctx.answer = false;
  assert.equal(await replaceDraft(ctx, 'the draft for Wed AM'), false);
  assert.match(ctx.asked[0], /^Replace the practice you are building \(Wed .*28 AM\) with the draft for Wed AM\?$/);
  ctx.state.draft = { date: '2026-10-28', slot: 'AM', title: '', blocks: [], rounds: 3, pattern: 'even' };
  assert.equal(await replaceDraft(ctx, 'anything'), true);
  assert.equal(ctx.asked.length, 1);
});

// ------------------------------------------------- 16: the debrief

const blk = (id, name, category) => ({ id, name, category, stroke: 'free', circuit: false, gears: ['G2'], lines: ['4 x 200 free G2'], minutes: 20, distance: 800 });
const rec = (id, date, slot, title, createdAt) => ({ id, createdAt, date, slot, title, focus: 'aerobic', phase: 'Base', rounds: 1, pattern: 'even', minutes: 60, distance: 2400, unit: 'y', text: title, blocks: [blk('w1', 'Warm-up', 'warmup'), blk('m1', 'Main aerobic', 'aerobic'), blk('c1', 'Warm-down', 'cooldown')] });
const threeLogs = () => [rec('rTuePM', '2026-10-27', 'PM', 'Made-up Tue PM', 3), rec('rTueAM', '2026-10-27', 'AM', 'Made-up Tue AM', 2), rec('rMonAM', '2026-10-26', 'AM', 'Made-up Mon AM', 1)];

test("Today: the Debrief card asks before throwing away another practice's debrief in progress", async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today, { log: threeLogs() });
  const monday = debriefFor(ctx.state.log[2]);
  monday.overall = 2;
  monday.sections[1].verdict = 'bad';
  monday.sections[1].why = 'Made-up: too long, lost focus by RD3.';
  ctx.state.debriefing = monday;
  ctx.rerender();
  assert.match(page.el.innerHTML, /How did today&#39;s PM go\?/);

  ctx.answer = false;
  await page.press('#t-debrief');
  assert.deepEqual(ctx.asked, ['You have an unsaved debrief for another practice. Throw it away?']);
  assert.equal(ctx.state.debriefing, monday, "Monday's answers are kept");
  assert.equal(ctx.state.tab, 'today');

  ctx.answer = true;
  ctx.state.ui.debriefResult = { title: 'old', lines: [] };
  await page.press('#t-debrief');
  assert.equal(ctx.state.debriefing.practiceId, 'rTuePM');
  assert.equal(ctx.state.ui.debriefResult, null);
  assert.equal(ctx.state.tab, 'debrief');
});

test('openDebrief: carries on with the same practice, starts an untouched one without asking', async () => {
  const ctx = makeCtx(fakePage(), today, { log: threeLogs() });
  const [pm, am] = ctx.state.log;
  ctx.state.debriefing = debriefFor(am); // opened, nothing answered
  assert.equal(await openDebrief(ctx, pm), true);
  assert.equal(ctx.asked.length, 0);
  assert.equal(ctx.state.debriefing.practiceId, pm.id);
  const same = ctx.state.debriefing;
  same.notes = 'Made-up note';
  assert.equal(await openDebrief(ctx, pm), true);
  assert.equal(ctx.state.debriefing, same);
});

// ------------------------------------------------- 17: CNS of a saved practice

const ctxFor = (log = []) => ({ state: { plan, debriefs: [], log }, learned: { weights: {}, writing: writingContext(plan) } });

test('a saved practice counts the same CNS as the builder showed, for every round pattern', () => {
  const ctx = ctxFor();
  for (const pattern of ['even', 'build', 'hard-last', 'descend']) {
    for (const rounds of [2, 3, 4]) {
      const blocks = [{ ...aerobic, circuit: true }, { ...kick, circuit: true }, { ...speed, circuit: true }];
      const composed = composePractice({ blocks, rounds, pattern, pace: plan.pace, unit: plan.unit });
      const shown = practiceMetrics(composed, ctx).cns; // the builder's "CNS load"
      const saved = JSON.parse(JSON.stringify(savedRecord(ctx, { date: '2026-10-28', title: '', focus: 'aerobic', slot: 'AM', blocks, rounds, pattern, composed, text: '' })));
      assert.equal(recordCns(saved, ctx), shown, `${pattern} × ${rounds}`);
    }
  }
  // The old count (each block's lines once) misses the faster rounds.
  const blocks = [{ ...aerobic, circuit: true }, { ...kick, circuit: true }];
  const composed = composePractice({ blocks, rounds: 3, pattern: 'build', pace: plan.pace, unit: plan.unit });
  const once = blocks.reduce((s, b) => s + blockCns(b.lines, ctx.learned.writing.model), 0);
  assert.ok(practiceMetrics(composed, ctx).cns > once * 2);
});

test("Today's Load card and the Week's CNS by day show the builder's points", () => {
  const blocks = [{ ...aerobic, circuit: true }, { ...kick, circuit: true }];
  const composed = composePractice({ blocks, rounds: 3, pattern: 'hard-last', pace: plan.pace, unit: plan.unit });
  const base = ctxFor();
  const shown = practiceMetrics(composed, base).cns;
  const saved = savedRecord(base, { date: '2026-10-28', title: '', focus: 'aerobic', slot: 'AM', blocks, rounds: 3, pattern: 'hard-last', composed, text: '' });

  const page = fakePage();
  const ctx = makeCtx(page, today, { today: '2026-10-29', log: [saved] });
  ctx.rerender();
  assert.match(page.el.innerHTML, new RegExp(` AM: ${shown} \\(points when swum`));
  const { recent } = cnsBefore([saved], '2026-10-29', ['AM'], ctx);
  assert.equal(recent[0].points, shown);

  const week = weekOf({ plan, date: '2026-10-28', today: '2026-10-29', log: [saved], debriefs: [] });
  const w = weekTotals(week, plan, ctx.learned.writing.model);
  assert.equal(w.cnsByDay[2], shown);
  assert.ok(w.cnsMorning[3] > 0 && w.cnsMorning[3] < shown); // a day later: some of it left
  // A record saved before `measure` existed still reads back (as timed).
  const old = JSON.parse(JSON.stringify(saved));
  old.blocks.forEach((b) => delete b.measure);
  assert.equal(recordCns(old, ctx), shown);
});

test('a saved block comes back in its own measure (Build again, Edit on the Week)', () => {
  const ctx = ctxFor();
  const blocks = [{ ...speed, circuit: true }, { ...aerobic, circuit: true }];
  const composed = composePractice({ blocks, rounds: 3, pattern: 'build', pace: plan.pace, unit: plan.unit });
  const rec = JSON.parse(JSON.stringify(savedRecord(ctx, { date: '2026-10-28', title: '', focus: 'speed', slot: 'AM', blocks, rounds: 3, pattern: 'build', composed, text: '' })));
  const notInLibrary = { ...ctx, state: { ...ctx.state, blocks: [] }, uid: () => 'k' };
  const [s, a] = rec.blocks.map((rb) => draftBlock(notInLibrary, rb).block);
  assert.equal(s.printed, undefined, 'in the builder its send-offs are written again');
  assert.equal(s.minutes, null);
  assert.ok(s.distance > 0);
  assert.equal(a.minutes, 40);
  assert.equal(a.distance, null);
});

// ------------------------------------------------- 28: the set as swum

test('Debrief: "The set as written" shows the saved send-offs, not re-timed by later debriefs', () => {
  const w0 = writingContext(plan);
  const gen = makeBlock({ ...generateBlock({ focus: 'threshold', minutes: 40, ctx: w0 }), source: 'generated' });
  const ctx0 = { state: { plan, debriefs: [] }, learned: { writing: w0 } };
  const save = (id, date) => {
    const blocks = [gen];
    const r = savedRecord(ctx0, { date, title: '', focus: 'threshold', slot: 'AM', blocks, rounds: 1, composed: composePractice({ blocks }), text: '' });
    r.id = id;
    return r;
  };
  const first = save('r1', '2026-10-26');
  const second = save('r2', '2026-10-27');
  const d = debriefFor(first);
  d.sections[0].intervals = 'too-hard';
  d.sections[0].made = 'few';
  const debriefs = [makeDebrief(d)];
  const calibration = intervalCalibration(debriefs, '2026-10-27');
  assert.ok(Object.keys(calibration).length, 'the debrief moved the gear chart');

  const page = fakePage();
  const ctx = makeCtx(page, debriefView, { tab: 'debrief', log: [second, first], debriefs, debriefing: debriefFor(second) });
  ctx.learned = { weights: {}, calibration, writing: writingContext(plan, { calibration }) };
  ctx.rerender();
  const swum = second.blocks[0].lines;
  const retimed = blockLines(second.blocks[0], ctx, null, 'AM');
  assert.notDeepEqual(retimed, swum, 'the chart has moved since');
  assert.ok(page.el.innerHTML.includes(linesHTML(swum)), 'shows the lines as saved');
  assert.ok(!page.el.innerHTML.includes(linesHTML(retimed)));

  // The coach's own lines: their send-offs as written, a missing one filled in.
  const own = makeBlock({ name: '30 min own set', category: 'aerobic', minutes: 30, lines: ['5 x 100 free G2', '4 x 50 kick   1:07'] });
  const third = practiceRecord({ date: '2026-10-27', slot: 'PM', blocks: [own], composed: composePractice({ blocks: [own] }), text: '' });
  third.id = 'r3';
  const page3 = fakePage();
  const ctx3 = makeCtx(page3, debriefView, { tab: 'debrief', log: [third], debriefs: [], debriefing: debriefFor(third) });
  ctx3.learned = ctx.learned;
  ctx3.rerender();
  assert.match(page3.el.innerHTML, /5 x 100 free G2<\/span><span class="iv">[^<]*\d:\d\d/, 'a send-off for the line written without one');
  assert.match(page3.el.innerHTML, /4 x 50 kick<\/span><span class="iv">1:07</, "the coach's send-off as written");
});

// ------------------------------------------------- 38: coach errors

test('Coach errors: "Try again" only for passing failures and rate limits (after a wait)', () => {
  assert.deepEqual(coach.errorFor('upstream_error').retry, true);
  assert.deepEqual(coach.errorFor('a_code_from_later').retry, true); // unknown = upstream_error
  const rate = coach.errorFor('rate_limited');
  assert.equal(rate.retry, true);
  assert.ok(rate.wait >= 30000);
  for (const code of ['refused', 'empty_completion', 'invalid_json', 'prompt_too_large', 'session_expired', 'invalid_request', 'transform_error', 'queue_overflow']) {
    const e = coach.errorFor(code);
    assert.equal(e.retry, false, code);
    assert.match(e.message, /back in the box/, code);
  }
  assert.match(coach.errorFor('invalid_request').message, /went wrong on this page/);
  assert.doesNotMatch(coach.errorFor('refused').message, /Try again/);
});

test('Coach errors: a refused message goes back in the box instead of being sent again unchanged', async () => {
  for (const [code, retry] of [['refused', false], ['empty_completion', false], ['invalid_json', false], ['invalid_request', false], ['rate_limited', true], ['upstream_error', true]]) {
    const page = fakePage();
    const ctx = makeCtx(page, coach, { tab: 'other' });
    let calls = 0;
    ctx.claude.sample = { json: async () => { calls += 1; throw { code, message: 'made-up failure' }; } };
    await coach.send(ctx, 'Write a made-up 30 min kick set');
    const { chat, ui } = ctx.state;
    assert.equal(calls, 1);
    assert.equal(!!chat.error.retry, retry, code);
    if (retry) {
      assert.equal(chat.history.at(-1).content, 'Write a made-up 30 min kick set');
      assert.equal(ui.coachDraft, '');
    } else {
      assert.equal(chat.history.length, 0, `${code}: not left in the chat to go out again`);
      assert.equal(ui.coachDraft, 'Write a made-up 30 min kick set');
    }
    // On the Coach tab: the button is there only when a retry is offered,
    // and for a rate limit it waits.
    ctx.state.tab = 'coach';
    const waits = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { waits.push(ms); return 0; };
    try { ctx.rerender(); } finally { globalThis.setTimeout = realTimeout; }
    const btn = page.$('#cc-retry');
    assert.equal(!!btn, retry, code);
    if (code === 'rate_limited') {
      assert.equal(btn.disabled, true);
      assert.ok(waits.some((ms) => ms > 30000), 'turns on after the wait');
    }
    if (code === 'upstream_error') {
      assert.equal(btn.disabled, false);
      await page.press('#cc-retry');
      assert.equal(calls, 2);
    }
  }
});

// ------------------------------------------------- not saved

// The app's saves resolve false when the write was not stored (the app then
// says "Not saved" and offers Try again). The screens then don't say it was
// saved and keep the coach's work open, and saving again replaces the same
// record instead of adding a second one.

globalThis.CSS ??= { escape: (s) => String(s) };
globalThis.document.querySelector ??= () => null;
const blocksView = await import('../src/pw/views/blocks.js');
const weekView = await import('../src/pw/views/week.js');
const { addToDoc } = await import('../src/pw/doc-card.js');
const toastsOf = (ctx) => ctx.toasts.map(([m]) => m);

test('Build: Save to log not saved keeps the draft open; saving again replaces the same record', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, build, { tab: 'build' });
  ctx.state.draft.blocks = [{ ...aerobic, key: 'k1' }];
  ctx.state.draft.title = 'Made-up Tuesday';
  ctx.rerender();
  ctx.storeOk = false;
  await page.press('#d-save');
  assert.equal(ctx.state.tab, 'build', 'no move to the Log');
  assert.equal(ctx.state.draft.blocks.length, 1, 'the draft is kept');
  assert.equal(page.$('#d-save').disabled, false, 'Save can be pressed again');
  assert.ok(!toastsOf(ctx).some((m) => /^Saved/.test(m)));
  ctx.storeOk = true;
  await page.press('#d-save');
  assert.equal(ctx.saved.length, 2);
  assert.equal(ctx.saved[1].id, ctx.saved[0].id, 'the same record, not a second one');
  assert.equal(ctx.state.log.length, 1);
  assert.equal(ctx.state.tab, 'log');
  assert.equal(ctx.toasted, 'Saved AM practice to the log');
});

test('Build: a written block goes into the practice even when Blocks could not save it, without saying it was saved', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, build, { tab: 'build' });
  ctx.rerender();
  await page.press('#d-write');
  await page.press('#w-go');
  ctx.storeOk = false;
  await page.press('#w-add');
  assert.equal(ctx.state.draft.blocks.length, 1);
  assert.doesNotMatch(ctx.toasted, /saved it to Blocks/);
  assert.match(ctx.toasted, /not saved to Blocks yet/);
});

test('Blocks: an edited block that was not saved keeps the editor open with the edits; saving again replaces it', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, blocksView, { tab: 'blocks' });
  ctx.rerender();
  await page.press('#bk-new');
  const name = page.find('[data-f]', 'name');
  name.value = 'Made-up 30 min kick';
  name.fire('input');
  const lines = page.find('[data-f]', 'lines');
  lines.value = '8 x 50 kick G3\n4 x 25 kick G5';
  lines.fire('input');
  ctx.storeOk = false;
  await page.press('#bk-save');
  assert.ok(page.$('#bk-form'), 'the editor is still open');
  assert.equal(ctx.state.ui.blocks.form.name, 'Made-up 30 min kick');
  assert.ok(!toastsOf(ctx).some((m) => /saved/i.test(m)));
  ctx.storeOk = true;
  await page.press('#bk-save');
  assert.equal(page.$('#bk-form'), null, 'closed once saved');
  assert.equal(ctx.saved.length, 2);
  assert.equal(ctx.saved[1].id, ctx.saved[0].id);
  assert.equal(ctx.state.blocks.filter((b) => b.name === 'Made-up 30 min kick').length, 1);
  assert.match(ctx.toasted, /^Block saved/);
});

test('Blocks: a pasted set that was not saved stays in the box; saving again replaces it', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, blocksView, { tab: 'blocks' });
  ctx.rerender();
  page.type('#bk-text', '20 min made-up kick\n8 x 50 kick G3');
  ctx.storeOk = false;
  await page.press('#bk-save-paste');
  assert.equal(ctx.state.ui.blocks.paste, '20 min made-up kick\n8 x 50 kick G3');
  assert.match(page.el.innerHTML, /<textarea id="bk-text"[^>]*>20 min made-up kick/);
  ctx.storeOk = true;
  await page.press('#bk-save-paste');
  assert.equal(ctx.state.ui.blocks.paste, '');
  assert.equal(ctx.saved[1].id, ctx.saved[0].id);
  assert.equal(ctx.state.blocks.filter((b) => b.name === '20 min made-up kick').length, 1);
});

test('Debrief: not saved keeps the debrief open and does not say it was saved', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, debriefView, { tab: 'debrief', log: threeLogs() });
  ctx.state.debriefing = debriefFor(ctx.state.log[0]);
  ctx.state.debriefing.notes = 'Made-up note';
  ctx.rerender();
  ctx.storeOk = false;
  await page.press('#d-save');
  assert.equal(ctx.state.debriefing?.notes, 'Made-up note', 'still being edited');
  assert.ok(page.$('#d-save'), 'the editor is on the page');
  assert.equal(page.$('#d-save').disabled, false);
  assert.ok(!toastsOf(ctx).includes('Debrief saved'));
  ctx.storeOk = true;
  await page.press('#d-save');
  assert.equal(ctx.state.debriefing, null);
  assert.equal(ctx.toasted, 'Debrief saved');
  assert.equal(ctx.state.debriefs.length, 1);
});

test('Coach: a block that was not saved keeps its Save button', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, coach, { tab: 'coach' });
  ctx.claude.sample = { json: async () => ({}) };
  const blk1 = makeBlock({ id: 'cb1', name: '20 min made-up kick', category: 'kick', minutes: 20, lines: ['8 x 50 kick G3'] });
  ctx.state.chat.history = [{ role: 'user', content: 'A kick set' }, { role: 'assistant', content: '{}', reply: 'Here.', practice: null, blocks: [blk1], saved: {} }];
  ctx.rerender();
  ctx.storeOk = false;
  await page.press('[data-saveb]', { value: '1:0' });
  assert.deepEqual(ctx.state.chat.history[1].saved, {});
  assert.equal(page.find('[data-saveb]', '1:0').disabled, false);
  ctx.storeOk = true;
  await page.press('[data-saveb]', { value: '1:0' });
  assert.equal(ctx.state.chat.history[1].saved.cb1, true);
  assert.equal(ctx.toasted, 'Saved 20 min made-up kick to the library');
});

test('Coach (no Claude): a pasted set that was not saved stays in the box and does not say it was saved', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, coach, { tab: 'coach' });
  ctx.rerender();
  const set = '20 min made-up kick\n8 x 50 kick G3';
  page.type('#cc-quick', set);
  ctx.storeOk = false;
  await page.press('#cc-quick-save');
  assert.equal(ctx.state.ui.coachQuickText, set);
  assert.match(ctx.state.ui.coachQuick.reply, /^Not saved yet: 20 min made-up kick\./);
  assert.match(page.el.innerHTML, /<textarea id="cc-quick"[^>]*>20 min made-up kick/);
  ctx.storeOk = true;
  page.type('#cc-quick', set); // the fake page doesn't read a textarea's text back
  await page.press('#cc-quick-save');
  assert.equal(ctx.state.ui.coachQuickText, '');
  assert.equal(ctx.saved[1].id, ctx.saved[0].id, 'the same block again');
  assert.equal(ctx.toasted, 'Saved 20 min made-up kick');
});

test('Week: drafts that were not saved stay in the list and are saved again as the same record', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, weekView, { tab: 'week' });
  ctx.rerender();
  await page.press('#wk-draft');
  const n = ctx.state.ui.wk.drafts.list.length;
  assert.ok(n >= 2, 'a few sessions drafted');
  let calls = 0;
  const log = ctx.save.log;
  ctx.save.log = async (r) => { await log(r); calls += 1; return calls !== 2; }; // the second one fails
  await page.press('#wk-dsave');
  const left = ctx.state.ui.wk.drafts?.list || [];
  assert.equal(left.length, 1, 'the one not saved is still a draft');
  assert.match(ctx.toasted, new RegExp(`^Saved ${n - 1} practice.* · 1 not saved$`));
  const failedId = ctx.saved[1].id;
  assert.equal(left[0].unsaved, failedId);
  await page.press('#wk-dsave');
  assert.equal(ctx.state.ui.wk.drafts, null);
  assert.equal(ctx.saved.at(-1).id, failedId, 'the same record again, not "already written"');
  assert.equal(ctx.state.log.length, n);
});

test('Today: bare warm-up and cool-down blocks get "Write lines", written easy', async () => {
  const page = fakePage();
  const ctx = makeCtx(page, today);
  const warm = makeBlock({ id: 'bw', name: 'Made-up warm-up', category: 'warmup', stroke: 'choice', minutes: 15 });
  const cool = makeBlock({ id: 'bc', name: 'Made-up cool-down', category: 'cooldown', stroke: 'choice', minutes: 10 });
  ctx.state.suggestion = { slot: 'AM', focus: 'aerobic', minutes: 65, blocks: [warm, { ...aerobic }, cool], notes: [], rounds: 1, pattern: 'even', ask: { slot: 'AM', minutes: 65 }, variant: 0 };
  ctx.rerender();
  assert.deepEqual(page.$$('[data-gen]').map((b) => b.dataset.gen), ['0', '2']);
  await page.press('[data-gen]', { value: '0' });
  const w = ctx.state.suggestion.blocks[0];
  assert.equal(w.category, 'warmup');
  assert.match(w.name, /warm-up/);
  assert.ok(w.lines.length && !w.lines.some((l) => /G[4-6]/.test(l)), 'easy: nothing above G3');
  ctx.storeOk = false;
  await page.press('[data-gen]', { value: '2' });
  const c = ctx.state.suggestion.blocks[2];
  assert.equal(c.category, 'cooldown');
  assert.match(c.name, /cool-down/);
  assert.ok(c.lines.length);
  assert.equal(ctx.toasted, `Wrote ${c.name} · not saved to the library yet`);
});

test('Google Doc: sessions added but not recorded as added: says so once and stops', async () => {
  const doc = (id) => ({ id, title: `Made-up week ${id}`, url: `https://docs.google.com/document/d/${id}/edit` });
  const ctx = makeCtx(fakePage(), today, { plan: { ...plan, weekDocs: { '2026-10-19': doc('D1'), '2026-10-26': doc('D2') } } });
  ctx.rerender = () => {};
  const written = (date) => practiceRecord({ date, slot: 'AM', focus: 'aerobic', blocks: [aerobic], rounds: 1, composed: composePractice({ blocks: [aerobic] }), text: '' });
  const recs = [written('2026-10-20'), written('2026-10-21'), written('2026-10-27')];
  ctx.state.log = [...recs];
  const updated = [];
  const fake = { callTool: async (server, tool, input) => {
    if (tool === 'read_doc') return { payload: { content: { documentId: input.documentId, revisionId: 'r1', title: 'Made-up', body: { content: [{ endIndex: 1 }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n', textStyle: {} } }] } }] } } } };
    if (tool === 'update_doc') { updated.push(input.documentId); return { payload: {} }; }
    throw new Error(`unexpected ${tool}`);
  } };
  globalThis.window.claude = { use: async (name) => (name === 'mcp' ? fake : null) };
  // The capability wait (10 s) must not hold the test run open.
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realTimeout(fn, ms, ...a); if (ms >= 10000) t.unref?.(); return t; };
  try {
    ctx.storeOk = false;
    const added = await addToDoc(ctx, recs);
    assert.equal(added, 2);
    assert.deepEqual(updated, ['D1'], 'stopped after the first week');
    const [msg, opts] = ctx.toasts.at(-1);
    assert.equal(msg, 'Added to “Made-up week D1”, but the app couldn\'t record that. Don\'t add them again.');
    assert.equal(opts.error, true);
    assert.equal(ctx.toasts.filter(([m]) => /couldn't record/.test(m)).length, 1, 'one toast');

    ctx.storeOk = true;
    updated.length = 0;
    assert.equal(await addToDoc(ctx, [recs[2]]), 1);
    assert.deepEqual(updated, ['D2']);
    assert.equal(ctx.toasted, 'Added to “Made-up week D2”');
  } finally {
    globalThis.setTimeout = realTimeout;
    delete globalThis.window.claude;
  }
});
