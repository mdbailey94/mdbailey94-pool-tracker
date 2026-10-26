// Practice Writer shell: state, storage, the Claude runtime, tabs and the
// shared context every view renders with. Views live in ./views/*.js and
// export render(ctx).

import { byDateDesc, setupDone, todayISO, uid } from '../practice.js';
import { blockScores, intervalCalibration, withTiming } from '../learn.js';
import { learnStyle, writingContext } from '../setlang.js';
import { canon, journaling, loadAll, localBackend, openStore, replayJournal } from '../practice-store.js';
import { $, $$, bindChips, chips, confirmAction, copyText, esc, saveFile, toast } from './ui.js';
import * as today from './views/today.js';
import * as week from './views/week.js';
import * as coach from './views/coach.js';
import * as build from './views/build.js';
import * as debrief from './views/debrief.js';
import * as blocks from './views/blocks.js';
import * as season from './views/season.js';
import * as log from './views/log.js';
import * as setup from './views/setup.js';

// `setup` (planning the season together) has no tab: it opens by itself
// until done or skipped, and from Season.
const VIEWS = { today, week, coach, build, debrief, blocks, season, log, setup };
export const TABS = [
  ['today', 'Today'], ['week', 'Week'], ['coach', 'Coach'], ['build', 'Build'], ['debrief', 'Debrief'],
  ['blocks', 'Blocks'], ['season', 'Season'], ['log', 'Log'],
];

const view = $('#view');
const IS_ARTIFACT = !!window.PW_ARTIFACT;
const HAS_RUNTIME = typeof window.claude?.use === 'function';

export const state = {
  tab: 'today',
  today: todayISO(),
  plan: null,
  blocks: [],
  log: [],
  debriefs: [],
  prefs: {},
  style: null,
  planIsDefault: true,
  storeKind: 'local',
  // Per-view working state (kept across tab switches).
  draft: { date: todayISO(), slot: 'AM', title: '', focus: null, blocks: [], rounds: 3, pattern: 'even' },
  ask: null,
  suggestion: null,
  chat: { history: [], busy: false, controller: null, error: null },
  debriefing: null, // the debrief being edited
  ui: {},          // scratch space views may use (open sections, filters)
};

// This device's storage. Until the database answers, writes go here through
// a journal (journaling) that is replayed onto the database when it does.
const local = localBackend();
let store = local;
const claude = { sample: null, downloads: null, connecting: HAS_RUNTIME };

// Derived learning, recomputed when debriefs or blocks change.
function learned() {
  const calibration = intervalCalibration(withTiming(state.debriefs, state.log), state.today);
  return {
    weights: blockScores(state.debriefs, state.today),
    calibration,
    writing: writingContext(state.plan, { style: state.style, calibration }),
  };
}

// Each save changes the state first and resolves true when the write was
// stored. A write that fails keeps the change on screen; the coach sees a
// toast and a "Not saved" note with Try again (onStoreStatus).
const save = {
  async plan() { state.planIsDefault = false; return store.set('plan', state.plan); },
  async prefs() { return store.set('prefs', state.prefs); },
  async style() { return store.set('style', state.style); },
  async block(b) {
    const i = state.blocks.findIndex((x) => x.id === b.id);
    if (i >= 0) state.blocks[i] = b; else state.blocks.push(b);
    return store.put('blocks', b.id, b);
  },
  async removeBlock(id) { state.blocks = state.blocks.filter((b) => b.id !== id); return store.remove('blocks', id); },
  async log(rec) {
    state.log = [rec, ...state.log.filter((r) => r.id !== rec.id)].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
    return store.put('log', rec.id, rec);
  },
  async removeLog(id) { state.log = state.log.filter((r) => r.id !== id); return store.remove('log', id); },
  async debrief(d) {
    state.debriefs = [d, ...state.debriefs.filter((x) => x.id !== d.id)].sort(byDateDesc);
    return store.put('debriefs', d.id, d);
  },
  async removeDebrief(id) { state.debriefs = state.debriefs.filter((d) => d.id !== id); return store.remove('debriefs', id); },
  // Re-learn the style profile from the coach's own blocks (source 'coach',
  // 'pasted', 'drive') and saved practices. Lines the app wrote are left out:
  // they already carry the debrief adjustments, which would then count twice.
  async relearn() {
    const own = state.blocks.filter((b) => ['coach', 'pasted', 'drive'].includes(b.source) && b.lines.length).map((b) => [b.name, ...b.lines].join('\n'));
    const texts = [...own, ...state.log.flatMap((r) => (r.blocks || []).filter((b) => b.lines?.length && b.source !== 'generated').map((b) => b.lines.join('\n')))];
    if (!texts.length) return null;
    state.style = { ...learnStyle(texts, state.plan.gears || {}), guide: state.style?.guide || '' };
    await store.set('style', state.style);
    return state.style;
  },
};

export function go(tab) {
  if (!VIEWS[tab]) return;
  state.tab = tab;
  $$('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    if (on) b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); // the tab bar scrolls sideways on phones
  });
  try { history.replaceState(null, '', `#${tab}`); } catch { /* sandboxed */ }
  rerender();
  window.scrollTo({ top: 0 });
}

export function rerender() {
  const ctx = { state, store, save, go, rerender, claude, learned: learned(), isArtifact: IS_ARTIFACT, uid, $, $$, esc, toast, confirmAction, copyText, saveFile: offerFile, chips, bindChips };
  try {
    VIEWS[state.tab].render(ctx, view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<section class="card"><h2>Something went wrong</h2><p class="form-error">${esc(e.message)}</p><p class="muted small">Your data is safe. Try another tab or reload.</p></section>`;
  }
}

function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = TABS.map(([k, l]) => `<button class="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}${k === 'debrief' ? '<span class="dot" id="debrief-dot" hidden></span>' : ''}</button>`).join('');
  $$('.tab', nav).forEach((b) => { b.onclick = () => go(b.dataset.tab); });
}

export function updateDebriefDot() {
  const dot = $('#debrief-dot');
  if (!dot) return;
  const done = new Set(state.debriefs.map((d) => d.practiceId));
  dot.hidden = !state.log.some((r) => r.date <= state.today && !done.has(r.id));
}

// The setup talk, once the saved data is in (not this device's copy while
// the database is still connecting).
function maybeSetup() {
  if (!setupDone(state.plan) && state.tab !== 'setup') go('setup');
}

async function loadInto(s) {
  const data = await loadAll(s);
  Object.assign(state, data);
  state.storeKind = s.kind;
}

// The saved data in a form that ignores key and list order, to tell a change
// from another device from our own writes coming back from the database.
const byId = (list) => [...(list || [])].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
const savedSig = (d) => canon({ plan: d.plan, prefs: d.prefs, style: d.style, blocks: byId(d.blocks), log: byId(d.log), debriefs: byId(d.debriefs) });

// ------------------------------------------------------- saving and sync

// What the coach should know about saving, shown above the view:
//  offline: the database answered but can't be read yet (this device's data
//           is on screen, edits are kept here and replayed when it loads);
//  stale:   a refresh from the database failed (the last good data stays);
//  failed:  the last write that was not saved: { code, kind } (the store's kind);
//  dropped: keys whose edits made while connecting could not be applied;
//  live:    false once live updates from other devices have stopped.
const sync = { offline: false, stale: false, failed: null, dropped: [], live: true };

const WRITE_HINT = {
  quota_exceeded: 'The saved data is full: delete old practices or blocks, then try again.',
  invalid_argument: "This page can't save these changes.",
  resource_exhausted: 'Too many saves at once. Try again in a moment.',
  revoked: 'Saving is off on this page.',
  unavailable: 'Check the connection, then try again.',
};
const LOCAL_HINT = {
  quota_exceeded: "This device's storage is full: export a backup and delete old practices, then try again.",
  unavailable: "This browser isn't letting the page save on this device (a private window, or storage turned off).",
};
const writeHint = (failed) => (failed?.kind === 'local' && LOCAL_HINT[failed.code]) || WRITE_HINT[failed?.code] || WRITE_HINT.unavailable;
const CAN_RETRY = ['quota_exceeded', 'resource_exhausted', 'unavailable'];
const DROPPED = { plan: 'the season plan', prefs: 'your settings', style: 'the style profile' };

function renderStatus() {
  let el = $('#pw-status');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'pw-status', className: 'view' });
    el.setAttribute('role', 'status');
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-sync]'); if (b) statusAction(b.dataset.sync, b); });
    view.before(el);
  }
  const notes = [];
  const unsaved = (store.journal ? 0 : store.unsaved?.() || 0) + (pendingDb?.unsaved() || 0);
  const failed = sync.failed || { code: 'unavailable', kind: store.kind };
  if (unsaved) notes.push(['alert', `Not saved: ${unsaved === 1 ? '1 change is' : `${unsaved} changes are`} only on this screen. ${writeHint(failed)}`, !pendingDb && CAN_RETRY.includes(failed.code) && ['retry', 'Try again']]);
  if (sync.offline) notes.push(['alert', "Can't reach your saved data right now. Showing what is on this device; changes you make are kept here and saved when it connects.", ['retry', 'Try again']]);
  else if (sync.stale) notes.push(['', "Couldn't refresh from your saved data. Showing what was loaded before.", null]);
  if (sync.dropped.length) notes.push(['', `Your saved data loaded. Changes made to this device's copy of ${sync.dropped.map((k) => DROPPED[k] || k).join(' and ')} while it was connecting were not all applied.`, ['dismiss', 'OK']]);
  if (!sync.live) notes.push(['', 'Live updates from your other devices are off. Reload the page to see changes made elsewhere.', null]);
  el.innerHTML = notes.map(([kind, msg, btn]) => `<div class="banner ${kind}" style="flex-wrap:wrap"><span style="flex:1 1 220px;min-width:0">${esc(msg)}</span>${btn ? `<button type="button" class="btn secondary small-btn" data-sync="${btn[0]}">${esc(btn[1])}</button>` : ''}</div>`).join('');
  el.style.cssText = notes.length ? 'display:grid;gap:8px;margin-bottom:12px' : 'display:none';
}

// Write failures and the end of live updates, from either store. While the
// database connects, this device's storage only backs up the journal (the
// edits reach the database from there), so its failures stay quiet.
const onStoreStatus = (kind) => (ev) => {
  if (kind === 'local' && store.journal) return;
  if (ev.op === 'write' && !ev.ok) {
    sync.failed = { code: ev.code, kind };
    toast(`Not saved. ${writeHint(sync.failed)}`, { error: true });
  }
  if (ev.op === 'write' && ev.ok && !store.unsaved?.() && !pendingDb?.unsaved()) sync.failed = null;
  if (ev.op === 'sync' && !ev.ok && ev.final) sync.live = false;
  renderStatus();
};

let retrying = false;
async function statusAction(action, button) {
  if (action === 'dismiss') { sync.dropped = []; renderStatus(); return; }
  if (action !== 'retry' || retrying) return;
  retrying = true;
  button.disabled = true;
  try {
    if (pendingDb) { connectTry = 0; await connect(pendingDb); return; }
    if (store.unsaved?.() && (await store.retryFailed())) {
      sync.failed = null;
      toast('Saved', { force: true });
      if (store.kind === 'db') reloadIfChanged(store);
    }
  } finally {
    retrying = false;
    renderStatus();
  }
}

// A read that failed and that no view caught (Export, for one): say so
// instead of failing silently.
window.addEventListener('unhandledrejection', (e) => {
  if (!e.reason?.readFailed) return;
  e.preventDefault();
  toast("Couldn't read your saved data just now. Try again in a moment.", { error: true });
});

// Reload from the database when it changes; re-render only when something
// really changed, so a confirmed write doesn't redraw the screen under the
// coach's cursor. Never while our own writes are queued, in flight or
// started during the read (the database is then older than the screen), and
// not while changes that failed to save are waiting for Try again. A read
// that fails keeps the data on screen, says so, and is tried once more.
let reloadTimer = null;
let reloadRetried = false;
async function reloadIfChanged(s) {
  clearTimeout(reloadTimer);
  if (s !== store) return;
  if (s.pendingWrites()) { reloadTimer = setTimeout(() => reloadIfChanged(s), 400); return; }
  if (s.unsaved()) return;
  const seq = s.writeSeq();
  let data;
  try {
    data = await loadAll(s);
  } catch (e) {
    console.warn('practice store: could not refresh', e?.code || e);
    sync.stale = true;
    renderStatus();
    if (!reloadRetried) { reloadRetried = true; reloadTimer = setTimeout(() => reloadIfChanged(s), 5000); }
    return;
  }
  reloadRetried = false;
  if (sync.stale) { sync.stale = false; renderStatus(); }
  if (s.writeSeq() !== seq || s.pendingWrites() || s.unsaved()) { reloadTimer = setTimeout(() => reloadIfChanged(s), 400); return; }
  if (savedSig(data) === savedSig(state)) return;
  Object.assign(state, data);
  state.storeKind = s.kind;
  rerender();
  updateDebriefDot();
}

// Switch to the database: replay the edits made on this device while it was
// connecting, then load it. When it can't be read, stay on this device's data
// (edits keep going into the journal), say so, and try again a few times.
let pendingDb = null;
let bootBase = null; // { data, defaults }: what edits made while connecting were made on
let connectTry = 0;
let connectTimer = null;
const CONNECT_RETRY_MS = [3000, 10000, 30000];

let connecting = false;

async function connect(db) {
  clearTimeout(connectTimer);
  if (connecting || store === db) return;
  connecting = true;
  pendingDb = db;
  const journal = store.journal || [];
  const n = journal.length;
  let data;
  let dropped = [];
  try {
    if (db.pendingMigration) await db.pendingMigration();
    // A replayed write that fails is reported (Not saved) and kept in the
    // journal: the switch waits until it is stored.
    const r = await replayJournal(db, journal, bootBase?.data, { defaults: bootBase?.defaults });
    if (!r.ok) throw new Error('edits made while connecting were not saved');
    dropped = r.dropped;
    data = await loadAll(db);
  } catch (e) {
    console.warn('practice store: database not loaded', e?.code || e?.message || e);
    sync.offline = true;
    renderStatus();
    if (connectTry < CONNECT_RETRY_MS.length) connectTimer = setTimeout(() => connect(db), CONNECT_RETRY_MS[connectTry++]);
    return;
  } finally {
    connecting = false;
  }
  // An edit made while this ran isn't in what was loaded: go round again.
  if (journal.length !== n) { connectTimer = setTimeout(() => connect(db), 200); return; }
  pendingDb = null;
  store = db;
  sync.offline = false;
  sync.dropped = dropped;
  Object.assign(state, data);
  state.storeKind = db.kind;
  db.onChange(() => reloadIfChanged(db));
  rerender();
  maybeSetup();
  updateDebriefDot();
  renderStatus();
  if (dropped.length) toast('Saved data loaded. Some changes made while it was connecting were not applied.');
}

// ------------------------------------------------------------- downloads

// The downloads capability, asked for once.
let downloadsUse = null;
function useDownloads() {
  if (!HAS_RUNTIME) return Promise.resolve(null);
  downloadsUse ??= window.claude.use('downloads').then((d) => (claude.downloads = d || null), () => (claude.downloads = null));
  return downloadsUse;
}

// Offer a file. In the artifact the sandbox ignores <a download>, so wait for
// the downloads capability, and when there is none show the text to copy.
async function offerFile(name, text) {
  let d = claude.downloads;
  if (!d && HAS_RUNTIME) {
    const note = setTimeout(() => toast('Getting the file ready…'), 400);
    d = await Promise.race([useDownloads(), new Promise((r) => setTimeout(() => r(null), 8000))]);
    clearTimeout(note);
  }
  return saveFile(d, name, text, { link: !IS_ARTIFACT });
}

// ------------------------------------------------------------------ boot

const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

async function boot() {
  const hash = (location.hash || '').slice(1);
  if (VIEWS[hash]) state.tab = hash;
  renderTabs();
  if (IS_ARTIFACT) $('.toplink')?.remove();
  await loadInto(local);
  if (HAS_RUNTIME) {
    // Edits made before the database answers are journaled for it.
    bootBase = { data: { plan: copy(state.plan), prefs: copy(state.prefs), style: copy(state.style) }, defaults: state.planIsDefault ? ['plan'] : [] };
    store = journaling(local);
  }
  local.onStatus(onStoreStatus('local'));
  go(state.tab);
  updateDebriefDot();
  renderStatus();

  // The Artifact runtime (claude.ai): private database, Claude, downloads.
  if (HAS_RUNTIME) {
    window.claude.use('sample').then((s) => { claude.sample = s || null; }).catch(() => {}).finally(() => { claude.connecting = false; if (['coach', 'today', 'week'].includes(state.tab)) rerender(); });
    useDownloads();
    const s = await openStore({ timeoutMs: 8000 });
    if (s.kind === 'db') {
      s.onStatus(onStoreStatus('db'));
      await connect(s);
    } else {
      store = local; // no database here: this device's storage, as before
      maybeSetup();
    }
  } else {
    maybeSetup();
  }
  if ('serviceWorker' in navigator && !IS_ARTIFACT && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
