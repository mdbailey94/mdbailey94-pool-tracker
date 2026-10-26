// CNS load of saved practices, counted the way the builder counted it when
// the practice was written: the practice put back together from its blocks,
// rounds and round pattern, each circuit round with its share of the lines
// and its gear shift, a block without lines at its distance in its first
// gear (recordLoad in week.js). Today's Load card, the Week's CNS by day and
// the coach chat's week all count it this way, so a practice shows the same
// points in Build, on Today, on the Week and in what the coach is told.

import { addDays, makeBlock, planPosition, practiceRecord, recordBlock, retimes } from '../practice.js';
import { ideaVersion, lastVersion } from '../ideas.js';
import { cnsResidual } from '../gears.js';
import { cnsTimeline, recordLoad, slotHour } from '../week.js';
import { blockLines } from './render.js';

// CNS points of a saved practice (the builder's "CNS load" for it).
export const recordCns = (record, ctx) => recordLoad(record, ctx.state.plan, ctx.learned.writing.model).cns;

// What is still left before each of `slots` on `date` from the practices of
// the two days before it and that day: [{ slot, left }], and the practices
// counted with their points ({ record, points }, oldest first). Practices
// count at 6:00 (AM) or 16:00 (PM) of their day.
export function cnsBefore(log, date, slots, ctx) {
  const model = ctx.learned.writing.model;
  const origin = addDays(date, -2);
  const recent = cnsTimeline(log.filter((r) => r.date >= origin && r.date <= date), origin, ctx.state.plan, model);
  return {
    recent,
    left: slots.map((slot) => {
      const when = 2 * 24 + slotHour(slot); // `date` is two days after origin
      return { slot, left: cnsResidual(model, recent.filter((x) => x.at < when), when) };
    }),
  };
}

// The record Build and the Week's drafts save: practiceRecord (each block's
// own measure included), with the send-offs the app wrote kept as they were
// printed that day (the coach's own lines stay as written).
export function savedRecord(ctx, fields) {
  const rec = practiceRecord(fields);
  rec.blocks.forEach((rb, i) => {
    const b = fields.blocks[i];
    if (b && retimes(b)) rb.lines = blockLines(b, ctx, null, fields.slot || 'AM');
  });
  return rec;
}

// A library block as it goes into a practice (draft: { date, slot }): an
// idea written for the day (src/ideas.js), unlike `last` (else the last
// time it was swum); any other block as it is.
export function versionFor(ctx, draft, src, variant = 0, last = null) {
  if (!src?.idea) return src;
  const { plan, log, today } = ctx.state;
  const date = draft.date || today;
  return ideaVersion(src, {
    date, slot: draft.slot || 'AM', phaseName: planPosition(plan, date).phase?.name, variant,
    last: last || lastVersion(log, src.id, date),
  });
}

// A saved practice's block back in the builder: the library block when it
// still exists (its lines as they are now) with the description written for
// that practice, else the saved copy as a library block again (recordBlock,
// then makeBlock: one size, its own measure, and no `printed`, so the
// builder writes its send-offs again). `missing` when the library lost it.
export function draftBlock(ctx, rb) {
  const lib = ctx.state.blocks.find((x) => x.id === rb.id);
  // An idea keeps the version written for that practice.
  const base = lib?.idea ? { ...lib, lines: rb.lines || [], stage: rb.stage || '', printed: true } : lib || makeBlock(recordBlock(rb));
  const detail = typeof rb.detail === 'string' ? { detail: rb.detail } : {};
  return { block: { ...base, ...detail, circuit: !!rb.circuit, key: ctx.uid('k') }, missing: !lib };
}
