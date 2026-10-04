// Google Sheet sync: the queue on the device, and the Apps Script itself
// (run against a stand-in for the Sheets service).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS_SCRIPT, SheetSync, validScriptUrl } from '../src/sheets.js';
import { RACE_COLUMNS } from '../src/finish.js';

const URL = 'https://script.google.com/macros/s/AKfycbx_abc-123/exec';

function memory(init = {}) {
  const data = { ...init };
  return { data, read: (k, f) => (k in data ? structuredClone(data[k]) : f), write: (k, v) => { data[k] = structuredClone(v); return true; } };
}

// A tiny fake of the Sheets bits the script uses.
function fakeSheets() {
  const sheets = {};
  const makeSheet = () => {
    const rows = [];
    return {
      rows,
      getLastRow: () => rows.length,
      deleteRow: (r) => rows.splice(r - 1, 1),
      appendRow: (r) => rows.push(r),
      setFrozenRows() {},
      getRange: (r, c, nr, nc) => ({
        setFontWeight() {},
        getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setValues: (vals) => vals.forEach((v, i) => { rows[r - 1 + i] = v; }),
      }),
    };
  };
  const ss = {
    getName: () => 'Swim times',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet()),
  };
  const env = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ setMimeType: () => ({ text }) }) },
  };
  const script = new Function(...Object.keys(env), `${APPS_SCRIPT}; return { doPost, doGet };`)(...Object.values(env));
  return { sheets, script };
}

// fetch → the script, as Apps Script would run it.
function scriptFetch(script, calls = []) {
  return async (url, opts = {}) => {
    calls.push(opts);
    const out = opts.method === 'POST' ? script.doPost({ postData: { contents: opts.body } }) : script.doGet();
    return { ok: true, status: 200, json: async () => JSON.parse(out.text) };
  };
}

const row = (id, extra = {}) => ({ id, date: '2026-10-04', timeOfDay: '09:05', event: '', heat: 1, lane: 3, swimmer: 'Sam', distance: '25 m', stroke: 'Freestyle', time: '1:02.35', seconds: 62.35, method: 'camera', ...extra });

test('validScriptUrl', () => {
  assert.ok(validScriptUrl(URL));
  assert.ok(!validScriptUrl('https://docs.google.com/spreadsheets/d/xyz/edit'));
  assert.ok(!validScriptUrl('http://script.google.com/macros/s/abc/exec'));
});

test('the script writes a header once, appends rows, updates and deletes by id', async () => {
  const { sheets, script } = fakeSheets();
  const storage = memory({ 'pool-tracker-sheet': { url: URL, tab: 'Times' } });
  const sync = new SheetSync({ storage, fetchImpl: scriptFetch(script), online: () => true });
  assert.equal((await sync.test(URL)).ok, true);
  let st = await sync.add([row('a'), row('b', { swimmer: 'Alex' }), row('c')]);
  assert.equal(st.state, 'sent');
  assert.equal(st.added, 3);
  assert.deepEqual(sync.pending, []);
  const t = sheets.Times.rows;
  const col = (k) => RACE_COLUMNS.findIndex(([key]) => key === k);
  assert.deepEqual(t[0], RACE_COLUMNS.map(([, h]) => h));
  assert.equal(t.length, 4);
  assert.equal(t[2][col('swimmer')], 'Alex');
  assert.equal(t[1][col('time')], "'1:02.35");
  // Resending (say the first answer got lost) adds nothing twice; a
  // corrected time replaces the row; a cleared one is removed.
  st = await sync.add([row('a'), row('b', { swimmer: 'Alex', time: '59.90' }), { id: 'c', deleted: true }, row('d')]);
  assert.equal(st.added, 1);
  assert.deepEqual(t.map((r) => r[col('id')]), ['ID', 'a', 'b', 'd']);
  assert.equal(t[2][col('time')], "'59.90");
});

test('rows wait on the device while offline or unconnected, then go', async () => {
  const { sheets, script } = fakeSheets();
  const storage = memory();
  let online = false;
  const sync = new SheetSync({ storage, fetchImpl: scriptFetch(script), online: () => online });
  let st = await sync.add([row('a')]);
  assert.equal(st.state, 'queued');
  sync.config = { url: URL };
  st = await sync.add([row('b')]);
  assert.equal(st.state, 'queued');
  assert.equal(sync.pending.length, 2);
  online = true;
  sync.add([row('a', { time: '30.00' })]); // a correction while queued replaces the queued row
  st = await sync.flush();
  assert.equal(st.state, 'sent');
  assert.equal(sheets.Times.rows.length, 3);
  assert.equal(sheets.Times.rows[2][RACE_COLUMNS.findIndex(([k]) => k === 'time')], "'30.00");
  assert.deepEqual(sync.pending, []);
});

test('network failure keeps rows queued; a script error is reported', async () => {
  const storage = memory({ 'pool-tracker-sheet': { url: URL } });
  let mode = 'down';
  const fetchImpl = async (url, opts) => {
    if (mode === 'down') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ ok: false, error: 'Exception: no permission' }) };
  };
  const sync = new SheetSync({ storage, fetchImpl, online: () => true });
  // Both the normal and the no-cors attempt fail: still queued.
  let st = await sync.add([row('a')]);
  assert.equal(st.state, 'queued');
  assert.equal(sync.pending.length, 1);
  mode = 'error';
  st = await sync.flush();
  assert.equal(st.state, 'error');
  assert.match(st.reason, /no permission/);
  assert.equal(sync.pending.length, 1);
});

test('when the answer cannot be read, a no-cors send still counts (unconfirmed)', async () => {
  const storage = memory({ 'pool-tracker-sheet': { url: URL } });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(opts.mode || 'cors');
    if (opts.mode !== 'no-cors') throw new TypeError('CORS');
    return { ok: false, status: 0, type: 'opaque' };
  };
  const sync = new SheetSync({ storage, fetchImpl, online: () => true });
  const st = await sync.add([row('a')]);
  assert.deepEqual(calls, ['cors', 'no-cors']);
  assert.equal(st.state, 'sent');
  assert.equal(st.confirmed, false);
  assert.deepEqual(sync.pending, []);
});
