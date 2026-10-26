// Idea blocks: a block saved as a concept rather than one fixed set. Its
// description is the mechanism ("fly with socks, mixed in with other
// focuses"), its lines are one way to swim it, and `stages` says what
// changes in each phase of the season ({ M1: 'build up fly volume',
// M2: 'last 25% of the fly without socks', … }, keyed by phase name).
//
// Each time an idea goes into a practice it is written again for that day:
// the reps and distances split differently, rounds counted differently, with
// about the same yards, a different version from the last one swum, and the
// note for the phase the day is in. Send-offs for a changed distance are left
// off so the app writes them for each group (writeLines). Pure.

import { parseLine, writeSwim } from './setlang.js';

// Deterministic jitter: the same day gives the same version, another day (or
// "another version") a different one.
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ----------------------------------------------------------------- stages

export const phaseKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

// { phase name: note } with names and notes trimmed and empty notes dropped.
export function normalStages(stages) {
  const out = {};
  for (const [name, text] of Object.entries(stages && typeof stages === 'object' ? stages : {})) {
    const n = String(name).trim();
    const t = String(text ?? '').trim();
    if (n && t) out[n] = t;
  }
  return out;
}

// The block's note for a phase (matched by name, ignoring case): { phase, text } or null.
export function stageFor(block, phaseName) {
  if (!block?.stages || !phaseName) return null;
  const k = phaseKey(phaseName);
  const hit = Object.entries(block.stages).find(([n]) => phaseKey(n) === k);
  return hit ? { phase: hit[0], text: hit[1] } : null;
}

// "M2: last 25% of the fly without socks".
export const stageText = (s) => (s ? `${s.phase}: ${s.text}` : '');

// What prints under a block's heading: the phase's note, then the
// description (unless the coach hides descriptions: the note still prints).
export const blockNote = (b, withDetail = true) => [b?.stage, withDetail && b?.detail].map((x) => String(x || '').trim()).filter(Boolean).join('\n');

// ---------------------------------------------------------------- versions

const DISTANCES = [25, 50, 75, 100, 150, 200, 300, 400, 500];

// Numbers in the words tie a line to its distance ("G2 → G5 by 25", "last 25
// fast"); a range or odds/evens ties it to its reps ("descend 1-4").
const pinsDistance = (desc) => /\d/.test(String(desc || '').replace(/\bG\d(\.\d)?\b/gi, ''));
const pinsReps = (l) => l.oddsEvens || /\d\s*[-–]\s*\d|\b(odds?|evens?)\b/i.test(l.desc || '');

// The ways to swim a line's yards (times `factor`): [{ reps, distance }],
// the line as written (scaled) first.
function splits(l, factor) {
  const total = l.reps * l.distance * factor;
  const own = { reps: Math.max(1, Math.round(l.reps * factor)), distance: l.distance };
  if (l.at || l.reps < 2 || pinsReps(l)) {
    // A single swim keeps its shape: only a change of rounds scales it.
    return [l.reps < 2 && factor !== 1 ? { reps: 1, distance: Math.max(25, Math.round(total / 25) * 25) } : own];
  }
  const out = [own];
  const dists = pinsDistance(l.desc) ? [l.distance] : DISTANCES.filter((d) => d >= l.distance / 2 && d <= l.distance * 2);
  for (const d of dists) {
    for (const reps of new Set([Math.floor(total / d), Math.ceil(total / d)])) {
      if (reps < 2 || reps > 30) continue;
      if (Math.abs(reps * d - total) > total * 0.15) continue;
      if (!out.some((o) => o.reps === reps && o.distance === d)) out.push({ reps, distance: d });
    }
  }
  return out;
}

// One version of a block's lines, from `rand`.
function writeVersion(lines, rand) {
  let factor = 1; // the current "N rounds" group's change of rounds
  return lines.map((raw) => {
    const l = parseLine(raw);
    const indent = /^\s*/.exec(raw)[0];
    if (l.type === 'rounds') {
      factor = 1;
      if (l.rounds < 2) return raw;
      const options = [l.rounds - 1, l.rounds, l.rounds + 1].filter((n) => n >= 2 && n <= 8);
      const n = options[Math.floor(rand() * options.length)];
      factor = l.rounds / n;
      return n === l.rounds ? raw : raw.replace(/\d+/, String(n));
    }
    if (['blank', 'adjust', 'ref'].includes(l.type)) factor = 1; // a group ends here (structure())
    if (l.type !== 'swim') return raw;
    const options = splits(l, factor);
    // The line as written is one choice among the others.
    const pick = options[Math.floor(rand() * options.length)];
    if (pick.reps === l.reps && pick.distance === l.distance) return raw;
    const line = { ...l, reps: pick.reps, distance: pick.distance };
    return indent + writeSwim(line, pick.distance === l.distance ? l.intervals : []);
  });
}

const sameLines = (a, b) => (a || []).map((x) => String(x).replace(/\s+/g, ' ').trim()).join('\n')
  === (b || []).map((x) => String(x).replace(/\s+/g, ' ').trim()).join('\n');

// An idea block written for a day: its lines in a version unlike `last` (the
// lines it was last swum with) when there is one, and `stage`, the note for
// the day's phase. Not an idea: the block as it is.
export function ideaVersion(block, { date = '', slot = 'AM', phaseName = '', variant = 0, last = null } = {}) {
  if (!block?.idea) return block;
  const stage = stageText(stageFor(block, phaseName));
  const lines = block.lines || [];
  let out = lines;
  for (let i = 0; i < 8; i++) {
    out = writeVersion(lines, rng(hashSeed(`${block.id}|${date}|${slot}|${variant}|${i}`)));
    if (!last || !sameLines(out, last)) break;
  }
  return { ...block, lines: out, stage };
}

// The lines a block was last swum with, from the saved log (newest first).
export function lastVersion(log, blockId, before = null) {
  for (const r of log || []) {
    if (before && r.date > before) continue;
    const b = (r.blocks || []).find((x) => x.id === blockId);
    if (b) return b.lines || [];
  }
  return null;
}
