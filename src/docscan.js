// Reading a week's Google Doc back into the app: the days and sessions the
// coach has already written, their blocks and set lines, matched to the
// library. Pure (a documents.get result in, plain objects out); the Week
// card makes the connector call and asks the coach before saving.
//
// The layout it reads is the one coaches write (and src/gdoc.js writes):
//   Tuesday PM                       bold day heading (" PM" for a double)
//   Easy start, then power.          a note for the day (optional)
//   WU - 25 min, everyone            bold (often underlined) block heading
//   400 easy          5:00 | 5:15    set lines, send-offs pushed right by tabs
//   3 rounds:                        bold lines inside a block (rounds, REST,
//   :30 REST                         "1) …" stations) stay in the block
// A day written without block headings becomes one block.

import { WEEKDAYS, addDays } from './practice.js';
import { parseLine, quickBlock } from './setlang.js';

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_RE = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[\s,.-]*(am|pm)?\b[\s\d/.,a-z-]{0,16}$/i;

// The doc's paragraphs: text (tabs kept), bold (every word), underlined (any).
export function docParagraphs(doc) {
  const d = doc?.content?.documentId ? doc.content : doc;
  const content = (d?.tabs?.[0]?.documentTab?.body || d?.body)?.content || [];
  return content.filter((el) => el.paragraph).map((el) => {
    const runs = (el.paragraph.elements || []).map((e) => e.textRun).filter(Boolean);
    const text = runs.map((r) => r.content).join('').replace(/\n$/, '');
    const words = runs.filter((r) => r.content.trim());
    return {
      text,
      bold: words.length > 0 && words.every((r) => r.textStyle?.bold),
      underline: words.some((r) => r.textStyle?.underline),
    };
  });
}

// A day heading → { weekday (0 = Monday), slot } or null.
export function dayOf(text) {
  const t = String(text || '').trim();
  const m = DAY_RE.exec(t);
  if (!m) return null;
  // "Monday 6 x 50…" is a set line, not a heading: only short tails.
  if (/\d\s*x\s*\d/i.test(t)) return null;
  const pm = (m[2] || '').toLowerCase() === 'pm' || /\bpm\b/i.test(t);
  return { weekday: DAY_NAMES.indexOf(m[1].toLowerCase()), slot: pm ? 'PM' : 'AM' };
}

// Bold lines that belong inside a block: rounds, REST, RDn, stations.
const STRUCTURE = /^(\d+\s*(rounds?|x)\b|rd\s*\d|\d+\)|[a-z]\)\s|:\d\d\s*rest\b|\d+:\d\d\s*rest\b|rest\b)/i;

// "WU - 25 min, everyone" → { name: 'WU', minutes: 25, extra: 'everyone' };
// "36 min IM builds" → { name: '36 min IM builds', minutes: 36 }.
export function headingOf(text) {
  const t = String(text || '').replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim().replace(/:$/, '');
  let m = /^(.*?)\s+[-–]\s+(\d+(?:\.\d+)?)\s*min\b[\s,.:;-]*(.*)$/i.exec(t);
  if (m && m[1].trim()) return { name: m[1].trim(), minutes: Math.round(+m[2]), extra: m[3].trim() };
  m = /^(\d+(?:\.\d+)?)\s*min\b/i.exec(t);
  if (m) return { name: t, minutes: Math.round(+m[1]), extra: '' };
  return { name: t, minutes: null, extra: '' };
}

// Whether a paragraph starts a block.
function isHeading(p) {
  if (!p.bold) return false;
  const t = p.text.replace(/\t+/g, ' ').trim();
  if (!t || STRUCTURE.test(t)) return false;
  const type = parseLine(t).type;
  if (type === 'rounds' || type === 'rest' || type === 'swim') return false;
  return p.underline || /\b\d+\s*min\b/i.test(t) || !/:$/.test(t);
}

// A set line as the app reads it: tab runs become column gaps.
const setLine = (text) => text.replace(/\s*\t[\t ]*/g, '   ').replace(/\s+$/, '').replace(/^\s+/, (s) => (s.includes('\t') ? '' : s));

// The sessions written in a week's doc, in the order written. A day+slot
// written twice (pasted again) is kept once: the first copy, with
// `copies` saying how many there were.
export function docSessions(doc, monday) {
  const out = [];
  let session = null;
  let block = null;
  const startBlock = (head, text = '') => {
    block = { name: head.name, minutes: head.minutes, extra: head.extra, head: text, lines: [] };
    session.blocks.push(block);
  };
  for (const p of docParagraphs(doc)) {
    const day = p.bold || p.text.trim().length <= 24 ? dayOf(p.text) : null;
    if (day) {
      session = { ...day, date: addDays(monday, day.weekday), note: [], blocks: [] };
      block = null;
      out.push(session);
      continue;
    }
    if (!session || !p.text.trim()) continue;
    if (isHeading(p)) { startBlock(headingOf(p.text), setLine(p.text).trim()); continue; }
    if (!block && !session.blocks.length && !p.bold && !parseLine(setLine(p.text)).intervals?.length && parseLine(setLine(p.text)).type !== 'swim') {
      session.note.push(p.text.trim());
      continue;
    }
    if (!block) startBlock({ name: `${WEEKDAYS[session.weekday]}${session.slot === 'PM' ? ' PM' : ''} practice`, minutes: null, extra: '' });
    block.lines.push(setLine(p.text));
  }
  const seen = new Map();
  const sessions = [];
  for (const s of out) {
    const key = `${s.date}|${s.slot}`;
    const done = { ...s, note: s.note.join(' '), blocks: s.blocks.filter((b) => b.lines.length || b.minutes) };
    if (seen.has(key)) { seen.get(key).copies += 1; continue; }
    done.copies = 1;
    seen.set(key, done);
    if (done.blocks.length) sessions.push(done);
  }
  return sessions;
}

// A session's blocks with some joined to the one above (`joined`: the
// indexes to join), for a heading the scan took for a new block by mistake.
// A joined block's heading stays in the lines, as the doc has it; minutes
// add up when both parts have them, else the first's stay. Each block
// lists its `parts` (indexes).
export function joinBlocks(blocks, joined = new Set()) {
  const out = [];
  blocks.forEach((b, i) => {
    const into = i > 0 && joined.has(i) ? out.at(-1) : null;
    if (!into) { out.push({ ...b, lines: [...b.lines], parts: [i] }); return; }
    into.lines.push(...(b.head ? [b.head] : []), ...b.lines);
    into.minutes = into.minutes && b.minutes ? into.minutes + b.minutes : into.minutes || null;
    into.extra = [into.extra, b.extra].filter(Boolean).join(', ');
    into.parts.push(i);
  });
  return out;
}

// A name as compared across the doc and the library: no "N min", case,
// punctuation or extra spaces.
export const nameKey = (name) => String(name || '').toLowerCase()
  .replace(/\b\d+(\.\d+)?\s*min\b/g, ' ').replace(/[^a-z0-9/+&]+/g, ' ').trim();
const linesKey = (lines) => (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean).join('\n');

// The library block a scanned block is: the same set lines, else the same
// name (with the same minutes when several share it). null when new.
export function matchBlock(b, library) {
  const lines = linesKey(b.lines);
  if (lines) {
    const same = library.find((x) => linesKey(x.lines) === lines);
    if (same) return same;
  }
  const key = nameKey(b.name);
  if (!key) return null;
  const named = library.filter((x) => nameKey(x.name) === key);
  return named.find((x) => b.minutes && x.minutes === b.minutes) || named[0] || null;
}

// A new library block from a scanned one: category, stroke, gears and kit
// read from its lines, its name and minutes as written.
export function blockFromDoc(b, ctx = null) {
  const guess = quickBlock([b.minutes ? `${b.minutes} min ${b.name}` : b.name, ...b.lines].join('\n'), ctx);
  return { ...guess, name: b.name, minutes: b.minutes || guess.minutes || null, distance: b.minutes ? null : guess.distance, lines: b.lines, detail: b.extra || '', source: 'drive' };
}

// What scanning would do, for the coach to look over: each session found
// with its blocks (matched to the library, or new), and whether the app
// already has a practice for that day and slot.
export function scanPlan(sessions, { library = [], log = [] } = {}) {
  return sessions.map((s) => ({
    ...s,
    existing: log.find((r) => r.date === s.date && (r.slot || 'AM') === s.slot) || null,
    blocks: s.blocks.map((b) => ({ ...b, match: matchBlock(b, library) })),
  }));
}
