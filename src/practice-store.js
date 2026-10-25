// Practice Writer storage. Two backends behind one async interface:
//  - 'db':    the claude.ai Artifact database (private to the artifact's owner),
//             used when the page runs as a published Artifact;
//  - 'local': localStorage on this device (GitHub Pages / local server).
// The app renders from local data at once and switches to the database when
// it answers (edits made meanwhile are journaled and replayed onto it).
//
// Writes never throw into the UI: they resolve true when stored and false when
// not, and a failure is also reported to onStatus listeners and kept so
// retryFailed() can send it again. A database read that fails REJECTS (an error
// with .code and .readFailed), so "could not read" is never mistaken for
// "nothing saved yet": loadAll then rejects too and writes nothing.

import { byDateDesc, defaultPlan, makeBlock, migratePlan, starterBlocks, uid } from './practice.js';

const KEYS = ['plan', 'prefs', 'style'];
const COLLECTIONS = ['blocks', 'log', 'debriefs'];
const LOCAL = (name) => `pool-practice-${name}`; // v1 used pool-practice-blocks/plan/log/prefs
const MAX = { log: 400, debriefs: 400 };
const WRITES_AT_ONCE = 6; // database writes in flight at once when copying many records

const DEFAULT_PREFS = { equipment: null, showDetail: true };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs at most `n` of the functions handed to it at once, in the order given;
// each call resolves with its function's result.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// The database's error codes, normalised: lifecycle codes mean the database
// can't be used in this view (like 'revoked'), and unknown codes count as
// 'unavailable', as the runtime contract asks.
const STORE_CODES = ['invalid_argument', 'resource_exhausted', 'quota_exceeded', 'unavailable', 'revoked'];
function errorCode(e) {
  const c = e?.code;
  if (c === 'transform_error') return 'invalid_argument';
  if (['not_granted', 'capability_disabled', 'capability_removed'].includes(c)) return 'revoked';
  return STORE_CODES.includes(c) ? c : 'unavailable';
}

function readError(path, e) {
  return Object.assign(new Error(`Could not read ${path}`), { code: errorCode(e), path, readFailed: true });
}

// Write bookkeeping shared by both backends: how many writes are queued or in
// flight, a sequence number (to notice a write that started during a read),
// and the writes that failed, by document, until a later write to the same
// document succeeds.
function writeTracker() {
  let seq = 0;
  let pending = 0;
  const failed = new Map(); // path → attempt
  const listeners = new Set();
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch (e) { console.error(e); } } };
  const track = (path, attempt) => {
    seq++;
    pending++;
    return Promise.resolve().then(attempt).then(
      () => { pending--; if (failed.delete(path)) emit({ op: 'write', ok: true, path }); return true; },
      (e) => {
        pending--;
        const code = errorCode(e);
        failed.set(path, attempt);
        console.warn('practice store: not saved', path, code);
        emit({ op: 'write', ok: false, path, code });
        return false;
      },
    );
  };
  return {
    track,
    emit,
    api: {
      pendingWrites: () => pending,
      writeSeq: () => seq,
      unsaved: () => failed.size,
      // Send every failed write again; resolves true when all are stored.
      async retryFailed() { return (await Promise.all([...failed].map(([path, attempt]) => track(path, attempt)))).every(Boolean); },
      onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    },
  };
}

// ------------------------------------------------------------------ local

function readLocal(name, fallback) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(LOCAL(name)));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// Returns the text stored.
function writeLocal(name, value) {
  try {
    const raw = JSON.stringify(value);
    globalThis.localStorage?.setItem(LOCAL(name), raw);
    return raw;
  } catch (e) {
    throw { code: e?.name === 'QuotaExceededError' ? 'quota_exceeded' : 'unavailable', message: String(e?.message || e) };
  }
}

// The stored text of a collection (null when there is none or it can't be read).
function rawLocal(name) {
  try { return globalThis.localStorage?.getItem(LOCAL(name)) ?? null; } catch { return null; }
}

// Newest first by date, capped for the collections that have a cap.
function capped(coll, list) {
  return MAX[coll] && list.length > MAX[coll] ? [...list].sort(byDateDesc).slice(0, MAX[coll]) : list;
}

export function localBackend() {
  const w = writeTracker();
  const list = (coll) => { const v = readLocal(coll, []); return Array.isArray(v) ? v : []; };
  // Each collection as last read or written here, with the text it was read
  // from: it is read again only when the stored text is not that (another
  // tab wrote it, or a write failed).
  const known = new Map(); // coll → { raw, list }
  const stored = (coll) => {
    const raw = rawLocal(coll);
    let c = known.get(coll);
    if (!c || c.raw !== raw) {
      let v = null;
      try { v = JSON.parse(raw); } catch { v = null; }
      c = { raw, list: Array.isArray(v) ? v : [] };
      known.set(coll, c);
    }
    return c.list;
  };
  // The changes made to a collection in one go (this tick) are applied in
  // order to what is stored and written back once, so two quick writes can't
  // undo each other; they are stored together or not at all, and a retry
  // applies its change again.
  const queued = new Map(); // coll → { fns, promise, resolve, reject }
  const flush = (coll) => {
    const q = queued.get(coll);
    queued.delete(coll);
    try {
      const all = q.fns.reduce((xs, fn) => fn(xs), stored(coll));
      known.set(coll, { raw: writeLocal(coll, all), list: all });
      q.resolve();
    } catch (e) {
      q.reject(e);
    }
  };
  const change = (path, coll, fn) => w.track(path, () => {
    let q = queued.get(coll);
    if (!q) {
      q = { fns: [] };
      q.promise = new Promise((resolve, reject) => Object.assign(q, { resolve, reject }));
      queued.set(coll, q);
      queueMicrotask(() => flush(coll));
    }
    q.fns.push(fn);
    return q.promise;
  });
  return {
    kind: 'local',
    ...w.api,
    async get(key) { return readLocal(key, null); },
    set(key, value) { const v = clone(value); return w.track(key, () => writeLocal(key, v)); },
    async list(coll) { return list(coll); },
    put(coll, id, value) {
      const v = clone({ ...value, id });
      return change(`${coll}/${id}`, coll, (all) => { const out = [v, ...all.filter((x) => x?.id !== id)]; return MAX[coll] ? out.slice(0, MAX[coll]) : out; });
    },
    remove(coll, id) { return change(`${coll}/${id}`, coll, (all) => all.filter((x) => x?.id !== id)); },
    // Add or replace by id, like the database; records not in `values` stay.
    putMany(coll, values) {
      const items = clone(values);
      return change(coll, coll, (all) => {
        const byId = new Map(items.map((v, i) => [v?.id ?? `#${i}`, v])); // a later duplicate wins
        const out = all.map((x) => (byId.has(x?.id) ? byId.get(x.id) : x));
        const here = new Set(all.map((x) => x?.id));
        return capped(coll, [...[...byId.values()].filter((v) => v?.id == null || !here.has(v.id)), ...out]);
      });
    },
    onChange() { return () => {}; },
  };
}

// --------------------------------------------------------------------- db

// Documents: kv/<key> → { value }, <coll>/<id> → value. Writes to one
// document are serialised; ids are made safe for the path grammar.
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 180) || 'x';

// One retry for what can pass: a short random delay for 'unavailable', a
// longer one for 'resource_exhausted' (slow down). The other codes can't
// succeed on a retry.
const BACKOFF = { unavailable: [400, 600], resource_exhausted: [2000, 2000] };

export function dbBackend(db) {
  const w = writeTracker();
  const chains = new Map();
  const serial = (path, fn) => {
    const prev = chains.get(path) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    chains.set(path, next);
    return next.finally(() => { if (chains.get(path) === next) chains.delete(path); });
  };
  const retry = async (fn) => {
    try { return await fn(); } catch (e) {
      const wait = BACKOFF[errorCode(e)];
      if (!wait) throw e;
      await sleep(wait[0] + Math.random() * wait[1]);
      return fn();
    }
  };
  // The body is copied when the write is made, so a retry sends what the
  // coach saved then.
  const write = (path, body) => w.track(path, () => serial(path, () => retry(() => (body === undefined ? db.doc(path).delete() : db.doc(path).set(body)))));
  const many = limiter(WRITES_AT_ONCE);
  return {
    kind: 'db',
    ...w.api,
    async get(key) {
      const path = `kv/${key}`;
      let s;
      try { s = await retry(() => db.doc(path).get()); } catch (e) { throw readError(path, e); }
      return s.exists ? (s.data()?.value ?? null) : null;
    },
    set(key, value) { return write(`kv/${key}`, clone({ value })); },
    async list(coll) {
      let snap;
      try { snap = await retry(() => db.collection(coll).limit(1000).get()); } catch (e) { throw readError(coll, e); }
      return snap.docs.map((d) => ({ ...d.data(), id: d.data()?.id ?? d.id }));
    },
    put(coll, id, value) { return write(`${coll}/${safeId(id)}`, clone({ ...value, id })); },
    remove(coll, id) { return write(`${coll}/${safeId(id)}`, undefined); },
    // Up to WRITES_AT_ONCE records in flight (writes to one record stay in order).
    async putMany(coll, values) {
      const items = clone(values);
      return (await Promise.all(items.map((v) => many(() => this.put(coll, v.id, v))))).every(Boolean);
    },
    // Live updates from other devices: one subscription per collection and
    // key, debounced into a single callback. Each listener's first delivery
    // is the current state. A listener the runtime ends with an error
    // ('unavailable' when the bridge died, 'resource_exhausted') is
    // re-subscribed once after a pause, then catches up; a second error, or
    // any other code, ends live updates for it and reports
    // { op: 'sync', ok: false, final: true } to onStatus listeners.
    onChange(fn) {
      let timer = null;
      let stopped = false;
      const fire = () => { clearTimeout(timer); timer = setTimeout(fn, 300); };
      const subs = new Map();
      const retried = new Set();
      const timers = new Set();
      const stop = () => {
        stopped = true;
        clearTimeout(timer);
        timers.forEach(clearTimeout);
        subs.forEach((u) => { try { u(); } catch { /* gone */ } });
        subs.clear();
      };
      const subscribe = (name, ref, again = false) => {
        let first = true;
        let dead = false;
        const next = (snap) => {
          if (stopped || dead) return;
          if (first) { first = false; if (again) fire(); return; } // after a re-subscribe: catch up on what was missed
          if (snap?.metadata?.hasPendingWrites) return; // our own write
          fire();
        };
        const error = (e) => {
          if (stopped || dead) return;
          dead = true;
          subs.delete(name);
          const code = errorCode(e);
          if (code === 'revoked') { stop(); w.emit({ op: 'sync', ok: false, code, final: true }); return; }
          const wait = BACKOFF[code];
          if (!wait || retried.has(name)) { w.emit({ op: 'sync', ok: false, code, name, final: true }); return; }
          retried.add(name);
          const t = setTimeout(() => { timers.delete(t); if (!stopped) subscribe(name, ref, true); }, (code === 'unavailable' ? 1000 : 5000) + Math.random() * 2000);
          timers.add(t);
        };
        try { subs.set(name, ref().onSnapshot(next, error)); } catch (e) { error(e); }
      };
      for (const c of COLLECTIONS) subscribe(c, () => db.collection(c));
      for (const k of KEYS) subscribe(k, () => db.doc(`kv/${k}`));
      return stop;
    },
  };
}

// ------------------------------------------------------------------- open

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);
}

// Resolve the database when this page runs as an Artifact, else local.
export async function openStore({ timeoutMs = 4000 } = {}) {
  const local = localBackend();
  const use = globalThis.window?.claude?.use;
  if (typeof use !== 'function') return local;
  let db = null;
  try { db = await withTimeout(globalThis.window.claude.use('db'), timeoutMs); } catch { db = null; }
  if (!db) return local;
  const store = dbBackend(db);
  // Probe: when the database can't be used in this view ('revoked' and the
  // runtime's lifecycle codes) fall back to local. Any other failed read means
  // "not reachable just now": the app keeps this device's data on screen,
  // says so, and tries again; it never treats that as an empty database.
  try { await withTimeout(db.doc('kv/plan').get(), timeoutMs); } catch (e) { if (errorCode(e) === 'revoked') return local; }
  // If the database can't be read just now, copying this device's data waits
  // for the first load that can read it (loadAll), never for a guess.
  try { await migrateLocalToDb(local, store); } catch {
    store.pendingMigration = async () => { await migrateLocalToDb(local, store); delete store.pendingMigration; };
  }
  return store;
}

// The first time the database is used, copy what this device already has.
// Rejects, copying nothing, when the database can't be read.
export async function migrateLocalToDb(local, store) {
  const [plan, blocks] = await Promise.all([store.get('plan'), store.list('blocks')]);
  if (plan || blocks.length) return false;
  const [keys, colls] = await Promise.all([Promise.all(KEYS.map((k) => local.get(k))), Promise.all(COLLECTIONS.map((c) => local.list(c)))]);
  if (!keys[KEYS.indexOf('plan')] && !colls[COLLECTIONS.indexOf('blocks')].length) return false;
  await Promise.all([
    ...KEYS.map((key, i) => (keys[i] != null ? store.set(key, keys[i]) : null)),
    ...COLLECTIONS.map((coll, i) => store.putMany(coll, colls[i])),
  ]);
  return true;
}

// ------------------------------------------------------------ app loading

// Everything the app needs, normalised, with defaults for a first run.
// Rejects when the store can't be read, without writing anything: only reads
// that succeeded and found nothing make a first run (starter blocks).
export async function loadAll(store) {
  if (store.pendingMigration) await store.pendingMigration();
  const [plan, prefs, style, blocks, log, debriefs] = await Promise.all([
    store.get('plan'), store.get('prefs'), store.get('style'),
    store.list('blocks'), store.list('log'), store.list('debriefs'),
  ]);
  const first = !plan && !blocks.length;
  const out = {
    plan: plan ? migratePlan(plan) : defaultPlan(),
    prefs: { ...DEFAULT_PREFS, ...(prefs || {}) },
    style: style || null,
    blocks: (blocks.length ? blocks : first ? starterBlocks() : []).map(makeBlock),
    log: [...log].sort(byDateDesc),
    debriefs: [...debriefs].sort(byDateDesc),
    planIsDefault: !plan,
  };
  if (first) await store.putMany('blocks', out.blocks);
  return out;
}

// ------------------------------------------- edits made while connecting

// A store that also records every write, so edits made on this device while
// the database is still connecting can be replayed onto it (replayJournal).
export function journaling(store) {
  const j = Object.create(store);
  j.journal = [];
  for (const op of ['set', 'put', 'remove', 'putMany']) {
    j[op] = (...args) => { j.journal.push([op, ...clone(args)]); return store[op](...args); };
  }
  return j;
}

// Fold edits (base → edited) into what is saved now (current), field by field
// at the top level. Without a saved value the edit stands. Without a base to
// tell what changed (nothing was loaded), or when the base was only the
// starter default (`fromDefault`), nothing structured is applied: then only
// plain fields (a name, a date, a unit) carry over, so a default never
// replaces real data. `dropped` says some edits were not applied.
export function mergeEdits(base, edited, current, { fromDefault = false } = {}) {
  if (!isObj(current)) return { value: edited, dropped: false };
  if (!isObj(base) || !isObj(edited)) return { value: current, dropped: true };
  const value = { ...current };
  let dropped = false;
  for (const k of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    if (canon(base[k]) === canon(edited[k])) continue;
    if (fromDefault && edited[k] !== null && typeof edited[k] === 'object') { dropped = true; continue; }
    if (edited[k] === undefined) delete value[k]; else value[k] = edited[k];
  }
  return { value, dropped };
}

// Replay a journal onto the database. Keys merge what the coach changed since
// `base` (the data the edits were made on) into what the database holds now;
// keys listed in `defaults` were starter defaults on this device. Records are
// put and removed by id, in order. Rejects when the database can't be read;
// resolves { ok, dropped: [keys whose edits were not all applied] }. Safe to
// run again: the result is the same.
export async function replayJournal(db, journal, base, { defaults = [] } = {}) {
  const sets = new Map();
  const ops = [];
  for (const [op, ...args] of journal) {
    if (op === 'set') sets.set(args[0], args[1]); else ops.push([op, ...args]);
  }
  let ok = true;
  const dropped = [];
  for (const [key, edited] of sets) {
    const current = await db.get(key);
    const r = mergeEdits(base?.[key], edited, current, { fromDefault: defaults.includes(key) });
    if (r.dropped) dropped.push(key);
    if (canon(r.value) !== canon(current)) ok = (await db.set(key, r.value)) && ok;
  }
  for (const [op, ...args] of ops) ok = (await db[op](...args)) && ok;
  return { ok, dropped };
}

// JSON with object keys sorted, to compare saved data.
export const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x)) ?? 'undefined';

// ------------------------------------------------------------ backup file

// Backup file: everything in one JSON document. Rejects when the store can't
// be read, rather than writing an empty backup.
export async function exportAll(store) {
  const data = { version: 2, exported: new Date().toISOString() };
  const [keys, colls] = await Promise.all([Promise.all(KEYS.map((k) => store.get(k))), Promise.all(COLLECTIONS.map((c) => store.list(c)))]);
  KEYS.forEach((k, i) => { data[k] = keys[i]; });
  COLLECTIONS.forEach((c, i) => { data[c] = colls[i]; });
  return JSON.stringify(data, null, 2);
}

// Import merges: blocks, practices and debriefs in the file are added, or
// replace the ones here with the same id; nothing that is only here is
// deleted. The plan, prefs and style in the file replace the ones here.
// Resolves true when every write was stored.
export async function importAll(store, json) {
  const data = JSON.parse(json);
  const rows = (list) => list.filter(isObj).map((x) => (x.id == null || x.id === '' ? { ...x, id: uid('i') } : x));
  const writes = [];
  if (data.plan) writes.push(store.set('plan', migratePlan(data.plan)));
  if (data.prefs) writes.push(store.set('prefs', data.prefs));
  if (data.style) writes.push(store.set('style', data.style));
  for (const coll of COLLECTIONS) {
    if (!Array.isArray(data[coll])) continue;
    const items = rows(data[coll]);
    writes.push(store.putMany(coll, coll === 'blocks' ? items.map(makeBlock) : items));
  }
  return (await Promise.all(writes)).every(Boolean);
}
