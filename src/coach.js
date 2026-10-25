// The coach to text: what Claude is told about this coach (their plan, gear
// chart, groups, style, library, recent practices and debriefs), the rules
// for writing in their notation, the turns sent for a chat, and reading
// Claude's JSON reply back into blocks and practices. Pure functions, no DOM.

import {
  CATEGORIES, EQUIPMENT, FOCUSES, PATTERNS, STROKES, WEEKDAYS, daysBetween, longDate, makeBlock,
  sessionsOn,
} from './practice.js';
import { fmtClock, makeGearModel } from './gears.js';
import { carryForward, debriefSummary } from './learn.js';
import { parseLine, parseSet, quickBlock, setGears } from './setlang.js';
import { BANDS, weekGaps, weekOf, weekTotals } from './week.js';

export const CONTEXT_MAX = 20000; // bytes of context text
export const TURNS_MAX = 120000; // characters across all turns

// ------------------------------------------------------------------ rules

export const RULES = `You are the assistant coach for a swim coach who runs a group of swimmers. You write practices and blocks for them in their own notation and answer questions about their plan, gear chart, groups and debriefs. Everything you know about this coach is in the CONTEXT below. Do not invent swimmers, meets, times or groups that are not there.

How this coach writes a set:
- A practice is a list of blocks. Every block is headed "<N> min <focus>", e.g. "36 min FL/free switch" or "30 min warm-up". The heading is the block's "name"; do not repeat it in "lines".
- Gears: G1 recovery, G2 aerobic, G3 threshold, G4 1000 pace / VO2, G5 500 pace, G6 200 pace / max speed. Half gears (G2.5, G3.5, G4.5) exist.
- One row per line, for example (made-up numbers; use the coach's own groups and gears):
    G3 pace       1:02 | 1:05 | 1:08 | 1:11      (reference row, one value per group)
    3 x 300 free  3:35 | 3:50 | 4:05 | 4:20       (send-offs per group, fastest group first)
    #2 G2.5, breathe every 5th                    (note for one rep)
    :15 REST
    3 rounds:
    6 x 50 FL, G2 → G5 by 25    :53 | :56 | :59 | 1:02
    150 easy, any stroke    3:00                  (one value = every group)
    1:08 - 2 x 300 (start on #2), 4 x 50 in RD3   (group adjustment: the group's column key, " - ", what that group changes)
- Also in their language: RD1/RD2 for rounds, odds/evens ("8 x 100 free   odds - G2   evens - G4"), D1-4 (descend 1 to 4), OTB, UWDK, [25 easy / 25 sprint], "start on #2", "G2 → G5 by 25".
- Send-offs go at the end of a line after three or more spaces, one column per group in the order of GROUPS (fastest first). Work them out from each group's pace per 100 in that gear (GROUPS) plus the gear's rest (GEAR CHART), with the stroke and kick/pull/drill offsets. Or leave the send-offs off a line and the app fills them in from the gear chart; do that whenever you are unsure.
- Slower groups swim the same set and finish in the same minutes through group adjustment lines (drop the first rep of the pre-set, skip the low gear of a build in later rounds, fewer reps in the last round), not a different set.
- The block's minutes are the time the fastest group needs for its lines.
- PM doubles are short (about 20-60 min): straight sets with one send-off for everyone (no group columns, no adjustments).
- No practice on a meet day. Before a meet: less volume, sharper, more rest; the day before is a short sharpen.
- Use the debriefs: intervals too hard or few made the send-offs -> more rest or slower send-offs; too easy -> tighten them; drills not working -> change the drill or the focus; a block rated bad -> change it or leave it out; keep what the coach said they changed. Say in "reply" what you took from the debriefs.
- THIS WEEK shows each session's status (open, written, swum, debriefed), what is already written and the week's gear bands and kick against the phase targets. When writing a session or planning the rest of the week, steer what is still open toward the targets (more of a band that is under, less of one that is over), mind the CNS load before race-pace and speed days, and don't repeat a main set already written this week. To plan several sessions, answer in "reply" day by day (focus, main set, yards) and put any new sets in "blocks".
- Follow the coach's style guide and reuse the shapes, phrasing and rounds of their library blocks.

Reply with one JSON object only, no other text:
{"reply": string, "practice": null | {"title": string, "slot": "AM" | "PM", "rounds": number, "pattern": ${Object.keys(PATTERNS).map((p) => `"${p}"`).join(' | ')}, "blocks": [Block]}, "blocks": [Block]}
Block = {"name": string, "category": ${Object.keys(CATEGORIES).map((c) => `"${c}"`).join(' | ')}, "minutes": number, "stroke": ${STROKES.map((s) => `"${s}"`).join(' | ')}, "gears": ["G3", ...], "equipment": [${EQUIPMENT.map((e) => `"${e}"`).join(', ')}], "session": "AM" | "PM" | "any", "circuit": boolean, "lines": [string]}
- "reply": short plain text (no Markdown) in the coach's words: the group, send-offs, gears, rounds, debrief.
- "practice": a whole session when asked to write one (warm-up to warm-down, block minutes adding up to the session's minutes); otherwise null. "circuit": true blends a block into one multi-round circuit with the other circuit blocks ("rounds" and "pattern" apply to those); normally every block has "circuit": false and "rounds": 1.
- "blocks": separate blocks when asked for a block or a set (do not repeat the practice's blocks here); otherwise [].
- A question (for example about the debriefs) gets its answer in "reply" with "practice": null and "blocks": [].`;

// ---------------------------------------------------------------- context

const bytes = (s) => new TextEncoder().encode(s).length;
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…` : t;
};
const focusName = (f) => FOCUSES[f]?.label || f || '';
const gearsOf = (f) => (FOCUSES[f]?.gears || []).join(', ');

function positionLine(pos) {
  if (!pos) return '';
  if (pos.status === 'before') return `Season starts in ${pos.daysToStart} day${pos.daysToStart === 1 ? '' : 's'}`;
  if (pos.status === 'after') return 'Season finished (off-season)';
  if (pos.status === 'empty') return 'No phases in the plan';
  return `${pos.phase.name} · week ${pos.phaseWeek + 1} of ${pos.phase.weeks} · season week ${pos.week + 1} of ${pos.total}`;
}

function sessionText(s) {
  return `${s.slot} ${s.minutes} min · ${focusName(s.focus)}${gearsOf(s.focus) ? ` (gears ${gearsOf(s.focus)})` : ''}${s.theme ? ` · theme: ${s.theme}` : ''}${s.note ? ` · ${s.note}` : ''}`;
}

const fmtYards = (d, unit) => `${Math.round(d || 0).toLocaleString('en-US')}${unit}`;

// One session of the week with where it stands: "AM 120 Aerobic [written:
// "Tuesday kick", 6,200y]", "PM 60 Technique [open]".
function weekSessionText(s, unit) {
  const head = s.extra ? `${s.slot} extra (not in the plan)` : `${s.slot} ${s.minutes} ${focusName(s.focus)}${s.theme ? ` (${s.theme})` : ''}${s.note ? ` (${s.note})` : ''}`;
  const r = s.record;
  if (!r) return `${head} [${s.status}]`;
  const title = r.title || (r.blocks || []).filter((b) => !['warmup', 'cooldown'].includes(b.category)).map((b) => b.name).slice(0, 3).join(', ') || focusName(r.focus);
  return `${head} [${s.status}: "${clip(title, 60)}", ${fmtYards(r.distance, r.unit || unit)}, ${r.minutes} min]`;
}

// The week of `date`: every day's sessions with their status (open,
// written, swum, debriefed) and what is written, the totals against the
// phase's targets and where the week is off them. Gear bands and CNS points
// are counted as Build, Today and the Week count them (weekTotals; `cns`,
// when given, counts each practice's points: the app's recordCns).
function weekLines(state, learned, date, cns = null) {
  const plan = state.plan;
  const unit = plan.unit || 'y';
  const today = state.today || date;
  const week = weekOf({ plan, date, today, log: state.log || [], debriefs: state.debriefs || [] });
  const model = learned.writing?.model || plan.gears || {};
  const t = weekTotals(week, plan, model, { cns });
  const lines = week.days.map((day, i) => {
    const what = [
      day.meet ? `meet: ${day.meet.name}` : '',
      ...day.sessions.map((s) => weekSessionText(s, unit)),
    ].filter(Boolean).join(' + ') || 'rest';
    const marks = [day.date === today ? '<- today' : '', day.date === date && date !== today ? '<- asked about' : ''].filter(Boolean).join(' ');
    return `${WEEKDAYS[i]} ${day.date.slice(5)}: ${what}${marks ? `  ${marks}` : ''}`;
  });
  const tg = t.targets;
  lines.push(`Written: ${t.written} of ${t.planned} planned sessions${t.extras ? ` + ${t.extras} extra` : ''}, ${fmtYards(t.distance, unit)}, ${t.minutes} min${t.targetYards ? `; target about ${fmtYards(t.targetYards, unit)} for the week (${week.phase?.name || 'phase'} at ${Math.round((week.phase?.volume ?? 1) * 100)}% volume)` : ''}.`);
  const bandText = (share) => BANDS.map((b) => `${b.label} ${Math.round((share[b.key] || 0) * 100)}%`).join(', ');
  if (t.distance) {
    lines.push(`Gear bands of the written yards: ${bandText(t.share)}; kick ${Math.round(t.kickShare * 100)}%. Targets: ${bandText(tg)}; kick ${Math.round(tg.kick * 100)}%.`);
    const gaps = weekGaps(t);
    lines.push(gaps.length ? `Off target: ${gaps.map((g) => g.text).join('; ')}.` : 'On target so far.');
    const cns = week.days.map((d, i) => (t.cnsByDay[i] ? `${WEEKDAYS[i]} ${t.cnsByDay[i]}` : '')).filter(Boolean);
    if (cns.length) lines.push(`CNS points written: ${cns.join(', ')}.`);
  } else {
    lines.push(`Nothing written yet. Targets: ${bandText(tg)}; kick ${Math.round(tg.kick * 100)}% of yards.`);
  }
  return lines;
}

// Which slot a free-text message is about: 'AM', 'PM' or null.
export function slotOf(message) {
  const t = String(message || '');
  if (/\bPM\b|\bdoubles?\b|\bafternoon\b|\bevening\b/i.test(t)) return 'PM';
  if (/\bAM\b|\bmorning\b/i.test(t)) return 'AM';
  return null;
}

// Library blocks most useful for the focus of the day (or the asked slot):
// categories that serve the focus, matching gears, the right session, the
// coach's own written blocks and good debriefs first.
export function relevantBlocks(blocks, { focuses = [], slot = null, weights = {}, max = 20 } = {}) {
  const fs = focuses.filter((f) => FOCUSES[f] && f !== 'rest');
  if (!fs.length) fs.push('aerobic');
  const score = (b) => {
    let s = 0;
    for (const f of fs) {
      const spec = FOCUSES[f];
      let v = spec.weights[b.category] || (CATEGORIES[b.category]?.main ? 0.4 : 1);
      if ((b.gears || []).some((g) => spec.gears.includes(String(g).replace(/\.\d$/, '')))) v *= 1.4;
      s = Math.max(s, v);
    }
    if (b.lines?.length) s *= 1.6;
    if (['coach', 'pasted', 'drive', 'claude'].includes(b.source)) s *= 1.3;
    if (slot && b.session === slot) s *= 1.25;
    else if (slot && b.session && b.session !== 'any') s *= 0.4;
    s *= Number.isFinite(weights[b.id]) ? weights[b.id] : 1;
    return s;
  };
  return blocks.map((b, i) => ({ b, i, s: score(b) })).sort((x, y) => y.s - x.s || x.i - y.i).slice(0, max).map((x) => x.b);
}

function blockText(b, unit, maxLines) {
  const measure = b.minutes ? `${b.minutes} min` : `${b.distance}${unit}`;
  const meta = [measure, b.category, b.stroke !== 'choice' ? b.stroke : '', b.gears?.length ? b.gears.join(' ') : '', b.session && b.session !== 'any' ? b.session : '', b.equipment?.length ? `kit: ${b.equipment.join(', ')}` : ''].filter(Boolean).join(' · ');
  const lines = (b.lines || []).slice(0, maxLines);
  const more = (b.lines || []).length - lines.length;
  return [`## ${b.name} · ${meta}`, ...lines, ...(more > 0 ? [`(+${more} more lines)`] : []), ...(!lines.length && b.detail ? [`(no lines; notes: ${clip(b.detail, 200)})`] : [])].join('\n');
}

function recordText(r, n) {
  const head = `### ${r.date} ${r.slot || 'AM'}${r.focus ? ` · ${focusName(r.focus)}` : ''}${r.title ? ` · ${r.title}` : ''}`;
  const body = r.text || (r.blocks || []).map((b) => [b.name, ...(b.lines || []).map((l) => `    ${l}`)].join('\n')).join('\n');
  return `${head}\n${clip(body, n)}`;
}

const LADDER = [
  { blocks: 20, lines: 30, practices: 5, practiceChars: 2000, guide: 4000 },
  { blocks: 16, lines: 20, practices: 4, practiceChars: 1400, guide: 3000 },
  { blocks: 12, lines: 14, practices: 3, practiceChars: 1000, guide: 2000 },
  { blocks: 8, lines: 10, practices: 2, practiceChars: 700, guide: 1500 },
  { blocks: 5, lines: 6, practices: 1, practiceChars: 500, guide: 1000 },
];

// Compact text about this coach for Claude, at most CONTEXT_MAX bytes.
//   state     the app state (plan, blocks, log, debriefs, style, today)
//   learned   { weights, calibration, writing } from the app shell
//   date      the day asked about (default state.today)
//   slot      'AM' | 'PM' | null: the session asked about
//   cns       optional (record) => CNS points of a saved practice (the app's
//             recordCns); by default the week counts them as the builder
//             does from state.plan and learned.writing.model
export function coachContext({ state, learned = {}, date = null, slot = null, cns = null } = {}) {
  for (const limits of LADDER) {
    const text = buildContext(state, learned, date || state.today, slot, limits, cns);
    if (bytes(text) <= CONTEXT_MAX) return text;
  }
  let text = buildContext(state, learned, date || state.today, slot, LADDER.at(-1), cns);
  while (bytes(text) > CONTEXT_MAX) text = text.slice(0, Math.floor(text.length * 0.9));
  return `${text}\n(cut short)`;
}

function buildContext(state, learned, date, slot, lim, cns = null) {
  const plan = state.plan;
  const unit = plan.unit || 'y';
  const day = sessionsOn(plan, date);
  const out = [];
  const push = (title, lines) => { if (lines.length) out.push(`${title}\n${lines.join('\n')}`); };

  // Today and the week around it.
  const today = [`Date: ${longDate(date)} (${date})`, `Season: ${plan.name || 'Season'} · ${positionLine(day.position)}`];
  if (day.meet) today.push(`Meet today: ${day.meet.name}. No practice.`);
  else if (!day.sessions.length) today.push('No practice today (rest day).');
  else today.push(...day.sessions.map((s) => `Session: ${sessionText(s)}`));
  if (day.preMeet) today.push('Pre-meet: the day before a meet, one short sharpen session.');
  if (state.today && date !== state.today) today.push(`(The coach is asking about this day; today is ${longDate(state.today)}, ${state.today}.)`);
  if (slot) today.push(`Asked about: the ${slot} session${day.sessions.some((s) => s.slot === slot) ? '' : ' (not in the plan that day)'}.`);
  push('TODAY', today);

  push('THIS WEEK (each session: plan, then [status: what is written])', weekLines(state, learned, date, cns));

  const meets = (plan.meets || []).filter((m) => m.end >= date && daysBetween(date, m.start) <= 21).sort((a, b) => (a.start < b.start ? -1 : 1));
  push('MEETS IN THE NEXT 21 DAYS', meets.length ? meets.map((m) => {
    const away = daysBetween(date, m.start);
    return `- ${m.name}: ${m.start}${m.end !== m.start ? ` to ${m.end}` : ''}${m.course ? ` (${m.course})` : ''}, ${away <= 0 ? 'on now' : `in ${away} day${away === 1 ? '' : 's'}`}${m.note ? ` · ${clip(m.note, 160)}` : ''}`;
  }) : ['none']);
  out.push(`UNIT: ${unit === 'm' ? 'metres' : 'yards'}${plan.course ? ` (${plan.course})` : ''}`);

  // Gear chart and groups.
  const model = learned.writing?.model || makeGearModel(plan.gears || {});
  const gearLines = model.gears.map((g) => `${g.name} ${g.label} · rest ratio ${g.rest}${g.feel ? ` · ${g.feel}` : ''}`);
  const r = model.rounding || {};
  gearLines.push(`Rest after a rep = swim time × ratio × (swim seconds / 60)^${model.restExponent}. Send-offs: whole seconds${r.longFrom && r.long > 1 ? `, rounded up to :${String(r.long).padStart(2, '0')} from ${r.longFrom} up` : ''}.`);
  gearLines.push(`Offsets in s/100 added to the free pace: ${Object.entries(model.strokes || {}).map(([k, v]) => `${k} +${v}`).join(', ')}; ${Object.entries(model.kinds || {}).filter(([k]) => k !== 'swim').map(([k, v]) => `${k} +${v}`).join(', ')}.`);
  const cal = learned.calibration || {};
  const calText = Object.entries(cal).flatMap(([g, by]) => Object.entries(by).map(([st, v]) => `${g}${st === 'all' ? '' : ` ${st}`} ${v > 0 ? '+' : ''}${v}s/100`));
  if (calText.length) gearLines.push(`Learned from debriefs (added to send-offs): ${calText.join(', ')}.`);
  push('GEAR CHART', gearLines);

  const groups = learned.writing?.groups || [];
  push('GROUPS (interval columns, fastest first; pace per 100)', groups.length ? groups.map((g, i) => {
    const p = (k) => (g.paces?.[k] != null ? `${k} ${fmtClock(g.paces[k])}` : '');
    const im = g.imPaces?.G3 ? ` · IM G3 ${fmtClock(g.imPaces.G3)}` : '';
    return `${i + 1}. ${g.name}${g.key ? ` (column key ${g.key})` : ''}: ${['G2', 'G3', 'G4', 'G5', 'G6'].map(p).filter(Boolean).join(' · ')}${im}${g.assumed ? ' (assumed: no groups set up yet, one column for everyone)' : ''}`;
  }) : ['none set up']);

  // Style.
  const st = state.style;
  const style = [];
  if (st?.guide?.trim()) style.push(`Style guide (the coach's words):\n${clip(st.guide, lim.guide)}`);
  if (st?.learnedFrom) {
    style.push(`Learned from ${st.learnedFrom.blocks} blocks: ${st.columns} interval column${st.columns === 1 ? '' : 's'}, rest line "${st.restLine}", usually ${st.rounds} rounds, blocks about ${st.blockMinutes} min, easy send-off ${fmtClock(st.easyPer100)} per 100${st.roundLongTo5 ? ', long send-offs on :05' : ''}.`);
    const phr = Object.entries(st.phrases || {}).slice(0, 6).map(([g, list]) => `${g}: ${list.slice(0, 3).join(' / ')}`);
    if (phr.length) style.push(`Typical phrasing: ${clip(phr.join('; '), 600)}`);
  }
  push('STYLE', style.length ? style : ['nothing learned yet']);

  // Library excerpt.
  const focuses = slot ? day.sessions.filter((s) => s.slot === slot).map((s) => s.focus) : day.sessions.map((s) => s.focus);
  const lib = relevantBlocks(state.blocks || [], { focuses, slot, weights: learned.weights || {}, max: lim.blocks });
  push(`LIBRARY (${lib.length} of ${(state.blocks || []).length} blocks, most relevant first)`, lib.map((b) => blockText(b, unit, lim.lines)));

  // Recent practices and debriefs.
  const recent = [...(state.log || [])].filter((x) => x.date <= date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0))).slice(0, lim.practices);
  push('RECENT PRACTICES (newest first)', recent.map((x) => recordText(x, lim.practiceChars)));
  const titles = new Map((state.log || []).map((x) => [x.id, x.title || focusName(x.focus)]));
  const debriefs = [...(state.debriefs || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0))).slice(0, 6);
  push('DEBRIEFS (newest first)', debriefs.map((d) => `- ${d.date} ${d.slot || 'AM'}${titles.get(d.practiceId) ? ` (${titles.get(d.practiceId)})` : ''}: ${clip(debriefSummary(d), 700)}`));
  const carry = lib.flatMap((b) => {
    const notes = carryForward(state.debriefs || [], b.id, 2);
    return notes.length ? [`- ${b.name}: ${notes.map((n) => [n.date, n.verdict, n.why && `why: ${clip(n.why, 160)}`, n.changed && `changed: ${clip(n.changed, 160)}`, n.intervals && `intervals ${n.intervals}`, n.times && `times ${clip(n.times, 80)}`].filter(Boolean).join(', ')).join(' | ')}`] : [];
  });
  push('NOTES CARRIED FORWARD (from debriefs, per library block)', carry);

  return `CONTEXT (from the coach's app)\n\n${out.join('\n\n')}`;
}

// ------------------------------------------------------------------ turns

// The turns for one call: the rules and context first (always kept), the
// chat so far (oldest dropped first to stay under `max` characters), then
// the new message.
export function coachTurns(history, message, context, max = TURNS_MAX) {
  const first = { role: 'user', content: `${RULES}\n\n${context || ''}`.trim() };
  const last = { role: 'user', content: String(message ?? '').trim() || '…' };
  const hist = (Array.isArray(history) ? history : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && String(t.content ?? '').trim())
    .map((t) => ({ role: t.role, content: String(t.content) }));
  let size = first.content.length + last.content.length + hist.reduce((s, t) => s + t.content.length, 0);
  while (hist.length && size > max) size -= hist.shift().content.length;
  return [first, ...hist, last];
}

// ------------------------------------------------------------------ reply

const STROKE_WORDS = { fl: 'fly', fly: 'fly', butterfly: 'fly', bk: 'back', back: 'back', backstroke: 'back', br: 'breast', breast: 'breast', breaststroke: 'breast', fr: 'free', free: 'free', freestyle: 'free', im: 'IM', choice: 'choice' };
const CAT_WORDS = { 'warm-up': 'warmup', warmup: 'warmup', 'warm up': 'warmup', 'cool-down': 'cooldown', cooldown: 'cooldown', 'warm-down': 'cooldown', warmdown: 'cooldown', 'warm down': 'cooldown', 'cool down': 'cooldown', drill: 'technique', drills: 'technique', 'race pace': 'race', sprint: 'speed' };

const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map((x) => str(x).trim()).filter(Boolean);
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(str(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// One block from Claude, made safe: wrong types tolerated, categories
// outside CATEGORIES become 'aerobic', a "36 min …" heading in the lines
// becomes the name, gears and measure are read from the lines when missing.
export function coachBlock(raw) {
  if (typeof raw === 'string') raw = { lines: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let lines = (Array.isArray(raw.lines) ? raw.lines : str(raw.lines).split(/\r?\n/)).map((l) => str(l).replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  let name = str(raw.name || raw.title).trim();
  let minutes = num(raw.minutes);
  const head = lines.length ? parseLine(lines[0]) : null;
  if (head?.type === 'heading') {
    lines = lines.slice(1);
    if (!name) name = `${head.minutes} min ${head.title}`.trim();
    if (!minutes) minutes = head.minutes;
  }
  const nameHead = parseLine(name);
  if (!minutes && nameHead.type === 'heading') minutes = nameHead.minutes;
  if (!name && !lines.some((l) => l.trim())) return null;
  const guess = lines.length ? quickBlock(lines.join('\n')) : null;
  const catRaw = str(raw.category).trim().toLowerCase();
  const category = CATEGORIES[catRaw] ? catRaw : CAT_WORDS[catRaw] || 'aerobic';
  const stroke = STROKE_WORDS[str(raw.stroke).trim().toLowerCase()] || (STROKES.includes(raw.stroke) ? raw.stroke : guess?.stroke || 'choice');
  const gears = list(raw.gears).length ? list(raw.gears) : lines.length ? setGears(parseSet(lines.join('\n'))) : [];
  const distance = minutes ? null : num(raw.distance) || guess?.distance || null;
  if (!minutes && !distance) minutes = guess?.minutes || null;
  const session = str(raw.session).toUpperCase();
  const kit = list(raw.equipment).map((e) => e.toLowerCase());
  const block = makeBlock({
    name: name || guess?.name || `${minutes || ''} min ${CATEGORIES[category].label.toLowerCase()}`.trim(),
    category,
    stroke,
    minutes,
    distance,
    intensity: num(raw.intensity) || undefined,
    equipment: kit.length ? kit : guess?.equipment || [],
    detail: str(raw.detail || raw.notes || raw.note),
    gears,
    session: session === 'AM' || session === 'PM' ? session : 'any',
    lines,
    source: 'claude',
  });
  return { ...block, circuit: raw.circuit === true || raw.circuit === 'true' };
}

function extractJSON(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* look inside */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* keep looking */ } }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* not JSON */ } }
  return undefined;
}

// Claude's answer → { reply, practice: null | {title, slot, rounds, pattern, blocks}, blocks }.
export function parseCoachReply(value) {
  let v = value;
  if (typeof v === 'string') {
    const parsed = extractJSON(v);
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return { reply: v.trim(), practice: null, blocks: [] };
    v = parsed;
  }
  if (Array.isArray(v)) v = { blocks: v };
  if (!v || typeof v !== 'object') return { reply: str(v), practice: null, blocks: [] };
  const reply = str(v.reply ?? v.message ?? v.text ?? v.answer).trim();
  const blocks = (Array.isArray(v.blocks) ? v.blocks : v.block ? [v.block] : []).map(coachBlock).filter(Boolean).map(({ circuit, ...b }) => b);
  let practice = null;
  const p = v.practice;
  if (p && typeof p === 'object') {
    const pb = (Array.isArray(p) ? p : Array.isArray(p.blocks) ? p.blocks : []).map(coachBlock).filter(Boolean);
    if (pb.length) {
      const slot = str(p.slot).toUpperCase();
      practice = {
        title: str(p.title).trim(),
        slot: slot === 'PM' ? 'PM' : slot === 'AM' ? 'AM' : null,
        rounds: Math.min(8, Math.max(1, Math.round(num(p.rounds) || 1))),
        pattern: PATTERNS[p.pattern] ? p.pattern : 'even',
        blocks: pb,
      };
    }
  }
  return { reply: reply || (practice ? 'Here it is.' : blocks.length ? `Here ${blocks.length === 1 ? 'is a block' : `are ${blocks.length} blocks`}.` : ''), practice, blocks };
}

// A parsed reply as the JSON Claude was asked for, to keep as the
// assistant's turn in the chat (so "make the main set shorter" can see it).
export function replyContent(r) {
  const block = (b) => ({
    name: b.name, category: b.category, minutes: b.minutes ?? undefined, distance: b.distance ?? undefined, stroke: b.stroke,
    gears: b.gears || [], equipment: b.equipment || [], session: b.session || 'any', circuit: !!b.circuit, lines: b.lines || [],
  });
  return JSON.stringify({
    reply: r?.reply || '',
    practice: r?.practice ? { title: r.practice.title, slot: r.practice.slot || 'AM', rounds: r.practice.rounds, pattern: r.practice.pattern, blocks: r.practice.blocks.map(block) } : null,
    blocks: (r?.blocks || []).map(block),
  });
}

// --------------------------------------------------------------- offline

// Without Claude: a pasted set in the coach's notation becomes a block.
export function offlineReply(message, wctx = null) {
  const text = String(message ?? '');
  const parsed = parseSet(text);
  const swims = parsed.lines.filter((l) => l.type === 'swim').length;
  const words = parsed.lines.filter((l) => l.type === 'text').length;
  if (swims && words <= swims) {
    const block = makeBlock(quickBlock(text, wctx));
    const measure = block.minutes ? `${block.minutes} min` : `${block.distance}${wctx?.unit || 'y'}`;
    return {
      reply: `Saved as a block: ${block.name} (${measure} · ${CATEGORIES[block.category].label.toLowerCase()}${block.gears.length ? ` · ${block.gears.join(' ')}` : ''}).`,
      practice: null,
      blocks: [block],
    };
  }
  return {
    reply: "Claude isn't available on this page, so the coach can't answer here. Open the Claude version of Practice Writer to text the coach. Here you can paste a set in your notation (lines like \"6 x 50 FL, G2 → G5 by 25\") and it's saved as a block.",
    practice: null,
    blocks: [],
  };
}
