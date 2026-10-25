// The coach's set notation: read it, time it per group, write it back.
// (The example below is made up.)
//
//   36 min FL/free switch                       ← block heading (minutes + focus)
//   400 IM group       4:15 | 4:25 | 4:35 | 4:45   ← reference row (one value per group)
//   3 x 300 free       3:35 | 3:50 | 4:05 | 4:20 ← reps x distance, send-off per group
//   #2 G2.5, breathe every 5th                  ← note for one rep
//   :15 REST                                    ← fixed rest
//   3 rounds:                                   ← the following lines repeat
//   6 x 50 FL, G2 → G5 by 25      :53 | :56 | :59 | 1:02
//   150 easy, any stroke      3:00              ← one interval = every group
//   4:35 - 4 x 50 FL in RD2 + RD3               ← group adjustment, keyed by column
//
// Pure functions, no DOM. Times are seconds.

import {
  DEFAULT_GEAR_MODEL, cnsPoints, fmtClock, gearIndex, gearPaces, imPaces, makeGearModel, paceOf, parseClock, roundSendOff, sendOff, strokeOffset, testForGearPace,
} from './gears.js';

const CLOCK = String.raw`(?:\d{1,2}:\d{2}(?:\.\d)?|:\d{2})`;
// Send-off columns at the end of a line, after a space or an "@" ("@1:20").
const COLS_RE = new RegExp(String.raw`(?:^|\s|(?<=@))(${CLOCK}(?:\s*\|\s*${CLOCK})*)\s*$`);
const STROKE_WORDS = [
  [/\b(IMO|IM)\b/, 'IM'], [/\b(FL|fly|butterfly)\b/i, 'fly'], [/\b(BK|back|backstroke)\b/i, 'back'],
  [/\b(BR|breast|breaststroke)\b/i, 'breast'], [/\b(FR|free|freestyle)\b/i, 'free'], [/\b(choice|YC|CH)\b/i, 'choice'],
];
const EQUIPMENT_WORDS = [
  [/\bfins?\b/i, 'fins'], [/\b(paddles?|PADs?)\b/i, 'paddles'], [/\bsnorkel\b/i, 'snorkel'], [/\bsocks?\b/i, 'socks'],
  [/\b(buoy|bouy)\b/i, 'buoy'], [/\b(parachute|chute)\b/i, 'parachute'], [/\bboard\b/i, 'board'], [/\btempo trainer\b/i, 'tempo trainer'],
];

// ------------------------------------------------------------------ parse

// One line of a set → a typed object (always has `type` and `raw`).
export function parseLine(raw) {
  const text = String(raw ?? '').replace(/\t/g, '    ').replace(/[–—]/g, '-').replace(/->/g, '→').trim();
  if (!text) return { type: 'blank', raw };

  // "2 min rest" is a rest line, never a block heading.
  let m = /^(\d+)\s*min(?:ute)?s?\.?\s+rest\b\.?\s*(.*)$/i.exec(text);
  if (m) return { type: 'rest', raw, seconds: +m[1] * 60, note: m[2].replace(/^[,\s]+/, '').trim() };

  m = /^(\d+)\s*min(?:utes)?\b\.?\s*(.*)$/i.exec(text);
  if (m && !/\bx\b/.test(m[2])) return { type: 'heading', raw, minutes: +m[1], title: m[2].trim() };

  m = /^(\d+)\s*rounds?\s*:?\s*$/i.exec(text) || /^(\d+)\s*x\s*:?\s*$/i.exec(text);
  if (m) return { type: 'rounds', raw, rounds: +m[1] };

  m = new RegExp(String.raw`^(${CLOCK})\s*rest\b\.?\s*(.*)$`, 'i').exec(text);
  if (m) return { type: 'rest', raw, seconds: parseClock(m[1]), note: m[2].trim() };

  m = new RegExp(String.raw`^(${CLOCK}|\d+(?:st|nd|rd|th)\s+interval)\s*-\s+(.+)$`, 'i').exec(text);
  if (m) return { type: 'adjust', raw, key: m[1], text: m[2].trim() };

  if (/^#\d/.test(text) || /^(odds?|evens?)\s*:/i.test(text) || /^G\d(\.\d)?\s*=/.test(text) || /^(add up|choice\s*=|swim time)/i.test(text)) {
    return { type: 'note', raw, text };
  }

  const cols = COLS_RE.exec(text);
  const intervals = cols ? cols[1].split('|').map((s) => parseClock(s.trim())) : [];
  let body = cols ? text.slice(0, cols.index).trim() : text;
  const at = /\s@\s*$/.test(body) || /@\s*$/.test(body);
  body = body.replace(/\s*@\s*$/, '').trim();

  m = /^(\d+)\s*x\s*(\d+(?:\.\d+)?)\b\s*(.*)$/i.exec(body) || /^()(\d+(?:\.\d+)?)\b(?!\s*(?:min|sec|:))\s*(.*)$/i.exec(body);
  if (m && +m[2] >= 12.5 && +m[2] <= 5000) {
    const reps = m[1] ? +m[1] : 1;
    const distance = +m[2];
    const desc = m[3].replace(/^[,\s]+/, '').trim();
    // Reference rows like "400 IM group 4:15 | 4:25" or "1000 goal 11:40 | …": the
    // whole label is "<distance> [stroke] group|goal|pace", so "200 at 500 pace" is a swim.
    if (intervals.length && !m[1] && /^((IM|free|FR|back|BK|breast|BR|fly|FL|choice)\s+)?(group|goal|pace)\s*(\([^)]*\))?\s*:?$/i.test(desc)) {
      return { type: 'ref', raw, label: `${m[2]} ${desc}`.trim(), values: intervals };
    }
    return { type: 'swim', raw, reps, distance, desc, intervals, at, ...describe(desc) };
  }
  if (intervals.length && /\b(pace|goal|group)\b/i.test(body)) return { type: 'ref', raw, label: body, values: intervals };
  if (/^broken\b/i.test(text)) return { type: 'note', raw, text };
  return { type: 'text', raw, text };
}

// What a swim line's words say: stroke, kind, gears, progressions, pace.
export function describe(desc) {
  const out = { stroke: 'choice', kind: 'swim', gears: [], gearFrom: null, gearTo: null, gearBy: null, pace: null, oddsEvens: null, equipment: [] };
  for (const [re, s] of STROKE_WORDS) if (re.test(desc)) { out.stroke = s; break; }
  if (/\bpull\b/i.test(desc)) out.kind = 'pull';
  else if (/(?<!\bno\s)\bkick\b/i.test(desc)) out.kind = 'kick';
  else if (/\bdrill\b/i.test(desc) && !/\bswim\b/i.test(desc)) out.kind = 'drill';
  // "[50 drill / 50 swim]", "drill/swim": a swim with a drill share that is slower.
  if (out.kind === 'swim' && /\bdrill\b/i.test(desc) && /\bswim\b/i.test(desc)) {
    const ds = /(\d+)\s*drill\s*\/\s*(\d+)\s*swim/i.exec(desc);
    const sd = /(\d+)\s*swim\s*\/\s*(\d+)\s*drill/i.exec(desc);
    out.drillShare = ds ? +ds[1] / (+ds[1] + +ds[2]) : sd ? +sd[2] / (+sd[1] + +sd[2]) : 0.5;
  }
  for (const [re, e] of EQUIPMENT_WORDS) if (re.test(desc) && !out.equipment.includes(e)) out.equipment.push(e);
  if (out.kind === 'pull' && !out.equipment.includes('buoy') && /\bbuoy\b/i.test(desc)) out.equipment.push('buoy');
  out.gears = [...new Set((desc.match(/\bG\d(?:\.\d)?\b/g) || []))];
  const prog = /\b(G\d(?:\.\d)?)\s*→\s*(G\d(?:\.\d)?|[\w ]*?pace)(?:\s+by\s+(\d+))?/i.exec(desc);
  if (prog) { out.gearFrom = prog[1]; out.gearTo = prog[2].trim(); out.gearBy = prog[3] ? +prog[3] : null; }
  const pace = /\b(?:at\s+|hold\s+)?(\d+(?:\s*IM)?\s*(?:pace|RP)|goal\s+\d+\s*pace|race pace)\b/i.exec(desc);
  if (pace) out.pace = pace[1].replace(/\s+/g, ' ');
  const oe = /\bodds?\s*-\s*([^\s].*?)\s+evens?\s*-\s*(.+)$/i.exec(desc);
  if (oe) out.oddsEvens = { odds: oe[1].trim(), evens: oe[2].trim() };
  if (/\bfast\b|\bsprint\b|\ball out\b/i.test(desc) && !out.gears.length) {
    out.gears = ['G6'];
    // "[25 easy / 25 sprint]": half fast, half easy (timed in the middle gear).
    if (/\[[^\]]*\/[^\]]*\]/.test(desc) && /\b(easy|ez|recovery)\b/i.test(desc)) { out.gears = ['G6', 'G1']; out.mix = true; }
  }
  if (/\b(easy|loosen|recovery|ez)\b/i.test(desc) && !out.gears.length) out.easy = true;
  return out;
}

// A block's text → heading, lines (typed) and structure (rounds groups).
// Only the first line can be the block's heading ("36 min FL/free switch"); a
// later "5 min kick w/ fins" is timed work inside the set.
export function parseSet(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(parseLine);
  const first = lines.findIndex((l) => l.type !== 'blank');
  lines.forEach((l, i) => {
    if (l.type === 'heading' && i !== first) lines[i] = { type: 'timed', raw: l.raw, seconds: l.minutes * 60, text: String(l.raw).trim() };
  });
  const headingIndex = first >= 0 && lines[first].type === 'heading' ? first : -1;
  return { heading: headingIndex >= 0 ? lines[headingIndex] : null, headingIndex, lines, structure: structure(lines) };
}

// Group lines into top-level items and round blocks. A "N rounds:" header
// takes the swim / rest / note lines after it until a blank line, a
// group adjustment, another header or the end.
export function structure(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (l.type === 'rounds') { cur = { type: 'rounds', rounds: l.rounds, items: [] }; out.push(cur); continue; }
    if (l.type === 'blank' || l.type === 'adjust' || l.type === 'heading' || l.type === 'ref') { cur = null; if (l.type !== 'blank') out.push(l); continue; }
    (cur ? cur.items : out).push(l);
  }
  return out;
}

// ------------------------------------------------------------------- time

// Send-off for group column g: its own column, a single shared value, or the
// last column when the line has fewer columns than there are groups.
export function intervalFor(line, g) {
  const iv = line.intervals || [];
  if (!iv.length) return null;
  return iv[Math.min(g, iv.length - 1)];
}

// Seconds the set takes for group column g (null intervals count as
// `fallback(line)` seconds, default 0).
export function setSeconds(parsed, g = 0, fallback = () => 0) {
  const itemSeconds = (l) => {
    if (l.type === 'swim') {
      const iv = intervalFor(l, g);
      return l.reps * (iv ?? fallback(l) ?? 0);
    }
    if (l.type === 'rest' || l.type === 'timed') return l.seconds || 0;
    return 0;
  };
  let total = 0;
  for (const it of parsed.structure) {
    if (it.type === 'rounds') total += it.rounds * it.items.reduce((s, l) => s + itemSeconds(l), 0);
    else total += itemSeconds(it);
  }
  return total;
}

// Distance of the whole set (rounds counted).
export function setDistance(parsed) {
  const d = (l) => (l.type === 'swim' ? l.reps * l.distance : 0);
  let total = 0;
  for (const it of parsed.structure) {
    if (it.type === 'rounds') total += it.rounds * it.items.reduce((s, l) => s + d(l), 0);
    else total += d(it);
  }
  return Math.round(total);
}

// Gears a set uses, in order of first appearance (progressions expanded).
export function setGears(parsed) {
  const seen = [];
  const add = (g) => { if (/^G\d(\.\d)?$/.test(g) && !seen.includes(g)) seen.push(g); };
  for (const l of parsed.lines) {
    if (l.type !== 'swim') continue;
    if (l.gearFrom && /^G\d/.test(l.gearTo || '')) gearSpan(l.gearFrom, l.gearTo).forEach(add);
    l.gears.forEach(add);
  }
  return seen;
}

// The gears a progression passes through, both ends included, either way:
// G2.5 → G4 = G2.5, G3, G4; G5 → G3 = G5, G4, G3.
export function gearSpan(from, to) {
  const a = gearIndex(from), b = gearIndex(to);
  if (a == null || b == null) return [from, to].filter((g) => gearIndex(g) != null);
  const out = [from];
  if (b > a) for (let k = Math.floor(a) + 1; k < b; k++) out.push(`G${k}`);
  else for (let k = Math.ceil(a) - 1; k > b; k--) out.push(`G${k}`);
  if (b !== a) out.push(to);
  return out;
}

// ------------------------------------------------------------------ write

// ":46 |  :48 | 1:25" — columns right-aligned to the widest value.
export function formatColumns(values) {
  const txt = values.map((v) => (v == null ? '–' : fmtClock(v)));
  const w = Math.max(...txt.map((t) => t.length));
  return txt.map((t, i) => (i ? t.padStart(w) : t)).join(' | ');
}

// A swim line in the coach's notation, with send-offs for each group.
export function writeSwim(line, intervals = line.intervals) {
  const head = line.reps > 1 ? `${line.reps} x ${fmtDist(line.distance)}` : fmtDist(line.distance);
  const body = [head, line.desc].filter(Boolean).join(' ');
  if (!intervals?.length) return body;
  const same = intervals.every((v) => v === intervals[0]);
  return `${body}    ${same ? fmtClock(intervals[0]) : formatColumns(intervals)}`;
}

const fmtDist = (d) => (Number.isInteger(d) ? String(d) : String(d));

// Shift every gear on a line by `by` (G2 → G3), capped at G6.
export function shiftLineGears(text, by) {
  if (!by) return text;
  return text.replace(/\bG(\d)(\.\d)?\b/g, (_, n, f) => `G${Math.min(6, Math.max(1, +n + by))}${f || ''}`);
}

// Scale a line's reps (for descending / ascending rounds): 6 x 50 at 0.5 → 3 x 50.
// A single swim scales its distance instead (500 at 0.4 → 200).
export function scaleReps(line, factor) {
  if (line.type !== 'swim' || factor === 1) return line;
  if (line.reps === 1) return { ...line, distance: Math.max(25, Math.round(line.distance * factor / 25) * 25) };
  return { ...line, reps: Math.max(1, Math.round(line.reps * factor)) };
}

// Re-time a set's lines with new send-offs. `intervalsOf(line)` returns the
// per-group values for a swim line, or null to keep what is written.
export function retime(text, intervalsOf) {
  return String(text ?? '').split(/\r?\n/).map((raw) => {
    const l = parseLine(raw);
    if (l.type !== 'swim') return raw;
    const iv = intervalsOf(l);
    return iv ? writeSwim(l, iv) : raw;
  }).join('\n');
}

// ------------------------------------------------------------------ style
//
// A style profile is learned from the coach's own blocks: how long send-offs
// are relative to each group's G3 pace for each kind of line, the usual rest
// line, rounds, columns, rep distances per gear and favourite phrasing.


// Which bucket a line's send-off belongs to: kind | gear shape | distance.
export function styleKey(l, withStroke = false) {
  let g = 'none';
  if (l.easy) g = 'easy';
  else if (l.oddsEvens) g = 'oe';
  else if (l.gearFrom) g = `${l.gearFrom}>${/^G\d/.test(l.gearTo || '') ? l.gearTo : 'pace'}`;
  else if (l.pace) g = 'pace';
  else if (l.gears?.length > 1 && !l.mix) g = l.gears.join('/'); // "[G3 / G4 / G5 / G6]" is not a G6 line
  else if (l.gears?.length) g = l.gears[l.gears.length - 1];
  const s = withStroke ? `|${l.stroke}` : '';
  return `${l.kind}|${g}|${l.distance}${s}`;
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mode = (xs) => {
  const c = new Map();
  xs.forEach((x) => c.set(x, (c.get(x) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// Seconds per 100 a line adds to its reference pace: the free G3 pace, or
// (`im`) the IM G3 pace, where IM itself adds nothing and other strokes add
// their offset relative to IM. A drill share adds its part of the drill offset.
function lineOffset(model, l, im = false) {
  const stroke = im ? (model.strokes[l.stroke] ?? model.strokes.choice ?? 0) - (model.strokes.IM ?? 0) : 0;
  const base = im ? (model.kinds?.[l.kind] ?? 0) + stroke : strokeOffset(model, l.stroke, l.kind);
  return base + (l.drillShare || 0) * (model.kinds?.drill ?? 0);
}

// texts: block texts in the coach's notation (with or without headings).
// Ratios are send-off ÷ (G3 pace + the stroke's and kind's offset) × distance,
// so a ratio learned on backstroke also writes breaststroke sensibly (with a
// 400 IM row, relative to the IM pace the same way).
export function learnStyle(texts, model = DEFAULT_GEAR_MODEL) {
  model = makeGearModel(model);
  const ratios = {};
  const easy = [];
  const columns = [];
  const rests = [];
  const rounds = [];
  const minutes = [];
  const repsByGear = {};
  const phrases = {};
  const steps = {};
  let lines = 0;
  const long = [];
  for (const text of texts) {
    const p = parseSet(text);
    // The block's reference pace per column: a "G3 pace" row (free), or the
    // IM G3 pace of a "400 IM group" row.
    const g3Row = p.lines.find((l) => l.type === 'ref' && /^G3 pace/i.test(l.label));
    const imRow = !g3Row && p.lines.find((l) => l.type === 'ref' && /^400 IM\b/i.test(l.label));
    const g3 = g3Row || (imRow && { values: imRow.values.map((v) => imPaces(model, v).G3) });
    const prefix = g3Row ? '' : 'im:';
    if (p.heading) minutes.push(p.heading.minutes);
    for (const l of p.lines) {
      if (l.type === 'rest') rests.push(l.raw.trim());
      if (l.type === 'rounds') rounds.push(l.rounds);
      if (l.type !== 'swim') continue;
      lines++;
      if (l.distance >= 150) l.intervals.forEach((v) => long.push(v % 5 === 0));
      if (l.intervals.length > 1) {
        columns.push(l.intervals.length);
        const d = l.intervals.slice(1).map((v, i) => v - l.intervals[i]);
        (steps[l.distance] ||= []).push(median(d));
      }
      const gk = l.gears.at(-1) || (l.easy ? 'easy' : 'none');
      (repsByGear[gk] ||= []).push(l.distance);
      const phrase = l.desc.replace(/\s+/g, ' ').trim();
      if (phrase) (phrases[gk] ||= []).push(phrase);
      if (l.easy && l.intervals.length === 1) easy.push(l.intervals[0] / l.distance * 100);
      if (g3 && l.intervals.length > 1) {
        l.intervals.forEach((v, i) => {
          const pace = g3.values[Math.min(i, g3.values.length - 1)];
          if (!pace) return;
          const r = v / (l.distance / 100 * (pace + lineOffset(model, l, !!prefix)));
          (ratios[prefix + styleKey(l, true)] ||= []).push(r);
          (ratios[prefix + styleKey(l)] ||= []).push(r);
        });
      }
    }
  }
  const out = {
    version: 1,
    learnedFrom: { blocks: texts.length, lines },
    ratios: Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, Math.round(median(v) * 1000) / 1000])),
    easyPer100: easy.length ? Math.round(median(easy)) : 120,
    columns: mode(columns) || 1,
    restLine: mode(rests) || ':20 REST',
    rounds: Math.round(median(rounds) || 3),
    blockMinutes: minutes.length ? Math.round(median(minutes)) : 40,
    roundLongTo5: long.length >= 4 ? long.filter(Boolean).length / long.length >= 0.7 : null,
    steps: Object.fromEntries(Object.entries(steps).map(([d, v]) => [d, median(v)])),
    repsByGear: Object.fromEntries(Object.entries(repsByGear).map(([g, v]) => [g, mode(v)])),
    phrases: Object.fromEntries(Object.entries(phrases).map(([g, v]) => [g, [...new Set(v)].slice(0, 8)])),
  };
  return out;
}

// ------------------------------------------------------------- intervals

// Everything needed to put send-offs on lines for each group.
// plan.groups: [{ id, name, key, test: {distance, seconds} } | { …, g3: secondsPer100 }]
// plan.groups: [{ id, name, key, test: {distance, seconds} | g3: secondsPer100, im400: seconds }]
// (fastest first). Without groups, one group is made from plan.pace.
export function writingContext(plan, { style = null, calibration = {} } = {}) {
  const model = makeGearModel(plan.gears || {});
  let groups = (plan.groups || []).map((g, i) => {
    const test = g.test?.seconds ? g.test : g.g3 ? testForGearPace(model, 'G3', g.g3) : null;
    const paces = test ? gearPaces(model, test) : null;
    return { id: g.id || `g${i}`, name: g.name || `Group ${i + 1}`, key: g.key || '', test, paces, imPaces: g.im400 ? imPaces(model, g.im400) : null };
  }).filter((g) => g.paces);
  if (!groups.length) {
    const g3 = Math.max(50, (plan.pace || 100) - 12);
    const test = testForGearPace(model, 'G3', g3);
    groups = [{ id: 'g0', name: 'Everyone', key: '', test, paces: gearPaces(model, test), imPaces: null, assumed: true }];
  }
  return { model, groups, style, calibration: calibration || {}, unit: plan.unit || 'y' };
}

// The gear a line is mostly swum in (middle of a progression).
export function lineGear(l) {
  if (l.gearFrom && /^G\d/.test(l.gearTo || '')) {
    const a = gearIndex(l.gearFrom), b = gearIndex(l.gearTo);
    return `G${Math.round((a + b) / 2)}`;
  }
  if (l.mix) return `G${Math.round((gearIndex(l.gears[0]) + gearIndex(l.gears[1])) / 2)}`;
  if (l.oddsEvens) {
    const gs = l.gears.map(gearIndex).filter((x) => x != null);
    return gs.length ? `G${Math.max(...gs)}` : 'G3';
  }
  if (l.gears?.length > 1) {
    // "[G3 / G4 / G5 / G6]", "[G3 / G5]": a build through the listed gears,
    // timed in their middle gear (to the half gear) with that gear's rest.
    const gs = l.gears.map(gearIndex).filter((x) => x != null);
    if (l.pace) gs.push(gearIndex(PACE_GEAR.find(([re]) => re.test(l.pace))?.[1] || 'G5'));
    return `G${Math.round(gs.reduce((s, x) => s + x, 0) / gs.length * 2) / 2}`;
  }
  if (l.gears?.length) return l.gears[l.gears.length - 1];
  if (l.pace) return PACE_GEAR.find(([re]) => re.test(l.pace))?.[1] || 'G5';
  if (l.kind === 'drill') return 'G1';
  return 'G2';
}

// Send-offs for a swim line, one per group (or one shared value). Learned
// ratios to G3 pace win; otherwise the gear chart's pace + rest is used.
export function intervalsForLine(l, ctx) {
  if (l.type !== 'swim') return null;
  const groups = ctx.groups || [];
  const r5 = ctx.style?.roundLongTo5;
  // Learned ratios already carry the coach's rounding up, so round to the nearest step.
  const round = (v) => (r5 === false ? Math.round(v) : roundSendOff(ctx.model, v, l.distance, true));
  if (l.easy || !groups.length) {
    const per100 = ctx.style?.easyPer100 || 120;
    return [Math.max(5, Math.round(per100 * l.distance / 100 / 5) * 5)];
  }
  const gear = lineGear(l);
  const ratios = ctx.style?.ratios || {};
  const freeRatio = ratios[styleKey(l, true)] ?? ratios[styleKey(l)] ?? null;
  const imRatio = ratios[`im:${styleKey(l, true)}`] ?? ratios[`im:${styleKey(l)}`] ?? null;
  const cal = ctx.calibration?.[gear]?.[l.stroke] ?? ctx.calibration?.[gear]?.all ?? 0;
  const drill = (l.drillShare || 0) * (ctx.model.kinds?.drill ?? 0);
  const out = groups.map((g) => {
    const per = l.distance / 100;
    if (imRatio && g.imPaces?.G3 && l.stroke !== 'free') return round(imRatio * per * (g.imPaces.G3 + lineOffset(ctx.model, l, true)) + cal * per);
    if (freeRatio && g.paces.G3) return round(freeRatio * per * (g.paces.G3 + lineOffset(ctx.model, l)) + cal * per);
    if (imRatio && g.paces.G3) return round(imRatio * per * (g.paces.G3 + lineOffset(ctx.model, l)) + cal * per);
    return sendOff(ctx.model, g.paces, { gear, distance: l.distance, stroke: l.stroke, kind: l.kind, adjust: cal + drill, strokePaces: l.stroke === 'IM' ? g.imPaces : null });
  });
  if (l.oddsEvens) return [Math.max(...out)]; // straight sets: one send-off for everyone
  return out.every((v) => v === out[0]) ? [out[0]] : out;
}

// A block's lines ready to print: missing send-offs filled in, gears shifted
// for "build" rounds, reps scaled for descending / ascending rounds.
// `single`: one send-off for everyone (the slowest group's), as on PM doubles.
// A share of a block (one round of a circuit) cuts the count of a "4 x" /
// "3 rounds:" group first, and the reps inside it only for what is left.
export function writeLines(lines, ctx, { gearShift = 0, scale = 1, retimeAll = false, single = false } = {}) {
  let inner = scale; // the scale for swim lines in the current group
  return (lines || []).map((raw) => {
    const shifted = shiftLineGears(raw, gearShift);
    let l = parseLine(shifted);
    if (l.type === 'rounds') {
      inner = scale;
      if (scale === 1 || l.rounds < 2) return oneRoundWord(shifted);
      const n = Math.max(1, Math.round(l.rounds * scale));
      inner = (scale * l.rounds) / n;
      if (Math.abs(inner - 1) < 0.3) inner = 1;
      return n === l.rounds ? shifted : oneRoundWord(shifted.replace(/\d+/, String(n)));
    }
    // A group ends here (structure()); a later "5 min …" line is timed work inside it.
    if (['blank', 'adjust', 'ref'].includes(l.type)) inner = scale;
    if (l.type === 'ref') return raw; // each group's G3 pace stays the reference
    if (l.type !== 'swim') return shifted;
    const written = l.distance;
    if (inner !== 1) l = scaleReps(l, inner);
    // The coach's send-offs stay unless the gear or the distance changed (a
    // line with no G to shift keeps its send-offs in a faster round).
    const keep = l.intervals.length && !retimeAll && shifted === raw && l.distance === written;
    let iv = keep ? l.intervals : intervalsForLine(l, ctx) || l.intervals;
    if (single && iv.length > 1 && !keep) iv = [Math.max(...iv)];
    return writeSwim(l, iv);
  });
}

// A group count of one reads "1 round:", never "1 rounds:" (a count scaled
// down to one, or a block saved that way).
const oneRoundWord = (text) => text.replace(/^(\s*1\s*)rounds\b/i, '$1round');

// Reference rows the coach puts at the top of a block.
export function referenceRows(ctx, gears = ['G3']) {
  if (!ctx.groups.length) return [];
  return gears.map((g) => `${g} pace       ${formatColumns(ctx.groups.map((x) => Math.round(paceOf(x.paces, g))))}`);
}

// ------------------------------------------------------- group adjustments
//
// Slower groups drop reps so every group finishes within about a minute of
// the block's minutes, in the coach's order: the first rep of the pre-set
// ("start on #2"), the low-gear rep of a gear build in later rounds, speed
// reps in the last round, then main-set reps in later rounds (RD1 is never
// cut, unless the block is a single round). A cut that would leave a group
// well under the block's time is skipped for a smaller one. Adjustments are
// cumulative. Lines start with each group's column key (Season tab), else
// the reference row's value.

// A group adjustment line ("1:08 - 2 x 300 (start on #2)"), also when it is
// keyed by a group's column key or name that is not a clock ("L4 - …").
export function isAdjustment(raw, groups = []) {
  if (parseLine(raw).type === 'adjust') return true;
  const t = String(raw ?? '').trim();
  return groups.some((g) => [g.key, g.name].some((k) => k && t.startsWith(`${k} - `)));
}

export function groupAdjustments(lines, ctx, targetMinutes) {
  return adjustmentPlan(lines, ctx, targetMinutes).lines;
}

// A set without a "N rounds:" header is a single round (the coach writes no
// header for one): its lines after the pre-set's rest, or all of them when
// there is no rest line. Cut inside that round like a "1 round:" group.
function oneRound(top) {
  const rest = top.findIndex((x) => x.type === 'rest');
  const items = top.slice(rest + 1).filter((x) => !['ref', 'adjust', 'heading'].includes(x.type));
  return items.some((x) => x.type === 'swim') ? { type: 'rounds', rounds: 1, items } : null;
}

// The adjustment lines plus each group's seconds once it has made its cuts.
export function adjustmentPlan(lines, ctx, targetMinutes) {
  const p = parseSet((lines || []).join('\n'));
  const groups = ctx.groups || [];
  if (groups.length < 2 || !targetMinutes) return { lines: [], seconds: [] };
  const block = targetMinutes * 60;
  const hi = block + 30; // done once a group is this close
  const lo = block - 60; // and never cut it further under than this when a smaller cut exists
  const ref = p.lines.find((l) => l.type === 'ref');
  const keys = groups.map((g, i) => g.key || (ref?.values?.[i] != null ? fmtClock(ref.values[i]) : '') || g.name);
  const keyOf = (i) => (keys.filter((k) => k === keys[i]).length > 1 ? groups[i].name : keys[i]);
  const roundsItem = p.structure.find((x) => x.type === 'rounds') || oneRound(p.structure);
  const pre = p.structure.filter((x) => x.type === 'swim' && x.reps > 1 && !x.easy && !roundsItem?.items.includes(x));
  const candidates = [];
  if (pre[0]) candidates.push({ id: 'pre', text: `${pre[0].reps - 1} x ${pre[0].distance} (start on #2)`, saves: (gg) => intervalFor(pre[0], gg) || 0 });
  if (roundsItem) {
    const n = roundsItem.rounds;
    // Rounds a cut can cover: the later ones, or the only one.
    const span = Math.max(1, n - 1);
    const swims = roundsItem.items.filter((l) => l.type === 'swim');
    const builds = swims.filter((l) => l.gearFrom && l.reps > 1);
    // Kick is cut last, unless the rounds are all kick.
    const allKick = swims.every((l) => l.kind === 'kick' || l.easy);
    const speed = swims.filter((l) => /G6/.test(l.gears.join()) && !l.mix && l.reps > 1 && !builds.includes(l) && (allKick || l.kind !== 'kick'));
    const rest = swims.filter((l) => l.reps > 2 && !builds.includes(l) && !speed.includes(l));
    const main = rest.filter((l) => allKick || l.kind !== 'kick');
    const kick = allKick ? [] : rest.filter((l) => l.kind === 'kick');
    const rd = (k) => (n === 1 ? '' : ` in ${k === 1 ? `RD${n}` : Array.from({ length: k }, (_, i) => `RD${n - k + 1 + i}`).join(' + ')}`);
    if (builds.length) {
      const what = builds.map((l) => l.desc.split(/[ ,]/)[0]).filter(Boolean).join(' and ');
      const low = builds[0].gearFrom;
      for (let k = 1; k <= span; k++) candidates.push({ id: `build${k}`, replaces: 'build', text: `skip the ${low} ${builds[0].distance} of ${what}${rd(k)}`, saves: (gg) => k * builds.reduce((s, l) => s + (intervalFor(l, gg) || 0), 0) });
    }
    if (speed.length) {
      // Fewer speed reps in the last round, one at a time, up to skipping them.
      const l = speed[0];
      const what = l.desc.split(',')[0];
      for (let j = 1; j <= l.reps; j++) {
        candidates.push({ id: `speed${j}`, replaces: 'speed', text: j < l.reps ? `${l.reps - j} x ${l.distance} ${what}${rd(1)}` : `skip the ${what} ${l.distance}s${rd(1)}`, saves: (gg) => j * (intervalFor(l, gg) || 0) });
      }
    }
    // A rep fewer in the last rounds first, then more reps (at most half of them).
    const repCuts = (l, family, label) => {
      const pairs = [];
      for (let j = 1; j <= Math.max(1, Math.floor(l.reps / 2)); j++) for (let k = 1; k <= span; k++) pairs.push([j, k]);
      pairs.sort((a, b) => a[0] * a[1] - b[0] * b[1] || a[0] - b[0]);
      for (const [j, k] of pairs) candidates.push({ id: `${family}${j}x${k}`, replaces: family, text: `${l.reps - j} x ${l.distance}${label}${rd(k)}`, saves: (gg) => k * j * (intervalFor(l, gg) || 0) });
    };
    // One round: name the line, as "5 x 100" alone could be the pre-set.
    if (main.length) repCuts(main[0], 'main', n === 1 && main[0].desc ? ` ${main[0].desc.split(/[ ,]/)[0]}` : '');
    if (kick.length) repCuts(kick[0], 'kick', ' kick');
  }
  const out = [];
  const seconds = [setSeconds(p, 0)];
  let prevCuts = [];
  for (let g = 1; g < groups.length; g++) {
    let cuts = [...prevCuts];
    const timeOf = (list) => setSeconds(p, g) - list.reduce((s, c) => s + c.saves(g), 0);
    const plus = (c) => {
      const list = [...cuts];
      const replaced = c.replaces ? list.findIndex((x) => x.replaces === c.replaces) : -1;
      if (replaced >= 0) list.splice(replaced, 1, c); else list.push(c);
      return list;
    };
    for (;;) {
      const now = timeOf(cuts);
      if (now <= hi) break;
      // Not taken yet, and not a smaller version of a cut already made.
      const open = candidates.filter((c) => !cuts.some((x) => x.id === c.id || (c.replaces && x.replaces === c.replaces && x.saves(g) >= c.saves(g))));
      if (!open.length) break;
      let pick = open.find((c) => timeOf(plus(c)) >= lo);
      if (!pick) {
        // Every cut left is too big: take the one landing closest to the block's time, if that beats staying over.
        const off = (c) => Math.abs(timeOf(plus(c)) - block);
        pick = open.reduce((a, c) => (off(c) < off(a) ? c : a));
        if (off(pick) >= now - block) break;
      }
      cuts = plus(pick).sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
    }
    if (cuts.length) {
      const same = prevCuts.length && prevCuts.every((c) => cuts.includes(c));
      const extra = cuts.filter((c) => !prevCuts.includes(c));
      const prevKey = keyOf(g - 1);
      if (same && !extra.length) out.push(`${keyOf(g)} - same as ${prevKey}`);
      else if (same && prevCuts.length > 1) out.push(`${keyOf(g)} - same as ${prevKey}, plus ${extra.map((c) => c.text).join(', ')}`);
      else out.push(`${keyOf(g)} - ${cuts.map((c) => c.text).join(', ')}`);
    }
    seconds.push(timeOf(cuts));
    prevCuts = cuts;
  }
  return { lines: out, seconds };
}

// Seconds a block takes per group once send-offs are filled in.
export function blockSecondsByGroup(lines, ctx) {
  const p = parseSet(writeLines(lines, ctx).join('\n'));
  const n = Math.max(1, ctx.groups.length);
  return Array.from({ length: n }, (_, g) => setSeconds(p, g));
}

// ---------------------------------------------------------------- generate
//
// Write a block from scratch in a common shape: reference rows, a pre-set
// that builds through the gears, a fixed rest, then rounds of main work →
// short speed → kick → easy, sized so the fastest group finishes in the
// block's minutes, with skips for slower groups.

const ABBR = { free: 'free', back: 'BK', breast: 'BR', fly: 'FL', IM: 'IM', choice: 'choice' };

// Generic coaching shapes written for the app (no line comes from any
// coach's library; a coach's own patterns are learned from their blocks).
// `easy`: a warm-up, cool-down or recovery block (G1–G2, drill, a build to
// G3 at most; no reference row). A template without rounds is a straight set
// whose first line grows to fill the time.
function templates(focus, s, slot) {
  const st = ABBR[s] || 'free';
  // A 25 or 50 can't be an IM: short reps go in IM order.
  const sh = st === 'IM' ? 'IMO' : st;
  const easySt = st === 'IM' ? 'choice' : st;
  const easy = '150 easy, any stroke';
  if (focus === 'warmup') {
    return { title: 'warm-up', easy: true, pre: [`400 ${easySt} easy`], rest: false, rounds: [
      `4 x 75 ${sh} [25 drill / 50 swim]`, '6 x 50 kick, G2', `3 x 50 ${sh}, G1 → G3 by 25`], main: 0 };
  }
  if (focus === 'cooldown') {
    return { title: 'cool-down', easy: true, pre: [], rounds: null, after: [`3 x 100 ${easySt} easy, long strokes`, '200 easy, any stroke'], main: 0 };
  }
  if (focus === 'recovery') {
    const work = [`${slot === 'PM' ? 6 : 3} x 150 ${st} G2`, `4 x 75 ${sh} [25 drill / 50 swim]`, `3 x 50 ${sh}, G1 → G3 by 25`, easy];
    // AM: an easy pre-set, then rounds; PM: one straight set.
    return slot === 'PM' ? { title: `${st} recovery`, easy: true, pre: [], rounds: null, after: work, main: 0 }
      : { title: `${st} recovery`, easy: true, pre: [`300 ${easySt} easy, long strokes`], rest: true, rounds: work, main: 0 };
  }
  if (slot === 'PM') {
    // Doubles: short, one send-off. Aerobic and technique doubles are aerobic
    // work + skill + a little speed; an odds / evens straight set is for the
    // sharper focuses.
    if (focus === 'aerobic' || focus === 'technique') {
      const skill = focus === 'technique';
      return { title: skill ? `${st} technique` : `${st} aerobic base`, pre: [], rounds: null, after: [
        `${skill ? 4 : 6} x 200 ${st} G2, steady`, `${skill ? 8 : 4} x 75 ${sh} [25 drill / 50 swim]`, `8 x 25 ${sh} G6 sprint`, easy], main: 0 };
    }
    if (focus === 'kick') {
      return { title: 'kick', pre: [], rounds: null, after: ['10 x 75 kick, G2', '6 x 25 kick, G6 sprint', easy], main: 0 };
    }
    return { title: `${st} pace changes`, pre: [], rounds: null, after: [
      `10 x 50 ${sh}   odds - G2   evens - G5`, `6 x 25 ${sh} G6, quick turns`, '4 x 25 kick, G6 sprint', easy], main: 0 };
  }
  // The IM gears set is its own focus; an aerobic or threshold IM block stays aerobic or threshold.
  if (focus === 'im') {
    return { title: 'IM stroke builds', pre: ['5 x 100 IM, G2 → G3 by 25'], rest: true, rounds: [
      '3 x 50 BK, G2 → G4 by 25', '3 x 50 BR, G2 → G4 by 25', '4 x 25 FL G6 sprint', '100 IM G4, strong walls', '4 x 25 kick, G6 sprint', '100 easy, any stroke'], main: 3 };
  }
  switch (focus) {
    case 'race':
      return { title: `${st} race pace`, pre: [`5 x 100 ${st} [G2 / G3 / G4 / G5] by 25`], rest: true, rounds: [
        `6 x 50 ${sh} at 200 pace`, `4 x 25 ${sh} G6, quick turns`, '4 x 25 kick, G6 sprint', easy], main: 0 };
    case 'speed':
      return { title: `${st} speed`, pre: [`3 x 100 ${st}, G2 → G5 by 25`], rest: true, rounds: [
        `3 x 50 ${sh} G6 sprint`, `4 x 25 ${sh} G6, high tempo`, '2 x 25 kick, G6 sprint', easy], main: 0 };
    case 'technique':
      return { title: `${st} technique`, pre: [`3 x 150 ${sh} [50 drill / 100 swim]`], rest: true, rounds: [
        `6 x 50 ${sh} D1-3, G2 → G4`, '4 x 50 kick [25 easy / 25 sprint]', `4 x 25 ${sh} G5, clean turns`, easy], main: 0 };
    case 'kick':
      return { title: 'kick', pre: ['4 x 150 kick, G2'], rest: true, rounds: [
        '6 x 50 kick, G3', '4 x 25 kick, G6 sprint', easy], main: 0 };
    case 'threshold':
      return { title: `${st} threshold`, pre: [`4 x 150 ${st} D1-4, G2 → G4`], rest: true, rounds: [
        `6 x 100 ${st} G3, steady`, '6 x 50 kick, G2', `3 x 50 ${sh} G5, strong finish`, easy], main: 0 };
    default: // aerobic
      return { title: `${st} aerobic base`, pre: [`2 x 400 ${st}, G2 → G3 by 200`], rest: true, rounds: [
        `6 x 100 ${st} G2, steady`, '4 x 75 kick, G2', `4 x 25 ${sh} G6 sprint`, easy], main: 0 };
  }
}

// "4 x 50 …" → "6 x 50 …"; a single swim ("100 IM G4, strong walls") gets reps in front.
const setReps = (raw, reps) => (/^\d+\s*x\s*/.test(raw) ? raw.replace(/^\d+\s*x\s*/, reps > 1 ? `${reps} x ` : '') : reps > 1 ? `${reps} x ${raw}` : raw);

export function generateBlock({ focus = 'aerobic', minutes = 40, stroke = 'free', slot = 'AM', ctx, variant = 0 }) {
  const t = templates(focus, stroke, slot);
  const restLine = ctx.style?.restLine || ':20 REST';
  const build = (rounds, mainReps, withPre = true) => {
    const lines = withPre ? [...t.pre] : [];
    if (t.rest && lines.length) lines.push(restLine);
    if (t.rounds) {
      // A single round has no header in the coach's notation.
      if (rounds > 1) lines.push(`${rounds} rounds:`);
      t.rounds.forEach((l, i) => lines.push(i === t.main && mainReps ? setReps(l, mainReps) : l));
    }
    if (t.after) lines.push(...t.after);
    return writeLines(lines, ctx, { single: slot === 'PM' });
  };
  const target = minutes * 60;
  let best = null;
  const roundOptions = t.rounds ? [1, 2, 3, 4, 5] : [1];
  const repOptions = t.rounds ? [0, 2, 3, 4, 5, 6, 7, 8, 10] : [1]; // 0 = the main line as written
  // Short requests may drop the pre-set (and go to one round) to fit.
  const preOptions = t.pre.length ? [true, false] : [true];
  for (const withPre of preOptions) {
    for (const r of roundOptions) {
      for (const reps of repOptions) {
        const lines = build(r, reps, withPre);
        const secs = setSeconds(parseSet(lines.join('\n')), 0);
        const score = Math.abs(secs - target) + (r === (ctx.style?.rounds || 3) ? 0 : r === 1 ? 90 : 30) + (withPre ? 0 : 120) + ((variant % 3) * (r % 2 ? 1 : -1) * 20);
        if (!best || score < best.score) best = { lines, secs, score, rounds: r };
      }
    }
  }
  // Straight sets: scale the opening set to fill the time (odds / evens in pairs).
  if (!t.rounds) {
    const lines = best.lines;
    const first = parseLine(lines[0]);
    if (first.type === 'swim') {
      const per = intervalFor(first, 0) || 100;
      const others = best.secs - first.reps * per;
      const step = first.oddsEvens ? 2 : 1;
      const reps = Math.max(step, Math.round((target - others) / per / step) * step);
      lines[0] = writeSwim({ ...first, reps });
      best = { ...best, lines, secs: setSeconds(parseSet(lines.join('\n')), 0) };
    }
  }
  const mins = Math.max(5, Math.round(best.secs / 60));
  const refs = slot === 'PM' || t.easy ? [] : referenceRows(ctx, ['G3']);
  const adjustments = slot === 'PM' ? [] : groupAdjustments([...refs, ...best.lines], ctx, mins);
  const all = [...refs, ...best.lines, ...adjustments];
  const parsed = parseSet(all.join('\n'));
  return {
    name: `${mins} min ${t.title}`,
    minutes: mins,
    category: focus === 'im' ? 'race' : ({ aerobic: 'aerobic', threshold: 'threshold', race: 'race', speed: 'speed', technique: 'technique', recovery: 'technique', kick: 'kick', warmup: 'warmup', cooldown: 'cooldown' }[focus] || 'aerobic'),
    stroke: stroke === 'IM' ? 'IM' : stroke,
    gears: setGears(parsed),
    session: slot === 'PM' ? 'PM' : 'AM',
    lines: all,
    distance: setDistance(parsed),
    source: 'generated',
  };
}

// --------------------------------------------------------------- quick add

// What a block heading says it is ("30 min warm-up", "40 min free aerobic"),
// in the order the words win.
const HEADING_CATEGORY = [
  [/warm[\s-]?up|loosen/, 'warmup'], [/(cool|warm)[\s-]?down/, 'cooldown'], [/\bkick\b/, 'kick'], [/\bpull\b/, 'pull'],
  [/\b(drills?|technique|socks)\b/, 'technique'], [/\b(sharpen|sprints?|speed)\b/, 'speed'], [/\b(race|rp|broken)\b|\b\d+\s*pace\b/, 'race'],
  [/\bthreshold\b/, 'threshold'], [/\baerobic\b/, 'aerobic'],
];

// A pasted set (the coach's notation) → fields for makeBlock.
export function quickBlock(text, ctx = null) {
  const parsed = parseSet(text);
  const heading = parsed.heading;
  const swims = parsed.lines.filter((l) => l.type === 'swim');
  // The lines without the heading line (only that one), trimmed of blank lines at the ends.
  const body = String(text ?? '').split(/\r?\n/).filter((_, i) => i !== parsed.headingIndex);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  const gears = setGears(parsed);
  const distance = setDistance(parsed);
  const title = (heading?.title || '').toLowerCase();
  const words = `${title} ${swims.map((l) => l.desc).join(' ')}`.toLowerCase();
  const count = (k) => swims.filter((l) => l.kind === k).reduce((s, l) => s + l.reps * l.distance, 0);
  const top = gears.length ? Math.max(...gears.map(gearIndex)) : 0;
  const said = HEADING_CATEGORY.find(([re]) => re.test(title))?.[1];
  let category = 'aerobic';
  if (said) category = said;
  else if (/warm[\s-]?up|loosen/.test(words) && !/cool/.test(words)) category = 'warmup';
  else if (/(cool|warm)[\s-]?down/.test(words)) category = 'cooldown';
  else if (distance && count('kick') / distance > 0.6) category = 'kick';
  else if (distance && count('pull') / distance > 0.6) category = 'pull';
  else if (distance && count('drill') / distance > 0.4 || /\bdrill|socks|technique\b/.test(words)) category = 'technique';
  else if (/sharpen|sprint|speed/.test(words) || (top >= 6 && swims.every((l) => l.distance <= 50))) category = 'speed';
  else if (/broken|race|pace|rp\b/.test(words) || top >= 5) category = 'race';
  else if (top >= 3) category = 'threshold';
  const strokes = swims.filter((l) => l.kind === 'swim').map((l) => l.stroke).filter((s) => s !== 'choice');
  const stroke = strokes.includes('IM') ? 'IM' : mode(strokes) || 'choice';
  let minutes = heading?.minutes || null;
  if (!minutes) {
    const secs = setSeconds(parsed, 0, ctx ? (l) => intervalsForLine(l, ctx)?.[0] : undefined);
    if (secs) minutes = Math.max(1, Math.round(secs / 60));
  }
  return {
    name: heading ? `${heading.minutes} min ${heading.title}`.trim() : (swims[0] ? writeSwim({ ...swims[0], intervals: [] }) : 'New block'),
    category,
    stroke,
    minutes: minutes || null,
    distance: minutes ? null : distance || null,
    gears,
    equipment: [...new Set(swims.flatMap((l) => l.equipment))],
    lines: body,
    source: 'pasted',
  };
}

// ------------------------------------------------------------------- load

const PACE_GEAR = [[/\b1650|mile\b/i, 'G3.5'], [/\b1000\b/, 'G4'], [/\b500\b|\b400\b/, 'G5'], [/\b200\b/, 'G6'], [/\b100\b|\b50\b|race pace|RP\b/i, 'G6']];

// Yards per gear in a set (rounds counted): progressions and odds/evens
// split their yards across their gears; pace sets map to the nearest gear;
// easy swims are G1, unlabelled work G2.
export function gearYards(parsed) {
  const out = {};
  const add = (g, y) => { out[g] = (out[g] || 0) + y; };
  const line = (l, times) => {
    if (l.type !== 'swim') return;
    const y = l.reps * l.distance * times;
    let gears = [];
    if (l.gearFrom && /^G\d/.test(l.gearTo || '')) gears = gearSpan(l.gearFrom, l.gearTo);
    else if (l.gears.length) gears = l.gears;
    else if (l.pace) gears = [PACE_GEAR.find(([re]) => re.test(l.pace))?.[1] || 'G5'];
    else gears = [l.easy ? 'G1' : 'G2'];
    gears.forEach((g) => add(g, y / gears.length));
  };
  for (const it of parsed.structure) {
    if (it.type === 'rounds') it.items.forEach((l) => line(l, it.rounds));
    else line(it, 1);
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

// Yards per gear of a block's lines as one round of a circuit prints them:
// gears shifted and reps scaled as writeLines writes them (send-offs don't
// change the yards, so no group is timed).
export const linesGearYards = (lines, { gearShift = 0, scale = 1 } = {}) => gearYards(parseSet(writeLines(lines, YARDS_ONLY, { gearShift, scale }).join('\n')));
const YARDS_ONLY = { groups: [] };

// CNS points for block lines.
export const blockCns = (lines, model) => cnsPoints(model, gearYards(parseSet((lines || []).join('\n'))));
