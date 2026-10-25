import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbBackend, importAll, journaling, loadAll, localBackend, mergeEdits, migrateLocalToDb, openStore, replayJournal } from '../src/practice-store.js';

// In-memory stand-ins for localStorage and the Artifact database.
function fakeLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function fakeDb({ failFirst = 0 } = {}) {
  const docs = new Map();
  let failures = failFirst;
  const maybeFail = () => { if (failures > 0) { failures--; throw { code: 'unavailable', message: 'try again' }; } };
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path), metadata: { hasPendingWrites: false } });
  const doc = (path) => ({
    path,
    async get() { maybeFail(); return snap(path); },
    async set(v) { maybeFail(); docs.set(path, structuredClone(v)); },
    async delete() { docs.delete(path); },
    onSnapshot(next) { next(snap(path)); return () => {}; },
  });
  const collection = (path) => ({
    path,
    limit() { return this; },
    async get() {
      const list = [...docs.keys()].filter((k) => k.startsWith(`${path}/`) && k.split('/').length === path.split('/').length + 1).sort();
      return { docs: list.map(snap), size: list.length, empty: !list.length };
    },
    onSnapshot(next) { this.get().then(next); return () => {}; },
    doc: (id) => doc(`${path}/${id}`),
  });
  return { doc, collection, _docs: docs };
}

test('local backend keeps v1 keys and newest-first collections', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const s = localBackend();
  assert.equal(await s.get('plan'), null);
  await s.set('plan', { name: 'Season' });
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('pool-practice-plan')), { name: 'Season' });
  await s.put('log', 'a', { date: '2026-10-01' });
  await s.put('log', 'b', { date: '2026-10-02' });
  await s.put('log', 'a', { date: '2026-10-03' });
  assert.deepEqual((await s.list('log')).map((r) => r.id), ['a', 'b']);
  await s.remove('log', 'b');
  assert.deepEqual((await s.list('log')).map((r) => r.id), ['a']);
  globalThis.localStorage.setItem('pool-practice-blocks', '{not json');
  assert.deepEqual(await s.list('blocks'), []);
  delete globalThis.localStorage;
});

test('db backend stores keys and collections as documents, retries once', async () => {
  const db = fakeDb({ failFirst: 1 });
  const s = dbBackend(db);
  assert.equal(await s.set('plan', { name: 'Season' }), true); // first try fails 'unavailable', retry succeeds
  assert.deepEqual(db._docs.get('kv/plan'), { value: { name: 'Season' } });
  assert.deepEqual(await s.get('plan'), { name: 'Season' });
  await s.put('blocks', 'b/1 weird id', { name: 'Warm-up' });
  assert.ok(db._docs.has('blocks/b_1_weird_id'));
  assert.deepEqual(await s.list('blocks'), [{ name: 'Warm-up', id: 'b/1 weird id' }]);
  await s.remove('blocks', 'b/1 weird id');
  assert.deepEqual(await s.list('blocks'), []);
});

test('writes to one document are applied in order', async () => {
  const db = fakeDb();
  const s = dbBackend(db);
  await Promise.all([1, 2, 3, 4].map((n) => s.set('prefs', { n })));
  assert.deepEqual(await s.get('prefs'), { n: 4 });
});

test('first database use copies this device\'s data once', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const local = localBackend();
  await local.set('plan', { name: 'Mine' });
  await local.put('blocks', 'x', { name: 'Kick' });
  const db = fakeDb();
  const store = dbBackend(db);
  assert.equal(await migrateLocalToDb(local, store), true);
  assert.deepEqual(await store.get('plan'), { name: 'Mine' });
  assert.equal((await store.list('blocks')).length, 1);
  assert.equal(await migrateLocalToDb(local, store), false); // db already has data
  delete globalThis.localStorage;
});

test('openStore falls back to local without the Artifact runtime', async () => {
  const s = await openStore({ timeoutMs: 50 });
  assert.equal(s.kind, 'local');
  globalThis.window = { claude: { use: () => new Promise(() => {}) } }; // never answers
  assert.equal((await openStore({ timeoutMs: 50 })).kind, 'local');
  globalThis.window = { claude: { use: async () => fakeDb() } };
  assert.equal((await openStore({ timeoutMs: 50 })).kind, 'db');
  delete globalThis.window;
});

// A database whose reads and writes can be made to fail with a code, and whose
// listeners the test can end with an error, as the runtime does.
function controlDb(seed = []) {
  const docs = new Map(seed);
  const fail = { read: null, write: null };
  const calls = { set: 0, get: 0 };
  const listeners = [];
  const err = (code) => ({ code, message: code });
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => structuredClone(docs.get(path)), metadata: { hasPendingWrites: false } });
  const listen = (name) => (next, error) => { const l = { name, next, error, live: true }; listeners.push(l); return () => { l.live = false; }; };
  const doc = (path) => ({
    async get() { calls.get++; if (fail.read) throw err(fail.read); return snap(path); },
    async set(v) { calls.set++; if (fail.write) throw err(fail.write); docs.set(path, structuredClone(v)); },
    async delete() { if (fail.write) throw err(fail.write); docs.delete(path); },
    onSnapshot: listen(path.replace(/^kv\//, '')),
  });
  const collection = (name) => ({
    limit() { return this; },
    async get() { calls.get++; if (fail.read) throw err(fail.read); return { docs: [...docs.keys()].filter((k) => k.startsWith(`${name}/`)).sort().map(snap) }; },
    onSnapshot: listen(name),
  });
  return {
    doc, collection, docs, fail, calls, listeners,
    deliver(name) { for (const l of listeners) if (l.name === name && l.live) l.next({ metadata: { hasPendingWrites: false } }); },
    end(name, code) { for (const l of listeners) if (l.name === name && l.live) { l.live = false; l.error(err(code)); } },
    live: (name) => listeners.filter((l) => l.name === name && l.live).length,
  };
}

const CLUB_PLAN = { name: 'Club plan', start: '2026-09-07', meets: [{ name: 'Test meet', start: '2026-11-14' }], phases: [{ name: 'Base', weeks: 4 }] };
const blockKeys = (db) => [...db.docs.keys()].filter((k) => k.startsWith('blocks/'));

test('a failed database read rejects instead of looking empty, and loadAll writes nothing', async () => {
  const db = controlDb([['kv/plan', { value: CLUB_PLAN }], ['blocks/own', { id: 'own', name: 'Sample kick' }]]);
  const s = dbBackend(db);
  db.fail.read = 'revoked';
  await assert.rejects(s.get('plan'), (e) => e.readFailed && e.code === 'revoked');
  await assert.rejects(s.list('blocks'), (e) => e.readFailed);
  await assert.rejects(loadAll(s), (e) => e.readFailed);
  assert.deepEqual(blockKeys(db), ['blocks/own']); // no starter blocks
  assert.equal(db.calls.set, 0);
  assert.equal(db.docs.get('kv/plan').value.name, 'Club plan');
  db.fail.read = null;
  const data = await loadAll(s);
  assert.equal(data.plan.name, 'Club plan');
  assert.equal(data.planIsDefault, false);
  assert.deepEqual(data.blocks.map((b) => b.name), ['Sample kick']);
});

test('an unknown read error counts as unavailable: retried once, then rejected', async () => {
  const db = controlDb([['kv/plan', { value: CLUB_PLAN }]]);
  const s = dbBackend(db);
  db.fail.read = 'internal';
  const before = db.calls.get;
  await assert.rejects(s.get('plan'), (e) => e.code === 'unavailable');
  assert.equal(db.calls.get - before, 2);
});

test('only a database that was read and found empty gets starter blocks', async () => {
  const db = controlDb();
  const data = await loadAll(dbBackend(db));
  assert.equal(data.planIsDefault, true);
  assert.ok(blockKeys(db).length > 0);
});

test('migration copies nothing when the database can\'t be read, and runs on the first load that can', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const local = localBackend();
  await local.set('plan', { name: 'Device plan' });
  await local.put('blocks', 'dev', { name: 'Device block' });
  const db = controlDb();
  db.fail.read = 'revoked';
  await assert.rejects(migrateLocalToDb(local, dbBackend(db)));
  assert.equal(db.docs.size, 0);
  // openStore: the probe fails 'unavailable' (not reachable just now), so the
  // database is kept and the copy waits for a load that can read it.
  db.fail.read = 'unavailable';
  globalThis.window = { claude: { use: async () => db } };
  const s = await openStore({ timeoutMs: 3000 });
  assert.equal(s.kind, 'db');
  assert.equal(typeof s.pendingMigration, 'function');
  await assert.rejects(loadAll(s));
  assert.equal(db.docs.size, 0);
  db.fail.read = null;
  const data = await loadAll(s);
  assert.equal(data.plan.name, 'Device plan');
  assert.deepEqual(data.blocks.map((b) => b.name), ['Device block']);
  assert.equal(s.pendingMigration, undefined);
  delete globalThis.window;
  delete globalThis.localStorage;
});

test('openStore falls back to local when the database is revoked for this view', async () => {
  const db = controlDb();
  db.fail.read = 'revoked';
  globalThis.window = { claude: { use: async () => db } };
  assert.equal((await openStore({ timeoutMs: 200 })).kind, 'local');
  delete globalThis.window;
});

test('import merges by id on this device: nothing that is only here is deleted', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const s = localBackend();
  await s.put('blocks', 'own', { name: 'Own block', category: 'aerobic' });
  await s.put('blocks', 'both', { name: 'Old name', category: 'kick' });
  await s.put('log', 'mine', { date: '2026-10-20', title: 'Mon here' });
  await s.put('debriefs', 'd1', { practiceId: 'mine', date: '2026-10-20', sections: [] });
  const file = { blocks: [{ id: 'both', name: 'New name', category: 'kick' }, { id: 'other', name: 'Other device block', category: 'kick' }], log: [{ id: 'theirs', date: '2026-10-21', title: 'Tue there' }], debriefs: [] };
  assert.equal(await importAll(s, JSON.stringify(file)), true);
  const d = await loadAll(s);
  assert.deepEqual(d.blocks.map((b) => b.name).sort(), ['New name', 'Other device block', 'Own block']);
  assert.deepEqual(d.log.map((r) => r.title), ['Tue there', 'Mon here']);
  assert.equal(d.debriefs.length, 1);
  delete globalThis.localStorage;
});

test('import merges the same way into the database', async () => {
  const db = controlDb([['blocks/own', { id: 'own', name: 'Own block' }], ['log/mine', { id: 'mine', date: '2026-10-20' }]]);
  const s = dbBackend(db);
  await importAll(s, JSON.stringify({ blocks: [{ id: 'other', name: 'Other device block' }], log: [], debriefs: [] }));
  assert.deepEqual(blockKeys(db).sort(), ['blocks/other', 'blocks/own']);
  assert.ok(db.docs.has('log/mine'));
});

test('an imported log over the cap keeps the newest practices', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const s = localBackend();
  await s.put('log', 'recent', { date: '2026-10-20' });
  const old = Array.from({ length: 400 }, (_, i) => ({ id: `old${i}`, date: `2025-0${1 + (i % 9)}-01` }));
  await importAll(s, JSON.stringify({ log: old }));
  const log = await s.list('log');
  assert.equal(log.length, 400);
  assert.ok(log.some((r) => r.id === 'recent'));
  delete globalThis.localStorage;
});

test('two quick writes to one collection on this device both land', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const s = localBackend();
  await Promise.all([s.put('blocks', 'a', { name: 'A' }), s.put('blocks', 'b', { name: 'B' })]);
  assert.deepEqual((await s.list('blocks')).map((b) => b.id).sort(), ['a', 'b']);
  delete globalThis.localStorage;
});

test('a rejected write resolves false, is reported with its code, and is kept until a retry stores it', async () => {
  const db = controlDb();
  const s = dbBackend(db);
  const events = [];
  s.onStatus((e) => events.push(e));
  db.fail.write = 'quota_exceeded';
  assert.equal(await s.put('blocks', 'new', { name: 'Sample pull' }), false);
  assert.equal(db.calls.set, 1); // retrying can't help a full database
  assert.deepEqual(events, [{ op: 'write', ok: false, path: 'blocks/new', code: 'quota_exceeded' }]);
  assert.equal(s.unsaved(), 1);
  assert.equal(await s.retryFailed(), false);
  db.fail.write = null;
  assert.equal(await s.retryFailed(), true);
  assert.equal(s.unsaved(), 0);
  assert.equal(db.docs.get('blocks/new').name, 'Sample pull');
  assert.deepEqual(events.at(-1), { op: 'write', ok: true, path: 'blocks/new' });
});

test('a later write to the same document replaces a failed one', async () => {
  const db = controlDb();
  const s = dbBackend(db);
  db.fail.write = 'invalid_argument';
  await s.set('prefs', { minutes: 60 });
  assert.equal(s.unsaved(), 1);
  db.fail.write = null;
  await s.set('prefs', { minutes: 90 });
  assert.equal(s.unsaved(), 0);
  assert.equal(await s.retryFailed(), true); // nothing left to send
  assert.deepEqual(db.docs.get('kv/prefs').value, { minutes: 90 });
});

test('a full device storage is reported, and a retry stores the change once there is room', async () => {
  const ls = fakeLocalStorage();
  let full = true;
  const setItem = ls.setItem;
  ls.setItem = (k, v) => { if (full) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); setItem(k, v); };
  globalThis.localStorage = ls;
  const s = localBackend();
  const events = [];
  s.onStatus((e) => events.push(e));
  assert.equal(await s.put('log', 'p1', { date: '2026-10-20' }), false);
  assert.equal(events[0].code, 'quota_exceeded');
  full = false;
  assert.equal(await s.retryFailed(), true);
  assert.deepEqual((await s.list('log')).map((r) => r.id), ['p1']);
  delete globalThis.localStorage;
});

test('pending writes and the write sequence tell a reload to wait', async () => {
  const db = controlDb();
  let release;
  const gate = new Promise((r) => { release = r; });
  const set = db.doc('kv/plan').set;
  db.doc = ((doc) => (path) => ({ ...doc(path), async set(v) { await gate; return set.call(this, v); } }))(db.doc);
  const s = dbBackend(db);
  const seq = s.writeSeq();
  const w = s.set('plan', CLUB_PLAN);
  assert.equal(s.pendingWrites(), 1);
  assert.equal(s.writeSeq(), seq + 1);
  release();
  assert.equal(await w, true);
  assert.equal(s.pendingWrites(), 0);
});

test('live updates: a listener ended by the runtime is re-subscribed once, then reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = controlDb();
  const s = dbBackend(db);
  const status = [];
  s.onStatus((e) => status.push(e));
  let fired = 0;
  s.onChange(() => { fired++; });
  // 'blocks' dies before its first delivery: the others still report changes.
  db.end('blocks', 'unavailable');
  for (const n of ['log', 'debriefs', 'plan', 'prefs', 'style']) db.deliver(n);
  db.deliver('log');
  t.mock.timers.tick(300);
  assert.equal(fired, 1);
  t.mock.timers.tick(3000); // backoff, then a fresh subscription
  assert.equal(db.live('blocks'), 1);
  db.deliver('blocks'); // its first delivery after a re-subscribe catches up
  t.mock.timers.tick(300);
  assert.equal(fired, 2);
  db.deliver('blocks');
  t.mock.timers.tick(300);
  assert.equal(fired, 3);
  // A second error: no more re-subscribing, and the app is told.
  db.end('blocks', 'unavailable');
  t.mock.timers.tick(10000);
  assert.equal(db.live('blocks'), 0);
  assert.deepEqual(status, [{ op: 'sync', ok: false, code: 'unavailable', name: 'blocks', final: true }]);
});

test('live updates: revoked stops every listener and is reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = controlDb();
  const s = dbBackend(db);
  const status = [];
  s.onStatus((e) => status.push(e));
  s.onChange(() => {});
  db.end('plan', 'revoked');
  t.mock.timers.tick(10000);
  assert.equal(db.listeners.filter((l) => l.live).length, 0);
  assert.equal(status.length, 1);
  assert.equal(status[0].code, 'revoked');
});

test('mergeEdits applies the fields the coach changed onto what is saved now', () => {
  const base = { name: 'Season', start: '2026-09-07', meets: [] };
  const edited = { name: 'Renamed', start: '2026-09-07', meets: [{ name: 'Made-up meet' }] };
  const saved = { name: 'Club plan', start: '2026-08-31', meets: [{ name: 'Test meet' }], groups: [{ name: 'Lane 1' }] };
  assert.deepEqual(mergeEdits(base, edited, saved).value, { name: 'Renamed', start: '2026-08-31', meets: [{ name: 'Made-up meet' }], groups: [{ name: 'Lane 1' }] });
  // On the starter default only plain fields carry over: the saved meets stay.
  const r = mergeEdits(base, edited, saved, { fromDefault: true });
  assert.deepEqual(r.value, { ...saved, name: 'Renamed' });
  assert.equal(r.dropped, true);
  assert.deepEqual(mergeEdits(base, edited, null).value, edited); // nothing saved yet
  assert.deepEqual(mergeEdits(null, { guide: '' }, { guide: 'Mine' }), { value: { guide: 'Mine' }, dropped: true });
});

test('edits made while the database connects are replayed onto it, without replacing the saved plan', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const local = localBackend();
  const boot = await loadAll(local); // a new device: the starter default
  const base = { plan: structuredClone(boot.plan), prefs: structuredClone(boot.prefs), style: null };
  const s = journaling(local);
  await s.set('plan', { ...boot.plan, name: 'Renamed while connecting', phases: [] });
  await s.set('prefs', { ...boot.prefs, minutes: 45 });
  await s.put('blocks', 'new', { name: 'Block typed while connecting' });
  await s.put('log', 'p1', { date: '2026-10-20' });
  await s.remove('log', 'p1');
  assert.equal(s.journal.length, 5);
  assert.equal((await local.get('plan')).name, 'Renamed while connecting'); // also kept on this device
  const db = controlDb([['kv/plan', { value: CLUB_PLAN }], ['log/p1', { id: 'p1', date: '2026-10-20' }]]);
  const store = dbBackend(db);
  const r = await replayJournal(store, s.journal, base, { defaults: ['plan'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.dropped, ['plan']);
  const plan = db.docs.get('kv/plan').value;
  assert.equal(plan.name, 'Renamed while connecting');
  assert.deepEqual(plan.phases, CLUB_PLAN.phases); // the default's empty phases did not replace the saved ones
  assert.deepEqual(plan.meets, CLUB_PLAN.meets);
  assert.equal(db.docs.get('kv/prefs').value.minutes, 45);
  assert.equal(db.docs.get('blocks/new').name, 'Block typed while connecting');
  assert.equal(db.docs.has('log/p1'), false);
  // Running it again changes nothing.
  const writes = db.calls.set;
  await replayJournal(store, s.journal, base, { defaults: ['plan'] });
  assert.deepEqual(db.docs.get('kv/plan').value, plan);
  assert.equal(db.calls.set - writes, 2); // only the records are put again (the block and the practice), the keys are already merged
  delete globalThis.localStorage;
});

test('replaying waits for a database that can be read', async () => {
  const db = controlDb([['kv/plan', { value: CLUB_PLAN }]]);
  db.fail.read = 'revoked';
  await assert.rejects(replayJournal(dbBackend(db), [['set', 'plan', { name: 'Edited' }]], { plan: { name: 'Season' } }));
  assert.equal(db.docs.get('kv/plan').value.name, 'Club plan');
});
