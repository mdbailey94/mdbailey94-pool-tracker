// Shared rendering of blocks and practices: set lines with group interval
// columns, circuits with differing rounds, notes from past debriefs, and the
// totals (time, distance, CNS load) for a practice.

import { blockLine, composedGearYards, FOCUSES, fmtDistance, PATTERNS, practiceText, shareLine, shareScale, STROKE_LABEL } from '../practice.js';
import { cnsPoints } from '../gears.js';
import { carryForward, VERDICTS } from '../learn.js';
import { blockSecondsByGroup, groupAdjustments, isAdjustment, parseLine, parseSet, writeLines } from '../setlang.js';
import { esc } from './ui.js';

// Lines of a block ready to print for a share of a circuit (gear shift,
// scaled reps) with send-offs filled in from the gear chart and style.
// Blocks the app wrote are re-timed every time, so their send-offs follow
// the groups, style and debriefs as they are now (the coach's stay as written).
// A share with scaled reps gets its group adjustments written again for the
// reps it prints (the block's own were for its full reps).
export function blockLines(block, ctx, share = null, slot = 'AM') {
  if (!block.lines?.length) return [];
  const wctx = ctx.learned.writing;
  const scale = shareScale(share);
  const out = writeLines(block.lines, wctx, {
    gearShift: share?.gearShift || 0,
    scale,
    single: slot === 'PM',
    retimeAll: block.source === 'generated',
  });
  const groups = wctx.groups || [];
  if (scale === 1 || !out.some((raw) => isAdjustment(raw, groups))) return out;
  const lines = out.filter((raw) => !isAdjustment(raw, groups));
  while (lines.length && !String(lines.at(-1)).trim()) lines.pop();
  if (slot === 'PM') return lines;
  const fastest = blockSecondsByGroup(lines, wctx)[0];
  return [...lines, ...groupAdjustments(lines, wctx, Math.max(1, Math.round(fastest / 60)))];
}

// A circuit item's lines: one listing when every round is the same, else
// one per round ("RD1", "RD2", …).
export function circuitLines(item, ctx, slot = 'AM') {
  const sig = (sh) => `${Math.round((sh.scale || 1) * 100)}|${sh.gearShift || 0}`;
  const same = item.shares.every((sh) => sig(sh) === sig(item.shares[0]));
  if (same) return blockLines(item.block, ctx, item.shares[0], slot);
  return item.shares.flatMap((sh, i) => {
    const lines = blockLines(item.block, ctx, sh, slot);
    return lines.length ? [`RD${i + 1}${sh.note ? ` (${sh.note})` : ''}:`, ...lines] : [];
  });
}

// Set lines as HTML rows: description left, send-off columns right. Only a
// first line reads as a "36 min …" heading; later ones are timed work.
export function linesHTML(lines) {
  if (!lines?.length) return '';
  const typed = parseSet(lines.join('\n')).lines;
  const aligned = typed.length === lines.length;
  return `<div class="setlines">${lines.map((raw, i) => {
    const l = aligned ? typed[i] : parseLine(raw);
    if (l.type === 'blank') return '';
    if (l.type === 'swim') {
      const iv = /\s{2,}((?::\d\d|\d+:\d\d)(?:\s*\|\s*(?::\d\d|\d+:\d\d))*)\s*$/.exec(raw);
      const left = iv ? raw.slice(0, iv.index) : raw;
      return `<div class="setline"><span>${esc(left.trim())}</span><span class="iv">${esc(iv ? iv[1].replace(/\s*\|\s*/g, ' | ') : '')}</span></div>`;
    }
    const cls = { ref: 'ref', rounds: 'rounds', rest: 'rest', adjust: 'adjust', note: 'note', heading: 'rounds' }[l.type] || '';
    return `<div class="setline ${cls}"><span>${esc(String(raw).trim())}</span><span></span></div>`;
  }).join('')}</div>`;
}

// Totals for a composed practice: minutes, distance, yards by gear and CNS.
// The yards are those of the lines blockLines prints for each block and
// circuit round (gear shifts and scaled reps; send-offs don't change them),
// and a block without set lines counts its distance (its round's share) in
// its first gear (composedGearYards, which the Week and the coach chat use
// too), so a starter block is not free.
export function practiceMetrics(composed, ctx, slot = 'AM') {
  const byGear = composedGearYards(composed);
  return { minutes: composed.minutes, distance: composed.distance, byGear, cns: cnsPoints(ctx.learned.writing.model, byGear) };
}

function carryHTML(ctx, blockId) {
  const notes = carryForward(ctx.state.debriefs, blockId, 2);
  if (!notes.length) return '';
  return notes.map((n) => `<div class="carry"><b>${esc(n.date)}${n.verdict ? ` · ${esc(VERDICTS[n.verdict])}` : ''}</b>${n.why ? ` — ${esc(n.why)}` : ''}${n.changed ? `<br>Changed: ${esc(n.changed)}` : ''}</div>`).join('');
}

const kit = (b) => (b.equipment?.length ? ` · ${b.equipment.join(', ')}` : '');
const strokeTag = (b) => (b.stroke && b.stroke !== 'choice' ? ` · ${STROKE_LABEL[b.stroke]}` : '');

// A composed practice as HTML.
export function practiceHTML(composed, ctx, { showDetail = true, slot = 'AM', carry = true } = {}) {
  const { unit } = composed;
  const m = practiceMetrics(composed, ctx, slot);
  return `<div class="practice">
    ${composed.sections.map((s) => (s.type === 'block' ? `
      <div class="set">
        <div class="line">${esc(blockLine(s.block, unit))}<span>${s.block.minutes ? `~${fmtDistance(s.distance, unit)}` : `~${s.minutes} min`}${esc(strokeTag(s.block))}${esc(kit(s.block))}</span></div>
        ${linesHTML(blockLines(s.block, ctx, null, slot))}
        ${showDetail && s.block.detail ? `<p class="detail">${esc(s.block.detail)}</p>` : ''}
        ${carry ? carryHTML(ctx, s.block.id) : ''}
      </div>` : `
      <div class="set">
        <div class="line"><span class="round-head">${s.rounds} round${s.rounds === 1 ? '' : 's'} of${s.pattern !== 'even' ? ` · ${esc(PATTERNS[s.pattern].label.toLowerCase())}` : ''}</span><span>~${s.minutes} min · ~${fmtDistance(s.distance, unit)}</span></div>
        <ul>${s.items.map((it) => `<li><div>${esc(shareLine(it, unit))}<span class="muted small">${esc(strokeTag(it.block))}${esc(kit(it.block))}</span></div>
          ${linesHTML(circuitLines(it, ctx, slot))}
          ${showDetail && it.block.detail ? `<p class="detail">${esc(it.block.detail)}</p>` : ''}
          ${carry ? carryHTML(ctx, it.block.id) : ''}</li>`).join('')}</ul>
      </div>`)).join('')}
    <div class="totals"><span>Total</span><span>≈ ${composed.minutes} min · ~${fmtDistance(composed.distance, unit)}</span></div>
    <div class="metrics"><span>CNS load <b>${m.cns}</b></span>${Object.entries(m.byGear).sort().map(([g, y]) => `<span>${esc(g)} <b>${fmtDistance(y, unit)}</b></span>`).join('')}</div>
  </div>`;
}

// Plain text with the same lines (for copying and the log).
export function practiceTextFor(composed, ctx, meta = {}) {
  const items = new Map();
  composed.sections.forEach((s) => s.type === 'circuit' && s.items.forEach((it) => items.set(it.block, it)));
  return practiceText(composed, { ...meta, renderLines: (block, share) => (items.has(block) ? circuitLines(items.get(block), ctx, meta.slot || 'AM') : blockLines(block, ctx, share, meta.slot || 'AM')) });
}

export const focusLabel = (f) => FOCUSES[f]?.label || f || '';
