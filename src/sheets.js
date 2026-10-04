// Sends finished times to a Google Sheet, through a small Apps Script the
// coach adds to their own sheet: no Google sign-in in this app and no API
// keys, just the script's web-app URL. Rows wait in a queue on the device
// until the sheet takes them, so times taken with no signal on deck go up
// later. Every row carries an id: the script updates the row it already has
// with that id (a corrected time) or deletes it (a cleared one), so sending
// again is always safe.

import { RACE_COLUMNS } from './finish.js';
import { read, write } from './store.js';

const CONFIG_KEY = 'pool-tracker-sheet';
const QUEUE_KEY = 'pool-tracker-sheet-queue';

export const validScriptUrl = (url) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(url).trim());

class SheetError extends Error {}

export class SheetSync {
  constructor({ storage = { read, write }, fetchImpl = (...a) => fetch(...a), online = () => navigator.onLine } = {}) {
    this.storage = storage;
    this.fetch = fetchImpl;
    this.online = online;
    this.busy = null;
    this.status = { state: 'idle' }; // idle | sending | sent | queued | error
    this.onChange = null;
  }

  get config() {
    return { url: '', tab: 'Times', ...this.storage.read(CONFIG_KEY, {}) };
  }

  set config(c) {
    this.storage.write(CONFIG_KEY, { url: String(c.url || '').trim(), tab: String(c.tab || '').trim() || 'Times' });
  }

  get connected() { return validScriptUrl(this.config.url); }
  get pending() { return this.storage.read(QUEUE_KEY, []); }

  setStatus(s) {
    this.status = s;
    this.onChange?.(s);
    return s;
  }

  // Queue rows (see raceRows; { id, deleted: true } removes one) and try to
  // send them. A newer version of a queued row replaces it.
  add(rows) {
    if (!rows.length) return Promise.resolve(this.status);
    const ids = new Set(rows.map((r) => r.id));
    this.storage.write(QUEUE_KEY, [...this.pending.filter((r) => !ids.has(r.id)), ...rows]);
    return this.flush();
  }

  // Send whatever is queued. Safe to call any time (on start-up, when the
  // signal comes back); calls while a send is going share it.
  flush() {
    if (!this.busy) this.busy = this.send().finally(() => { this.busy = null; });
    return this.busy;
  }

  async send() {
    const rows = this.pending;
    if (!rows.length) return this.status;
    if (!this.connected) return this.setStatus({ state: 'queued', count: rows.length, reason: 'No sheet connected yet.' });
    if (!this.online()) return this.setStatus({ state: 'queued', count: rows.length, reason: 'Offline — will send when back online.' });
    this.setStatus({ state: 'sending', count: rows.length });
    const { url, tab } = this.config;
    try {
      const { confirmed, added } = await this.post(url, { tab, columns: RACE_COLUMNS, rows });
      // Only drop what was sent: more may have been queued meanwhile
      // (including a newer version of a row just sent).
      const sent = new Set(rows.map((r) => JSON.stringify(r)));
      this.storage.write(QUEUE_KEY, this.pending.filter((r) => !sent.has(JSON.stringify(r))));
      this.setStatus({ state: 'sent', count: rows.length, added, confirmed, at: Date.now() });
    } catch (e) {
      this.setStatus(e instanceof SheetError
        ? { state: 'error', count: rows.length, reason: e.message }
        : { state: 'queued', count: rows.length, reason: 'Could not reach the sheet — will try again.' });
    }
    return this.status;
  }

  async post(url, payload) {
    // A plain-text body keeps this a "simple" request, which Apps Script
    // accepts from another site without a CORS preflight.
    const body = JSON.stringify(payload);
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', body, redirect: 'follow' });
    } catch (e) {
      // Blocked from reading the answer (or offline). A no-cors request still
      // reaches the script; we just can't see what it said.
      if (!this.online()) throw e;
      await this.fetch(url, { method: 'POST', body, mode: 'no-cors' });
      return { confirmed: false, added: null };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new SheetError(`The sheet didn't answer properly (${res.status}). Check the web-app URL and that access is set to "Anyone".`);
    if (!data.ok) throw new SheetError(`The sheet said: ${data.error || 'error'}`);
    return { confirmed: true, added: data.added };
  }

  // Check a URL before saving it.
  async test(url) {
    if (!validScriptUrl(url)) return { ok: false, message: 'That doesn\'t look like an Apps Script web-app URL (https://script.google.com/macros/s/…/exec).' };
    try {
      const res = await this.fetch(url.trim(), { redirect: 'follow' });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.app === 'pool-tracker') return { ok: true, message: `Connected to “${data.sheet || 'your sheet'}”.` };
      return { ok: false, message: 'Something answered, but not the Pool Tracker script. Check you pasted the script and deployed it as a web app.' };
    } catch {
      return { ok: false, message: 'Could not reach it. Check the URL, that you\'re online, and that "Who has access" is "Anyone".' };
    }
  }
}

// The script the coach pastes into their sheet (Extensions → Apps Script).
export const APPS_SCRIPT = `// Pool Tracker → Google Sheets
// 1. Paste this in Extensions → Apps Script (replace what's there) and Save.
// 2. Deploy → New deployment → type "Web app".
//    Execute as: Me.  Who has access: Anyone.  Deploy, and allow access.
// 3. Copy the web-app URL (ends in /exec) into Pool Tracker.

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    var columns = body.columns;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(body.tab) || ss.insertSheet(body.tab);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(columns.map(function (c) { return c[1]; }));
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold');
    }
    // Rows are matched on the ID column: a row sent again replaces the one
    // already there (a corrected time), one marked deleted is removed, so
    // resending is always safe.
    var idCol = columns.length;
    var where = {};
    var n = sheet.getLastRow() - 1;
    if (n > 0) sheet.getRange(2, idCol, n, 1).getValues().forEach(function (r, i) { where[r[0]] = i + 2; });
    var added = 0, gone = [];
    body.rows.forEach(function (r) {
      var at = where[r.id];
      if (r.deleted) { if (at) { gone.push(at); delete where[r.id]; } return; }
      var values = [columns.map(function (c) {
        var v = r[c[0]];
        // Keep times like 1:02.35 as written, not turned into a clock time.
        return c[0] === 'time' ? "'" + v : v;
      })];
      if (!at) { at = sheet.getLastRow() + 1; where[r.id] = at; added++; }
      sheet.getRange(at, 1, 1, columns.length).setValues(values);
    });
    gone.sort(function (a, b) { return b - a; }).forEach(function (row) { sheet.deleteRow(row); });
    return reply({ ok: true, added: added, removed: gone.length });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return reply({ ok: true, app: 'pool-tracker', sheet: SpreadsheetApp.getActiveSpreadsheet().getName() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
