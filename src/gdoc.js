// Practices written into a Google Doc the way the coach writes them now:
// one doc per week, day names in bold ("Tuesday", "Tuesday PM"), a bold
// heading per block ("WU - 25 min"), set lines with the send-offs pushed
// right by tabs, rounds and REST lines in bold, group adjustments and cues
// in italics, and a tiny blank line between blocks.
//
// Pure: builds paragraphs and the Google Docs batchUpdate requests that
// append them; src/pw/gdocs.js makes the connector calls.

import { isAdjustment, parseLine, parseSet, splitCols } from './setlang.js';

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SPACER_PT = 5;

// "Tuesday" for an AM session, "Tuesday PM" for a double.
export const dayHeading = (weekday, slot) => `${WEEKDAY_NAMES[weekday]}${slot === 'PM' ? ' PM' : ''}`;

// "WU - 25 min" unless the name already says its minutes ("40 min IM gears").
export function blockHeading(name, minutes) {
  const n = String(name || '').trim() || 'Set';
  if (/\b\d+\s*min\b/i.test(n) || !minutes) return n;
  return `${n} - ${Math.round(minutes)} min`;
}

// Text width in inches at 11 pt, from approximate Calibri character widths
// (em units), so tabs can land every send-off on the same tab stop.
const EM = {
  ' ': 0.226, '.': 0.252, ',': 0.25, ':': 0.268, ';': 0.268, '-': 0.306, '/': 0.386, '|': 0.46, '[': 0.307, ']': 0.307,
  '(': 0.303, ')': 0.303, '#': 0.498, '+': 0.498, '&': 0.682, '!': 0.326, '?': 0.463, "'": 0.221, '"': 0.401, '→': 0.62,
  a: 0.479, b: 0.525, c: 0.423, d: 0.525, e: 0.498, f: 0.305, g: 0.471, h: 0.525, i: 0.229, j: 0.239, k: 0.455, l: 0.229, m: 0.799,
  n: 0.525, o: 0.527, p: 0.525, q: 0.525, r: 0.349, s: 0.391, t: 0.335, u: 0.525, v: 0.452, w: 0.715, x: 0.433, y: 0.453, z: 0.395,
  A: 0.579, B: 0.544, C: 0.533, D: 0.615, E: 0.488, F: 0.459, G: 0.631, H: 0.623, I: 0.252, J: 0.319, K: 0.52, L: 0.42, M: 0.855,
  N: 0.646, O: 0.662, P: 0.517, Q: 0.673, R: 0.543, S: 0.459, T: 0.487, U: 0.653, V: 0.567, W: 0.89, X: 0.519, Y: 0.487, Z: 0.468,
};
function textWidth(text, pt = 11) {
  let em = 0;
  for (const c of String(text)) em += EM[c] ?? (/[0-9]/.test(c) ? 0.507 : 0.5);
  return em * pt / 72;
}

// Default tab stops sit every half inch. Tabs from the end of `text` to the
// stop at `column` inches (at least one).
function tabsFor(text, column = 4.5) {
  // Widths match a rendered doc to about ±0.03 in (checked on a test doc).
  const x = textWidth(text);
  const n = Math.round(column / 0.5) - Math.floor(x / 0.5);
  return '\t'.repeat(Math.max(1, n));
}

// The column for a session: as far right as the widest send-off allows on a
// 6.5 in line, between 3 and 4.5 in.
function sendOffColumn(lines, lineWidth = 6.5) {
  let widest = 0;
  for (const raw of lines) {
    const { cols } = splitCols(raw);
    if (cols) widest = Math.max(widest, textWidth(cols));
  }
  return Math.max(3, Math.min(4.5, Math.floor((lineWidth - widest - 0.1) / 0.5) * 0.5));
}

// One set line → a paragraph with its style, in the coach's layout.
// `typed` is the line as parseSet read it in its block (only a block's first
// line can be a "36 min …" heading); `groups` lets adjustment lines keyed by
// a group's name or column key ("L4 - …") read as adjustments.
export function lineParagraph(raw, column = 4.5, typed = null, groups = []) {
  const text = String(raw ?? '').replace(/\s+$/, '');
  if (!text.trim()) return { text: '', spacer: true };
  const l = typed || parseLine(text);
  // Send-offs pushed right to the column (setlang reads them, tenths too).
  const aligned = () => {
    const { left, cols } = splitCols(text);
    return cols && left ? `${left}${tabsFor(left, column)}${cols}` : null;
  };
  if (l.type === 'swim') {
    const t = l.intervals.length ? aligned() : null;
    return { text: t || text.trim(), boldWords: oddsEvens(t || text.trim()) };
  }
  if (l.type === 'rounds' || l.type === 'rest' || l.type === 'heading') return { text: text.trim(), bold: true };
  if (l.type === 'ref') return { text: aligned() || text.trim(), italic: true };
  if (l.type === 'adjust' || isAdjustment(text, groups)) return { text: text.trim(), italic: true, boldWords: oddsEvens(text.trim()) };
  if (l.type === 'note') return { text: text.trim(), italic: !/^#\d/.test(text.trim()), boldWords: oddsEvens(text.trim()) };
  if (/^RD\d+\b.*:$/.test(text.trim())) return { text: text.trim(), bold: true };
  return { text: text.trim(), boldWords: oddsEvens(text.trim()) };
}

// The words "odds" / "evens" are bold in the coach's lines ("odd -" and
// "even:" too, but not "even pace").
function oddsEvens(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(?:odds|evens)\b|\b(?:odd|even)(?=\s*[-:])/gi)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// A section's lines without blank lines at either end.
function trimBlank(lines) {
  const blank = (l) => typeof l === 'string' && !l.trim();
  let a = 0;
  let b = lines.length;
  while (a < b && blank(lines[a])) a++;
  while (b > a && blank(lines[b - 1])) b--;
  return lines.slice(a, b);
}

// A description (one italic paragraph per line of it).
const noteParagraphs = (text) => String(text || '').split('\n').map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, italic: true }));

// A session → paragraphs. sections: [{ title, minutes, lines, note }], where
// a line is a set line (string) or { note } (a block's description inside a
// circuit), and `note` is the block's description under its heading.
export function sessionParagraphs({ weekday, slot, note = '', sections = [], groups = [] }) {
  const column = sendOffColumn(sections.flatMap((s) => (s.lines || []).filter((l) => typeof l === 'string')));
  const out = [{ text: dayHeading(weekday, slot), bold: true }];
  out.push(...noteParagraphs(note));
  out.push({ text: '', spacer: true });
  sections.forEach((s, i) => {
    out.push({ text: blockHeading(s.title, s.minutes), bold: true });
    out.push(...noteParagraphs(s.note));
    const lines = trimBlank(s.lines || []);
    const sets = lines.filter((l) => typeof l === 'string');
    const typed = parseSet(sets.join('\n')).lines;
    let k = 0;
    lines.forEach((raw) => {
      if (typeof raw !== 'string') { out.push(...noteParagraphs(raw?.note)); return; }
      out.push(lineParagraph(raw, column, typed.length === sets.length ? typed[k] : null, groups));
      k += 1;
    });
    if (i < sections.length - 1) out.push({ text: '', spacer: true });
  });
  out.push({ text: '' });
  // Collapse runs of blank paragraphs to the last one, so the session always
  // ends on its plain blank line.
  return out.filter((p, i, a) => !(p.text === '' && a[i + 1]?.text === ''));
}

// Where to append in a documents.get result: the first tab's body (or the
// top-level body), its end index, its font, whether it is empty and whether
// its last paragraph is blank. An image, chip or rule counts as content.
export function docEnd(doc) {
  const d = doc?.content?.documentId ? doc.content : doc;
  const tab = d?.tabs?.[0];
  const body = tab?.documentTab?.body || d?.body;
  const content = body?.content || [];
  const last = content[content.length - 1];
  const endIndex = last?.endIndex || 2;
  const filled = (el) => (el.paragraph?.elements || []).some((e) => !e.textRun || e.textRun.content.trim());
  const paras = content.filter((el) => el.paragraph);
  let font = null;
  for (let i = content.length - 1; i >= 0 && !font; i--) {
    for (const e of content[i].paragraph?.elements || []) {
      const f = e.textRun?.textStyle?.weightedFontFamily?.fontFamily;
      if (f) { font = f; break; }
    }
  }
  return {
    documentId: d?.documentId || null,
    revisionId: d?.revisionId || null,
    tabId: tab?.tabProperties?.tabId || null,
    title: d?.title || '',
    endIndex,
    empty: !content.some((el) => el.table || el.tableOfContents || filled(el)),
    lastBlank: !!paras.length && !filled(paras[paras.length - 1]),
    font,
  };
}

// The update_doc arguments that append paragraphs at the end of the doc,
// guarded by the revision the read returned. Indexes are UTF-16 units,
// which is what JavaScript string lengths count.
//
// The text goes in before the doc's final newline: a leading newline ends
// the doc's last paragraph (and a second one leaves a blank line after it
// when it has text), so that paragraph keeps its own style. Everything from
// there to the end, the final newline included (Docs accepts that range),
// is reset to plain Normal text in Calibri 11, the font the tab widths are
// measured for (the coach's docs are Calibri): no inherited bullets,
// indents, alignment, links or colours.
export function appendRequests(doc, paragraphs, { font = 'Calibri' } = {}) {
  const end = docEnd(doc);
  const at = Math.max(1, end.endIndex - 1);
  const lead = end.empty ? '' : end.lastBlank ? '\n' : '\n\n';
  const texts = paragraphs.map((p) => p.text);
  const body = lead + texts.join('\n');
  const loc = (o) => (end.tabId ? { ...o, tabId: end.tabId } : o);
  const requests = [{ insertText: { location: loc({ index: at }), text: body } }];
  const start = at + (lead ? 1 : 0);
  const stop = at + body.length + 1; // through the final newline
  const range = loc({ startIndex: start, endIndex: stop });
  requests.push({ deleteParagraphBullets: { range } });
  requests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: '*' } });
  requests.push({ updateTextStyle: { range, textStyle: { bold: false, italic: false, weightedFontFamily: { fontFamily: font || 'Calibri' }, fontSize: { magnitude: 11, unit: 'PT' } }, fields: '*' } });
  let i = at + lead.length;
  for (const p of paragraphs) {
    const a = i;
    const b = i + p.text.length;
    if (p.spacer) requests.push({ updateTextStyle: { range: loc({ startIndex: a, endIndex: b + 1 }), textStyle: { fontSize: { magnitude: SPACER_PT, unit: 'PT' } }, fields: 'fontSize' } });
    if (b > a && (p.bold || p.italic)) {
      requests.push({ updateTextStyle: { range: loc({ startIndex: a, endIndex: b }), textStyle: { ...(p.bold ? { bold: true } : {}), ...(p.italic ? { italic: true } : {}) }, fields: [p.bold && 'bold', p.italic && 'italic'].filter(Boolean).join(',') } });
    }
    for (const [x, y] of p.boldWords || []) requests.push({ updateTextStyle: { range: loc({ startIndex: a + x, endIndex: a + y }), textStyle: { bold: true }, fields: 'bold' } });
    i = b + 1;
  }
  return { documentId: end.documentId, requests, writeControl: { requiredRevisionId: end.revisionId } };
}

// "Week 3 B2" from the phase ("B2 · threshold") and the week in it. Phases
// in a row with the same short name count on ("B2 · threshold" for 2 weeks,
// then "B2 · race pace" week 1 is Week 3 B2) when the plan's phases and
// the phase's index are given.
const shortName = (phase) => String(phase?.name || 'Week').split(/\s*[·(]\s*/)[0].trim();
export function weekDocTitle(phase, phaseWeek, phases = null, phaseIndex = null) {
  const short = shortName(phase);
  let week = (phaseWeek ?? 0) + 1;
  if (phases && phaseIndex != null) {
    for (let i = phaseIndex - 1; i >= 0 && shortName(phases[i]) === short; i--) week += phases[i].weeks || 0;
  }
  return `Week ${week} ${short}`.trim();
}

// A Google Docs link (also /u/1/ and /a/<domain>/ ones), a Drive file or
// open?id= link, or a bare id → the id. Whether it is a doc is checked
// when it is linked.
export function docIdFrom(text) {
  const t = String(text || '').trim();
  const m = /\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(t)
    || /drive\.google\.com\/(?:.*\/)?(?:file\/d\/|open\?(?:.*&)?id=)([A-Za-z0-9_-]{20,})/.exec(t)
    || /^([A-Za-z0-9_-]{20,})$/.exec(t);
  return m ? m[1] : null;
}
