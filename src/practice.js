// Practice writer: a library of practice "blocks" (e.g. "30 min warm-up",
// "40 min aerobic IM", "500y socks with FL"), a season plan that says what
// each session (AM, and PM on double days) of each phase is for, meets, a
// suggestion engine that picks blocks for a session, and a composer that
// writes the blocks out one after another or blended into a multi-round
// circuit whose rounds can differ. Pure functions, no DOM.

import { gearIndex, shiftGear } from './gears.js';
import { STROKE_ABBR, linesYards, parseSet, setDistance, setSeconds } from './setlang.js';

export { shiftGear };

// ------------------------------------------------------------ vocabulary

export const CATEGORIES = {
  warmup: { label: 'Warm-up', main: false, pace: 1.0, circuit: false },
  aerobic: { label: 'Aerobic', main: true, pace: 1.0, circuit: true },
  threshold: { label: 'Threshold', main: true, pace: 1.1, circuit: false },
  race: { label: 'Race pace', main: true, pace: 1.6, circuit: false },
  speed: { label: 'Speed', main: true, pace: 1.9, circuit: false },
  kick: { label: 'Kick', main: true, pace: 1.4, circuit: true },
  pull: { label: 'Pull', main: true, pace: 1.0, circuit: true },
  technique: { label: 'Drill / technique', main: true, pace: 1.3, circuit: true },
  cooldown: { label: 'Cool-down', main: false, pace: 1.0, circuit: false },
};

// Where a block came from: its label in the library, whether it is the
// coach's own writing (their style is learned from it), and whether its
// send-offs are the app's, written again from the gear chart each time it
// prints. Blocks from the coach chat are Claude's, not the coach's style.
export const SOURCES = {
  coach: { label: 'yours', own: true, retime: false },
  pasted: { label: 'pasted', own: true, retime: false },
  drive: { label: 'imported', own: true, retime: false },
  claude: { label: 'from the coach chat', own: false, retime: false },
  generated: { label: 'written by the app', own: false, retime: true },
};
const sourceOf = (b) => (Object.hasOwn(SOURCES, b?.source ?? '') ? SOURCES[b.source] : null);
export const isOwn = (b) => !!sourceOf(b)?.own;
// A block of a saved practice (`printed`, recordBlock) keeps the send-offs
// printed that day.
export const retimes = (b) => !!sourceOf(b)?.retime && !b.printed;

// What the block writer (generateBlock) writes for a block of a category:
// pull as aerobic work, an IM race-pace block as the IM gears set, every
// other category as itself.
export function writeFocus(category, stroke) {
  if (category === 'race' && stroke === 'IM') return 'im';
  if (category === 'pull') return 'aerobic';
  return CATEGORIES[category] ? category : 'aerobic';
}

export const STROKES = ['choice', 'free', 'back', 'breast', 'fly', 'IM'];
export const STROKE_LABEL = { choice: 'choice', free: 'free', back: 'back', breast: 'breast', fly: 'FL', IM: 'IM' };
// Strokes as written on a set line ("6 x 50 FL"): setlang's table.
export { STROKE_ABBR };
export const EQUIPMENT = ['fins', 'paddles', 'snorkel', 'socks', 'buoy', 'parachute', 'board', 'tempo trainer'];
export const INTENSITY = { 1: 'easy', 2: 'moderate', 3: 'strong', 4: 'hard', 5: 'max' };

// What a session is for, which block categories serve it (weights) and
// which gears it lives in.
export const FOCUSES = {
  aerobic: { label: 'Aerobic', gears: ['G1', 'G2'], weights: { aerobic: 3, pull: 2, kick: 1.5, technique: 1 }, circuit: true },
  threshold: { label: 'Threshold', gears: ['G3'], weights: { threshold: 3, aerobic: 1.5, pull: 1, kick: 1 }, circuit: false },
  race: { label: 'Race pace', gears: ['G4', 'G5'], weights: { race: 3, speed: 1.5, kick: 1, technique: 1 }, circuit: false },
  speed: { label: 'Speed', gears: ['G6'], weights: { speed: 3, technique: 1.5, race: 1, kick: 1 }, circuit: false },
  technique: { label: 'Technique', gears: ['G1', 'G2'], weights: { technique: 3, kick: 2, aerobic: 1.5, pull: 1 }, circuit: true },
  recovery: { label: 'Recovery', gears: ['G1'], weights: { technique: 3, aerobic: 2, kick: 1 }, circuit: true, maxIntensity: 2 },
  rest: { label: 'Rest', gears: [], weights: {}, circuit: false },
};

export const focusLabel = (f) => FOCUSES[f]?.label || f || '';
// The gears a focus lives in: "G1 · G2" (or joined by `sep`).
export const gearsText = (focus, sep = ' · ') => (FOCUSES[focus]?.gears || []).join(sep);

// The gear a block mostly lives in when it doesn't say (for totals by gear).
export const CATEGORY_GEAR = { warmup: 'G1', aerobic: 'G2', threshold: 'G3', race: 'G4', speed: 'G6', kick: 'G2', pull: 'G2', technique: 'G1', cooldown: 'G1' };
const SLOTS = ['AM', 'PM'];

// When tired, swap the planned focus for something that still fits the week.
const EASIER = { threshold: 'aerobic', race: 'technique', speed: 'technique', aerobic: 'recovery', technique: 'recovery', recovery: 'recovery', rest: 'rest' };

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let counter = 0;
export const uid = (p = 'b') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

// ---------------------------------------------------------------- blocks

// A block is either timed (minutes) or measured (distance in the plan's unit).
export function makeBlock(b) {
  const block = {
    id: b.id || uid(),
    name: String(b.name || '').trim(),
    category: CATEGORIES[b.category] ? b.category : 'aerobic',
    stroke: STROKES.includes(b.stroke) ? b.stroke : 'choice',
    minutes: b.minutes > 0 ? Math.round(+b.minutes) : null,
    distance: b.distance > 0 ? Math.round(+b.distance) : null,
    intensity: Math.min(5, Math.max(1, Math.round(+b.intensity) || 2)),
    equipment: (b.equipment || []).filter((e) => EQUIPMENT.includes(e)),
    detail: String(b.detail || '').trim(),
    gears: [...new Set((b.gears || []).map((g) => String(g).toUpperCase()).filter((g) => gearIndex(g) != null))],
    session: SLOTS.includes(b.session) ? b.session : 'any',
    lines: (Array.isArray(b.lines) ? b.lines : String(b.lines || '').split('\n')).map((l) => String(l).replace(/\s+$/, '')).filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1)),
    source: String(b.source || ''),
  };
  if (!block.minutes && !block.distance) block.minutes = 10;
  if (block.minutes && block.distance) block.distance = null; // one measure only
  return block;
}

// Seconds per 100 for this block, including rest: the swimmer's planning pace
// scaled by how much rest the category carries.
function blockPace(block, pace) {
  return pace * (CATEGORIES[block.category]?.pace ?? 1);
}

const roundTo = (v, step) => Math.round(v / step) * step;

// A block's own set lines, parsed, when they hold any swim yards (else null).
function linesSet(block) {
  if (!block.lines?.length) return null;
  const parsed = parseSet(block.lines.join('\n'));
  return setDistance(parsed) > 0 ? parsed : null;
}

// The coach's minutes when the block is timed; else the time its lines take
// the fastest group (lines without a send-off at the planning pace); else an
// estimate from its distance.
export function blockMinutes(block, pace) {
  if (block.minutes) return block.minutes;
  const set = linesSet(block);
  if (set) return Math.max(1, Math.round(setSeconds(set, 0, (l) => (l.distance / 100) * blockPace(block, pace)) / 60));
  return Math.max(1, Math.round((block.distance / 100) * blockPace(block, pace) / 60));
}

// The yards in the block's lines when it has them (as the Blocks preview and
// the gear metrics count them); else its distance; else an estimate from
// its minutes.
export function blockDistance(block, pace) {
  const set = linesSet(block);
  if (set) return setDistance(set);
  if (block.distance) return block.distance;
  return Math.max(50, roundTo((block.minutes * 60) / blockPace(block, pace) * 100, 50));
}

export function measureText(block, unit) {
  return block.minutes ? `${block.minutes} min` : `${block.distance}${unit}`;
}

// Short line for a block as it appears in a written practice.
export function blockLine(block, unit, measure = null) {
  const m = measureText(measure || block, unit);
  const name = block.name.replace(/^\s*\d+(\s*(min|y|yd|m|yards|metres|meters))?\s*/i, '').trim() || block.name;
  return `${m} ${name}`;
}

// Starter library: the three blocks from the brief plus common companions.
export function starterBlocks() {
  return [
    { name: 'Warm-up', category: 'warmup', minutes: 30, intensity: 1, detail: 'Mixed strokes, build the last 200. Include 4×50 drill/swim and 4×25 build.' },
    { name: 'Short warm-up', category: 'warmup', minutes: 15, intensity: 1, detail: '400 swim, 200 kick, 200 drill, 4×50 build.' },
    { name: 'Aerobic IM', category: 'aerobic', stroke: 'IM', minutes: 40, intensity: 2, detail: 'e.g. 4×(100 IM + 4×50 by stroke) on short rest, holding steady effort.' },
    { name: 'Aerobic free', category: 'aerobic', stroke: 'free', minutes: 30, intensity: 2, detail: 'e.g. 3×(300 + 200 + 100) descend each round, :20 rest.' },
    { name: 'Socks with FL', category: 'technique', stroke: 'fly', distance: 500, intensity: 3, equipment: ['socks'], detail: 'Fly with socks on: feel the kick, keep the hips up. 25s and 50s with rest as needed.' },
    { name: 'Kick set', category: 'kick', stroke: 'choice', distance: 800, intensity: 3, equipment: ['board'], detail: 'e.g. 8×100 kick, odds steady, evens last 25 fast.' },
    { name: 'Fins kick', category: 'kick', stroke: 'choice', minutes: 15, intensity: 2, equipment: ['fins'], detail: 'Streamline kick on back / underwater dolphin, 12×25 with :15 rest.' },
    { name: 'Pull with paddles', category: 'pull', stroke: 'free', distance: 1000, intensity: 2, equipment: ['paddles', 'buoy'], detail: 'e.g. 5×200 pull, breathe every 3, hold pace.' },
    { name: 'Snorkel drills', category: 'technique', stroke: 'free', distance: 600, intensity: 1, equipment: ['snorkel'], detail: 'Catch-up, fingertip drag, 6-kick switch; 25 drill / 25 swim.' },
    { name: 'Stroke drills', category: 'technique', stroke: 'choice', minutes: 15, intensity: 1, detail: 'Three drills for the stroke of the day, 25 drill / 25 swim.' },
    { name: 'Threshold 100s', category: 'threshold', stroke: 'free', distance: 1600, intensity: 4, detail: '16×100 on a send-off that leaves :10–:15 rest, holding threshold pace.' },
    { name: 'Threshold 200s', category: 'threshold', stroke: 'choice', distance: 1600, intensity: 4, detail: '8×200 on :20 rest, even pace, last 2 faster.' },
    { name: 'Race pace 50s', category: 'race', stroke: 'choice', distance: 800, intensity: 4, detail: '16×50 at 200 race pace on 1:00–1:15; 100 easy after every 4.' },
    { name: 'Broken swims', category: 'race', stroke: 'choice', distance: 600, intensity: 5, detail: '3×(broken 200: 4×50 on :10 rest) at goal pace, 200 easy between.' },
    { name: 'Sprint 25s', category: 'speed', stroke: 'choice', distance: 400, intensity: 5, detail: '16×25 max from a dive or push, full recovery (1:00+).' },
    { name: 'Parachute sprints', category: 'speed', stroke: 'choice', distance: 300, intensity: 5, equipment: ['parachute'], detail: '12×25 resisted sprint, 1:00 rest.' },
    { name: 'Cool-down', category: 'cooldown', minutes: 8, intensity: 1, detail: 'Easy swim, long strokes, backstroke to finish.' },
  ].map(makeBlock);
}

// ----------------------------------------------------------- season plan

// am / pm: the focus of each weekday's session (Mon..Sun); pm null = no PM.
const PM_DOUBLES = (tue, thu) => [null, tue, null, thu, null, null, null];
export const PHASE_PRESETS = {
  base: { name: 'Base', weeks: 6, volume: 1.0, am: ['aerobic', 'technique', 'aerobic', 'threshold', 'technique', 'aerobic', 'rest'], pm: PM_DOUBLES('aerobic', 'aerobic') },
  build: { name: 'Build', weeks: 7, volume: 1.1, am: ['aerobic', 'threshold', 'technique', 'race', 'aerobic', 'threshold', 'rest'], pm: PM_DOUBLES('aerobic', 'technique') },
  race: { name: 'Race prep', weeks: 5, volume: 0.9, am: ['aerobic', 'race', 'technique', 'speed', 'race', 'aerobic', 'rest'], pm: PM_DOUBLES('technique', 'aerobic') },
  taper: { name: 'Taper', weeks: 2, volume: 0.6, am: ['technique', 'speed', 'recovery', 'race', 'speed', 'recovery', 'rest'], pm: PM_DOUBLES('recovery', null) },
};

export function makePhase(p) {
  const src = p.am || p.days || [];
  const am = Array.from({ length: 7 }, (_, i) => (FOCUSES[src[i]] ? src[i] : 'aerobic'));
  const pm = Array.from({ length: 7 }, (_, i) => (FOCUSES[p.pm?.[i]] ? p.pm[i] : null));
  // Optional targets: share of the week's yards per gear band and kick share.
  const targets = {};
  for (const k of ['aerobic', 'threshold', 'vo2', 'race', 'kick']) {
    const v = +p.targets?.[k];
    if (Number.isFinite(v) && v >= 0 && v <= 1) targets[k] = v;
  }
  return {
    id: p.id || uid('p'),
    name: String(p.name || 'Phase').trim(),
    weeks: Math.max(1, Math.round(+p.weeks) || 1),
    volume: Math.min(2, Math.max(0.2, +p.volume || 1)),
    am,
    pm,
    ...(Object.keys(targets).length ? { targets } : {}),
  };
}

// Minutes in the water per weekday (Mon..Sun): 2 hours every morning but
// Sunday, doubles (PM) on Tuesday and Thursday.
const DEFAULT_WEEK = [
  { am: 120, pm: 0 }, { am: 120, pm: 60 }, { am: 120, pm: 0 }, { am: 120, pm: 60 },
  { am: 120, pm: 0 }, { am: 120, pm: 0 }, { am: 0, pm: 0 },
];

// Each weekday: minutes in the water AM / PM and an optional theme for each
// session in the coach's words ("Speciality workouts", "Test sets").
export function makeWeek(week) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = week?.[i] || {};
    const clamp = (v) => Math.min(300, Math.max(0, Math.round(+v) || 0));
    return { am: clamp(d.am), pm: clamp(d.pm), amTheme: String(d.amTheme || '').trim(), pmTheme: String(d.pmTheme || '').trim() };
  });
}

export function makeMeet(m) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(m.start) ? m.start : todayISO();
  const end = /^\d{4}-\d{2}-\d{2}$/.test(m.end) && m.end >= start ? m.end : start;
  return { id: m.id || uid('m'), name: String(m.name || 'Meet').trim(), start, end, course: String(m.course || ''), note: String(m.note || '') };
}

export function defaultPlan(start = todayISO()) {
  return {
    name: 'Season',
    start: mondayOf(start),
    unit: 'y',
    course: 'SCY',
    pace: 100, // seconds per 100 including rest, used when there is no gear chart
    week: makeWeek(DEFAULT_WEEK),
    phases: ['base', 'build', 'race', 'taper'].map((k) => makePhase(PHASE_PRESETS[k])),
    meets: [],
    preMeet: true,
    groups: [],
    gears: null,
    weeklyYards: null, // a hard week's yards at volume 100% (phases scale it)
  };
}

// Plans saved by older versions (one session a day, phase.days,
// sessionMinutes) become the current shape.
export function migratePlan(saved) {
  const base = defaultPlan(saved?.start || todayISO());
  const plan = { ...base, ...(saved || {}) };
  plan.start = mondayOf(plan.start);
  plan.phases = (saved?.phases || base.phases).map(makePhase);
  if (!saved?.week) {
    const m = saved?.sessionMinutes > 0 ? Math.round(saved.sessionMinutes) : 120;
    plan.week = DEFAULT_WEEK.map((d) => ({ am: d.am ? m : 0, pm: d.pm }));
  }
  plan.week = makeWeek(plan.week);
  plan.meets = (plan.meets || []).map(makeMeet).sort((a, b) => (a.start < b.start ? -1 : 1));
  plan.groups = Array.isArray(plan.groups) ? plan.groups : [];
  plan.preMeet = plan.preMeet !== false;
  delete plan.sessionMinutes;
  return plan;
}

export const planWeeks = (plan) => plan.phases.reduce((n, p) => n + p.weeks, 0);

// -- dates: ISO 'YYYY-MM-DD' strings in local time, Monday-first weeks.

export function todayISO(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export const weekdayIndex = (iso) => (parseISO(iso).getDay() + 6) % 7; // Mon = 0

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

export const mondayOf = (iso) => addDays(iso, -weekdayIndex(iso));

export const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

// Where a date falls in the plan.
export function planPosition(plan, date) {
  const start = mondayOf(plan.start);
  const week = Math.floor(daysBetween(start, date) / 7); // 0-based season week
  const weekday = weekdayIndex(date);
  const total = planWeeks(plan);
  if (!plan.phases.length) return { status: 'empty', week, weekday, total, focus: 'aerobic' };
  if (week < 0) {
    return { status: 'before', week, weekday, total, phase: plan.phases[0], phaseIndex: 0, phaseWeek: 0, focus: plan.phases[0].am[weekday], daysToStart: -daysBetween(start, date) };
  }
  if (week >= total) {
    const last = plan.phases[plan.phases.length - 1];
    return { status: 'after', week, weekday, total, phase: last, phaseIndex: plan.phases.length - 1, phaseWeek: last.weeks - 1, focus: weekday === 6 ? 'rest' : 'recovery' };
  }
  let w = week;
  for (let i = 0; i < plan.phases.length; i++) {
    const p = plan.phases[i];
    if (w < p.weeks) return { status: 'in', week, weekday, total, phase: p, phaseIndex: i, phaseWeek: w, focus: p.am[weekday] };
    w -= p.weeks;
  }
  return { status: 'empty', week, weekday, total, focus: 'aerobic' };
}

// The meet on a date, if any (inclusive of both ends).
const meetOn = (plan, date) => (plan.meets || []).find((m) => m.start <= date && date <= m.end) || null;

// The first meet not over by `date` (plan.meets are kept in start order).
export function nextMeet(plan, date) {
  return (plan.meets || []).find((m) => m.end >= date) || null;
}

// The sessions on a date: AM (and PM on double days) with their focus and
// length, or none on a meet or rest day. The day before a meet keeps one
// short sharpening session when plan.preMeet is on.
export function sessionsOn(plan, date) {
  const pos = planPosition(plan, date);
  const meet = meetOn(plan, date);
  const out = { date, position: pos, meet, preMeet: false, sessions: [] };
  if (meet) return out;
  const week = plan.week || DEFAULT_WEEK;
  const day = week[pos.weekday] || { am: 0, pm: 0 };
  const vol = pos.phase?.volume ?? 1;
  const pmFocus = pos.status === 'after' ? null : pos.phase?.pm?.[pos.weekday] ?? null;
  const want = [['AM', day.am, pos.focus, day.amTheme], ['PM', day.pm, pmFocus, day.pmTheme]];
  for (const [slot, minutes, focus, theme] of want) {
    if (!minutes || !focus || focus === 'rest') continue;
    out.sessions.push({ slot, minutes: Math.max(20, Math.round(minutes * vol)), focus, volume: vol, theme: theme || '' });
  }
  const tomorrow = addDays(date, 1);
  if (plan.preMeet !== false && out.sessions.length && meetOn(plan, tomorrow) && !meetOn(plan, date)) {
    const first = out.sessions[0];
    out.preMeet = true;
    out.sessions = [{ ...first, focus: 'speed', minutes: Math.max(30, Math.round(first.minutes * 0.6)), volume: 0.6, note: `Sharpen for ${meetOn(plan, tomorrow).name}` }];
  }
  return out;
}

// ----------------------------------------------------------- suggestions

// Deterministic jitter so a day's suggestion is stable, and "another one"
// (variant) gives a different but repeatable answer.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Days since each block was last swum, from the saved log.
export function recencyMap(history, date) {
  const map = {};
  for (const h of history) {
    const age = daysBetween(h.date, date);
    if (age < 0) continue;
    for (const b of h.blocks || []) {
      if (!(b.id in map) || age < map[b.id]) map[b.id] = age;
    }
  }
  return map;
}

// Pick blocks for one day.
//   plan, library, date       what we have and when
//   history                   saved practices (for variety)
//   minutes                   time available (defaults to the plan's session scaled by the phase)
//   feeling                   'fresh' | 'normal' | 'tired'
//   equipment                 list available today, or null for everything
//   focus                     override the plan's focus for the day
//   variant                   0, 1, 2… for alternative suggestions
//   slot                      'AM' | 'PM' (defaults to the first session of the day)
//   weights                   { blockId: multiplier } learned from debriefs
export function suggestPractice({ plan, library, date = todayISO(), history = [], minutes = null, feeling = 'normal', equipment = null, focus = null, variant = 0, slot = null, weights = {} }) {
  const day = sessionsOn(plan, date);
  const pos = day.position;
  const session = day.sessions.find((x) => x.slot === slot) || (slot ? null : day.sessions[0]) || null;
  const theSlot = session?.slot || slot || 'AM';
  let dayFocus = focus || session?.focus || (day.meet ? 'rest' : slot === 'PM' ? 'rest' : pos.focus) || 'aerobic';
  const planned = dayFocus;
  if (feeling === 'tired' && !focus) dayFocus = EASIER[dayFocus] || dayFocus;
  const fallbackMinutes = (plan.week?.[pos.weekday]?.[theSlot.toLowerCase()] || 120) * (pos.phase?.volume ?? 1);
  const budget = Math.max(20, Math.round(minutes || session?.minutes || fallbackMinutes));
  const result = { date, slot: theSlot, position: pos, meet: day.meet, preMeet: day.preMeet, focus: dayFocus, plannedFocus: planned, minutes: budget, blocks: [], rounds: 1, pattern: 'even', notes: [] };
  if (session?.note) result.notes.push(session.note);

  if (dayFocus === 'rest') {
    result.notes.push(day.meet ? `Meet day: ${day.meet.name}.` : 'No session in the plan. If you want to swim anyway, ask for an easy recovery swim.');
    return result;
  }
  if (!library.length) {
    result.notes.push('Add some blocks to the library first.');
    return result;
  }

  const rand = rng(hashSeed(`${date}|${variant}|${dayFocus}`));
  const spec = FOCUSES[dayFocus];
  const recency = recencyMap(history, date);
  const usable = library
    .filter((b) => !equipment || b.equipment.every((e) => equipment.includes(e)))
    .filter((b) => !b.session || b.session === 'any' || b.session === theSlot);
  const focusGears = spec.gears || [];
  const { pace } = plan;

  // Warm-up: the one closest to ~30 % of the session (shorter sessions, shorter warm-up).
  const warmups = usable.filter((b) => b.category === 'warmup');
  const wantWarm = Math.round(budget * 0.3);
  const warm = warmups.sort((a, b) => Math.abs(blockMinutes(a, pace) - wantWarm) - Math.abs(blockMinutes(b, pace) - wantWarm))[0];
  const cools = usable.filter((b) => b.category === 'cooldown').sort((a, b) => blockMinutes(a, pace) - blockMinutes(b, pace));
  const cool = cools[0];

  let remaining = budget - (warm ? blockMinutes(warm, pace) : 0) - (cool ? blockMinutes(cool, pace) : 0);

  // Main set: score, then fill greedily. Variants rotate the top choices.
  const scored = usable
    .filter((b) => CATEGORIES[b.category].main && (spec.weights[b.category] || 0) > 0)
    .filter((b) => !spec.maxIntensity || b.intensity <= spec.maxIntensity)
    .map((b) => {
      const age = recency[b.id] ?? 30;
      const fresh = Math.min(1, age / 10); // 0 = swum today, 1 = ≥10 days ago
      const gearFit = b.gears?.some((g) => focusGears.includes(g.replace(/\.\d$/, ''))) ? 1.25 : 1;
      const learned = Number.isFinite(weights[b.id]) ? weights[b.id] : 1;
      const score = spec.weights[b.category] * gearFit * learned * (0.4 + 0.6 * fresh) * (0.85 + 0.3 * rand());
      return { b, score };
    })
    .sort((x, y) => y.score - x.score);
  for (let i = 0; i < variant && scored.length > 1; i++) scored.push(scored.shift());

  const main = [];
  const usedCats = {};
  for (const { b } of scored) {
    const m = blockMinutes(b, pace);
    if (m > remaining * 1.15) continue;
    if ((usedCats[b.category] || 0) >= 2) continue;
    main.push(b);
    usedCats[b.category] = (usedCats[b.category] || 0) + 1;
    remaining -= m;
    if (remaining < 8) break;
  }
  // Lead with the day's category, keep the hardest work before the technique.
  main.sort((a, b) => (spec.weights[b.category] - spec.weights[a.category]) || (b.intensity - a.intensity));

  result.blocks = [warm, ...main, cool].filter(Boolean).map((b) => ({ ...b, circuit: false }));
  if (!main.length) result.notes.push(`No ${FOCUSES[dayFocus].label.toLowerCase()} blocks fit in ${budget} minutes; add shorter ones or allow more time.`);

  // Blend the main set into a circuit on aerobic/technique days when the
  // blocks suit it (steady work rather than precise intervals).
  const blendable = main.filter((b) => CATEGORIES[b.category].circuit);
  if (spec.circuit && blendable.length >= 2) {
    const total = blendable.reduce((n, b) => n + blockMinutes(b, pace), 0);
    result.rounds = Math.min(4, Math.max(2, Math.round(total / 15)));
    const ids = new Set(blendable.map((b) => b.id));
    for (const b of result.blocks) if (ids.has(b.id)) b.circuit = true;
  }
  if (feeling === 'tired' && dayFocus !== planned) result.notes.push(`Planned ${FOCUSES[planned].label.toLowerCase()} day eased to ${FOCUSES[dayFocus].label.toLowerCase()} because you're tired.`);
  if (feeling === 'fresh' && ['aerobic', 'technique'].includes(dayFocus) && pos.status === 'in') result.notes.push('Feeling fresh: finish the main set with a few fast 25s if it suits.');
  return result;
}

// ------------------------------------------------------------ composition

// Split `total` into n parts that are multiples of `step`, as even as
// possible, larger parts first: splitEven(500, 3, 25) → [175, 175, 150].
export function splitEven(total, n, step = 1) {
  return splitByWeights(total, Array(n).fill(1), step);
}

// Split `total` in proportion to `weights`, in multiples of `step`, every
// share at least one step, summing exactly to `total` when it is a multiple
// of `step` (largest remainders get the leftover steps, earlier first).
export function splitByWeights(total, weights, step = 1) {
  const n = weights.length;
  if (!n) return [];
  const units = Math.max(n, Math.round(total / step));
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0) || n;
  const exact = weights.map((w) => (Math.max(0, w) || (sum === n ? 1 : 0)) / sum * units);
  const base = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = units - base.reduce((a, b) => a + b, 0);
  // A share already raised to the one-step minimum gets no leftover step, so
  // a smaller weight never ends up with a larger share.
  const order = exact.map((x, i) => ({ i, r: Math.floor(x) < 1 ? -1 : x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) base[order[k].i]++;
  for (let k = n - 1; left < 0 && k >= 0; k--) {
    const i = order[k].i;
    while (left < 0 && base[i] > 1) { base[i]--; left++; }
  }
  return base.map((u) => u * step);
}

// How the rounds of a circuit differ.
export const PATTERNS = {
  even: { label: 'Even rounds' },
  descend: { label: 'Descending distance' },
  ascend: { label: 'Ascending distance' },
  build: { label: 'Build a gear each round' },
  'hard-last': { label: 'Hard last round' },
};

// Per round: the share of each block (weight), how many gears faster than
// written (gearShift) and a note.
export function roundPlan(pattern, n) {
  const rounds = Array.from({ length: n }, (_, i) => ({ weight: 1, gearShift: 0, note: '' }));
  if (pattern === 'descend') rounds.forEach((r, i) => { r.weight = n - i; });
  if (pattern === 'ascend') rounds.forEach((r, i) => { r.weight = i + 1; });
  if (pattern === 'build') rounds.forEach((r, i) => { r.gearShift = i; if (i) r.note = `+${i} gear${i > 1 ? 's' : ''}`; });
  if (pattern === 'hard-last' && n > 1) { rounds[n - 1].gearShift = 2; rounds[n - 1].note = 'fast'; }
  return rounds;
}

// Write the chosen blocks out. Blocks marked `circuit` are blended into one
// multi-round circuit placed where the first of them sits; the rest stay as
// separate sets in order. `pattern` sets how the rounds differ.
export function composePractice({ blocks, rounds = 1, pattern = 'even', pace = 100, unit = 'y' }) {
  const sections = [];
  const circuitBlocks = blocks.filter((b) => b.circuit);
  const n = circuitBlocks.length >= 1 ? Math.max(1, Math.round(rounds)) : 1;
  const pat = PATTERNS[pattern] ? pattern : 'even';
  const plan = roundPlan(pat, n);
  const weights = plan.map((r) => r.weight);
  let placed = false;
  for (const b of blocks) {
    if (b.circuit) {
      if (placed) continue;
      placed = true;
      const items = circuitBlocks.map((cb) => {
        const minutes = blockMinutes(cb, pace);
        const distance = blockDistance(cb, pace);
        // A timed block shares out its minutes, a measured one its yards.
        const whole = cb.minutes || distance;
        const parts = cb.minutes ? splitByWeights(cb.minutes, weights, 1) : splitByWeights(distance, weights, 25);
        const shares = parts.map((v, i) => ({
          ...(cb.minutes ? { minutes: v } : { distance: v }),
          gearShift: plan[i].gearShift,
          note: plan[i].note,
          scale: v / whole, // this round's share of the block's own lines
        }));
        return { block: cb, shares, minutes, distance };
      });
      sections.push({
        type: 'circuit',
        rounds: n,
        pattern: pat,
        plan,
        items,
        minutes: items.reduce((s2, it) => s2 + it.minutes, 0),
        distance: items.reduce((s2, it) => s2 + it.distance, 0),
      });
    } else {
      sections.push({ type: 'block', block: b, minutes: blockMinutes(b, pace), distance: blockDistance(b, pace) });
    }
  }
  return {
    unit,
    pattern: pat,
    sections,
    minutes: sections.reduce((s2, x) => s2 + x.minutes, 0),
    distance: sections.reduce((s2, x) => s2 + x.distance, 0),
  };
}

// How much of a block's own lines one round of a circuit prints: its share's
// scale, or all of them when that is within 1%.
export const shareScale = (share) => (share?.scale && Math.abs(share.scale - 1) > 0.01 ? share.scale : 1);

// Yards per gear and kick yards of a composed practice, as the builder counts
// its CNS load: each block's lines (in a circuit, each round's share of them
// with the round's gear shift and scaled reps), or for a block without swim
// lines its distance (its round's share of it) in its first gear, else its
// category's, shifted with the round as its lines would be (all kick for a
// kick block). → { byGear, kick }
export function composedYards(composed) {
  const byGear = {};
  let kick = 0;
  const add = (g, y) => { if (y > 0) byGear[g] = (byGear[g] || 0) + y; };
  const part = (block, distance, share = null) => {
    const shift = share?.gearShift || 0;
    if (linesSet(block)) {
      const y = linesYards(block.lines, { gearShift: shift, scale: shareScale(share) });
      for (const [g, v] of Object.entries(y.byGear)) add(g, v);
      kick += y.kick;
    } else if (distance > 0) {
      add(shiftGear(block.gears?.[0] || CATEGORY_GEAR[block.category] || 'G2', shift), Math.round(distance));
      if (block.category === 'kick') kick += Math.round(distance);
    }
  };
  for (const s2 of composed.sections) {
    if (s2.type === 'block') part(s2.block, s2.distance);
    else s2.items.forEach((it) => it.shares.forEach((sh) => part(it.block, sh.distance ?? it.distance * (sh.scale ?? 1), sh)));
  }
  return { byGear, kick: Math.round(kick) };
}

// Yards per gear of a composed practice (composedYards).
export const composedGearYards = (composed) => composedYards(composed).byGear;

// A saved practice's block as a block again (makeBlock), with what its
// record keeps: the sizes it was saved with (records keep both, a v1 record
// neither), in the block's own measure (`measure`; a record saved before it
// reads as timed), whether it was in the circuit, and `printed`: its lines
// are the ones printed that day, so their send-offs are never re-timed.
export function recordBlock(rb) {
  return { ...makeBlock(rb), minutes: rb.measure === 'distance' ? null : rb.minutes, distance: rb.distance, circuit: !!rb.circuit, printed: true };
}

// A saved practice composed again as the builder composed it (rounds, round
// pattern, each block's share of the rounds): a block measured in yards
// shares out its yards, a timed one its minutes.
export function recordComposed(record, plan = {}) {
  return composePractice({ blocks: (record.blocks || []).map(recordBlock), rounds: record.rounds || 1, pattern: record.pattern || 'even', pace: plan.pace || 100, unit: record.unit || plan.unit || 'y' });
}

const NUMBER = new Intl.NumberFormat('en-US');
export const fmtDistance = (d, unit) => `${NUMBER.format(Math.round(d))}${unit}`;

// Per-round text for a circuit item: "175y socks with FL",
// "175y socks with FL (last round 150y)", "300 / 200 / 100y socks with FL",
// "200y kick (G2 → G3 → G4 by round)".
export function shareLine(item, unit) {
  const first = item.shares[0];
  const texts = item.shares.map((s2) => measureText(s2, unit));
  const same = texts.every((t) => t === texts[0]);
  let line = blockLine(item.block, unit, first);
  if (!same) {
    const diff = texts.map((t, i) => ({ t, i })).filter(({ t }) => t !== texts[0]);
    const lastOnly = diff.length === 1 && diff[0].i === texts.length - 1;
    const monotonic = texts.length > 2 && item.shares.every((s2, i) => i === 0 || (s2.minutes ?? s2.distance) !== (item.shares[i - 1].minutes ?? item.shares[i - 1].distance));
    if (lastOnly) line = `${line} (last round ${diff[0].t})`;
    else if (monotonic) {
      const vals = item.shares.map((s2) => s2.minutes ?? s2.distance);
      line = blockLine(item.block, unit, first).replace(measureText(first, unit), `${vals.join(' / ')}${first.minutes ? ' min' : unit}`);
    } else line = `${line} (rounds: ${texts.join(', ')})`;
  }
  const shifts = item.shares.map((s2) => s2.gearShift || 0);
  if (shifts.some((g) => g)) {
    const gears = item.block.gears || [];
    if (gears.length && shifts.every((g, i) => g === i)) line += ` (${shifts.map((g) => shiftGear(gears[0], g)).join(' → ')} by round)`;
    else if (shifts.every((g, i) => i === shifts.length - 1 ? g > 0 : g === 0)) line += ` (last round${gears.length ? ` ${shiftGear(gears[0], shifts.at(-1))}` : ''} fast)`;
    else line += ` (gears: ${shifts.map((g) => `+${g}`).join(', ')})`;
  }
  return line;
}

// Plain text of a practice, for copying or printing. `renderLines(block,
// share)` may return the set lines to print under a block (with interval
// columns); by default a block's own lines are printed as written.
export function practiceText(composed, { title = '', date = '', focus = '', phase = '', slot = '', showDetail = true, renderLines = null } = {}) {
  const { unit } = composed;
  const out = [];
  const head = [title, date && longDate(date), slot, phase, focus && `${FOCUSES[focus]?.label || focus}`].filter(Boolean).join(' · ');
  if (head) out.push(head, '');
  const linesOf = (block, share, indent) => {
    const lines = renderLines ? renderLines(block, share) : block.lines || [];
    return lines.map((l) => `${indent}${l}`);
  };
  composed.sections.forEach((s2) => {
    if (s2.type === 'block') {
      out.push(`${blockLine(s2.block, unit)}${s2.block.stroke !== 'choice' && !/\b(IM|FL|FR|BK|BR|free|back|breast|fly)\b/i.test(s2.block.name) ? ` (${STROKE_LABEL[s2.block.stroke]})` : ''}${s2.block.equipment.length ? ` — ${s2.block.equipment.join(', ')}` : ''}`);
      out.push(...linesOf(s2.block, null, '    '));
      if (showDetail && s2.block.detail) out.push(`    ${s2.block.detail}`);
    } else {
      out.push(`${s2.rounds} round${s2.rounds === 1 ? '' : 's'} of:${s2.pattern && s2.pattern !== 'even' ? ` (${PATTERNS[s2.pattern].label.toLowerCase()})` : ''}`);
      s2.items.forEach((it) => {
        out.push(`  • ${shareLine(it, unit)}${it.block.equipment.length ? ` — ${it.block.equipment.join(', ')}` : ''}`);
        out.push(...linesOf(it.block, it.shares[0], '      '));
        if (showDetail && it.block.detail) out.push(`      ${it.block.detail}`);
      });
    }
  });
  out.push('', `Total ≈ ${composed.minutes} min · ~${fmtDistance(composed.distance, unit)}`);
  return out.join('\n');
}

const LONG_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

// "Tuesday, Oct 27" (in the device's language).
export const longDate = (iso) => LONG_DATE.format(parseISO(iso));

// "Tue Oct 27".
export const dayLabel = (iso) => `${WEEKDAYS[weekdayIndex(iso)]} ${SHORT_DATE.format(parseISO(iso))}`;

// Record for the log (what the suggestion engine reads back for variety, and
// what a debrief walks through section by section). Each block keeps both
// its sizes in the practice and `measure`, the one that was its own.
export function practiceRecord({ date, title, focus, slot = 'AM', position, blocks, rounds, pattern = 'even', composed, text }) {
  const sizes = new Map();
  composed.sections.forEach((s2) => {
    if (s2.type === 'block') sizes.set(s2.block, s2);
    else s2.items.forEach((it) => sizes.set(it.block, it));
  });
  return {
    id: uid('s'),
    createdAt: Date.now(),
    date,
    slot,
    title: title || '',
    focus,
    phase: position?.phase?.name || '',
    week: position?.week ?? null,
    rounds,
    pattern,
    blocks: blocks.map((b) => ({
      id: b.id, name: b.name, category: b.category, stroke: b.stroke, circuit: !!b.circuit,
      gears: b.gears || [], lines: b.lines || [], source: b.source || '',
      detail: b.detail || '', equipment: b.equipment || [],
      minutes: sizes.get(b)?.minutes ?? null, distance: sizes.get(b)?.distance ?? null,
      measure: b.minutes ? 'time' : 'distance',
    })),
    minutes: composed.minutes,
    distance: composed.distance,
    unit: composed.unit,
    text,
  };
}

// Totals for the last `days` days of the log.
export function logSummary(history, date, days = 7) {
  const recent = history.filter((h) => { const a = daysBetween(h.date, date); return a >= 0 && a < days; });
  return {
    sessions: recent.length,
    minutes: recent.reduce((s2, h) => s2 + (h.minutes || 0), 0),
    distance: recent.reduce((s2, h) => s2 + (h.distance || 0), 0),
  };
}

// Newest first: by date, then the one saved last (the order the app keeps
// the log and the debriefs in).
export const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));

// What a saved practice is called: its title, else its main blocks (up to
// three), else its focus.
export function recordTitle(r) {
  if (r?.title) return r.title;
  const main = (r?.blocks || []).filter((b) => CATEGORIES[b.category]?.main !== false).map((b) => b.name).filter(Boolean);
  if (main.length) return main.slice(0, 3).join(', ') + (main.length > 3 ? '…' : '');
  return focusLabel(r?.focus) || 'Practice';
}

// Where a date falls in the season (planPosition), in words, as each screen
// says it. `detail`: 'phase' (Today) "Base · week 2 of 6"; 'season' (the
// Season tab) "Now: Base · week 2 of 6 · season week 8"; 'context' (what the
// coach chat is told) "Base · week 2 of 6 · season week 8 of 20"; 'week'
// (the Week) that and the phase's volume.
export function positionText(pos, { detail = 'phase' } = {}) {
  if (!pos) return '';
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (pos.status === 'before') return detail === 'week' ? `Before the season · it starts in ${days(pos.daysToStart)}` : `Season starts in ${days(pos.daysToStart)}`;
  if (pos.status === 'after') return detail === 'week' ? 'After the season · off-season' : detail === 'context' ? 'Season finished (off-season)' : 'Season finished · off-season';
  if (pos.status === 'empty') return detail === 'context' ? 'No phases in the plan' : 'No phases in the plan yet';
  const phase = `${pos.phase.name} · week ${pos.phaseWeek + 1} of ${pos.phase.weeks}`;
  if (detail === 'season') return `Now: ${phase} · season week ${pos.week + 1}`;
  if (detail === 'context') return `${phase} · season week ${pos.week + 1} of ${pos.total}`;
  if (detail === 'week') return `${phase} · season week ${pos.week + 1} of ${pos.total} · volume ${Math.round((pos.phase.volume || 0) * 100)}%`;
  return phase;
}
