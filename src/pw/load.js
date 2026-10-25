// CNS load of saved practices, counted the way the builder counted it when
// the practice was written: the practice put back together from its blocks,
// rounds and round pattern (recordComposed), each circuit round with its
// share of the lines and its gear shift, a block without lines at its
// distance in its first gear (practiceMetrics → composedGearYards). Today's
// Load card, the Week's CNS by day and the coach chat's week (weekTotals,
// whose own count is the same composedGearYards) all agree with recordCns,
// so a practice shows the same points in Build, on Today, on the Week and
// in what the coach is told.

import { addDays, daysBetween, makeBlock, practiceRecord, recordComposed } from '../practice.js';
import { cnsResidual } from '../gears.js';
import { weekTotals } from '../week.js';
import { blockLines, practiceMetrics } from './render.js';

export { recordComposed };

const hourOf = (slot) => (slot === 'PM' ? 16 : 6);

// CNS points of a saved practice (the builder's "CNS load" for it).
export function recordCns(record, ctx) {
  return practiceMetrics(recordComposed(record, ctx.state.plan), ctx, record.slot || 'AM').cns;
}

// The per-record CNS count to hand to weekTotals or coachContext ({ cns }).
export const cnsOf = (ctx) => (record) => recordCns(record, ctx);

// CNS points written each day of a week (weekOf) and what is still left at
// 6:00 each morning from the week's practices and the days before it
// (weekTotals, counting each practice with recordCns). Practices count at
// 6:00 (AM) or 16:00 (PM) of their day.
export function weekCns(week, ctx) {
  const { cnsByDay, cnsMorning } = weekTotals(week, ctx.state.plan, ctx.learned.writing.model, { cns: cnsOf(ctx) });
  return { cnsByDay, cnsMorning };
}

// What is still left before each of `slots` on `date` from the practices of
// the two days before it and that day: [{ slot, left }], and the practices
// counted with their points ({ record, points }, oldest first).
export function cnsBefore(log, date, slots, ctx) {
  const model = ctx.learned.writing.model;
  const origin = addDays(date, -2);
  const at = (d, slot) => daysBetween(origin, d) * 24 + hourOf(slot);
  const recent = log
    .filter((r) => { const age = daysBetween(r.date, date); return age >= 0 && age <= 2; })
    .map((record) => ({ record, at: at(record.date, record.slot || 'AM'), points: recordCns(record, ctx) }))
    .sort((a, b) => a.at - b.at);
  return {
    recent,
    left: slots.map((slot) => {
      const when = at(date, slot);
      return { slot, left: cnsResidual(model, recent.filter((x) => x.at < when), when) };
    }),
  };
}

// The record Build and the Week's drafts save: practiceRecord, plus what is
// needed to read it back as it was printed — the send-offs the app wrote,
// kept as they were printed that day (the coach's own lines stay as
// written), and each block's own measure.
export function savedRecord(ctx, fields) {
  const rec = practiceRecord(fields);
  rec.blocks.forEach((rb, i) => {
    const b = fields.blocks[i];
    if (!b) return;
    if (b.source === 'generated') rb.lines = blockLines(b, ctx, null, fields.slot || 'AM');
    rb.measure = b.minutes ? 'time' : 'distance';
  });
  return rec;
}

// A saved practice's block as a block again (its saved copy, when the
// library no longer has it), in its own measure.
export const savedBlock = (rb) => makeBlock(rb.measure === 'distance' ? { ...rb, minutes: null } : rb);

// A saved practice's block back in the builder: the library block when it
// still exists (its lines as they are now) with the description written for
// that practice, else the saved copy. `missing` when the library lost it.
export function draftBlock(ctx, rb) {
  const lib = ctx.state.blocks.find((x) => x.id === rb.id);
  const base = lib || savedBlock(rb);
  const detail = typeof rb.detail === 'string' ? { detail: rb.detail } : {};
  return { block: { ...base, ...detail, circuit: !!rb.circuit, key: ctx.uid('k') }, missing: !lib };
}
