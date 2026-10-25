// Asking before the coach's work is thrown away: the practice being built
// (state.draft) and a debrief being filled in (state.debriefing). Today, the
// Coach chat, the Week and the Log all go through these, so none of them can
// replace either one without asking.

import { WEEKDAYS, parseISO } from '../practice.js';
import { debriefFor, sectionTouched } from '../learn.js';

const dayLabel = (iso) => {
  const d = parseISO(iso);
  return `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
};

// The builder's draft is in the log as it stands (saved, then left in the
// builder): same day and session, blocks, circuit, title, rounds and pattern.
export function draftSaved(state, d = state.draft) {
  const sig = (blocks) => (blocks || []).map((b) => `${b.id}${b.circuit ? '*' : ''}`).join();
  const circuit = (d.blocks || []).some((b) => b.circuit);
  return state.log.some((r) => r.date === d.date && (r.slot || 'AM') === (d.slot || 'AM')
    && sig(r.blocks) === sig(d.blocks)
    && (r.title || '') === String(d.title || '').trim()
    && (!circuit || (r.rounds === d.rounds && (r.pattern || 'even') === (d.pattern || 'even'))));
}

// Replacing the draft would lose work: it has blocks that are not saved.
export const draftAtRisk = (state) => !!state.draft?.blocks?.length && !draftSaved(state);

// Before putting something else in the builder. Resolves true when there is
// nothing to lose or the coach says Replace.
export async function replaceDraft(ctx, what) {
  const { state } = ctx;
  if (!draftAtRisk(state)) return true;
  const d = state.draft;
  return ctx.confirmAction(`Replace the practice you are building (${dayLabel(d.date)} ${d.slot || 'AM'}) with ${what}?`, 'Replace', { danger: false });
}

// A debrief with answers in it.
export const debriefTouched = (d) => !!(d && (d.overall || d.notes || d.sections?.some(sectionTouched)));

// Open the editor for a practice (new) or an existing debrief (a copy, so
// Cancel leaves the saved one alone).
export function startDebrief(state, recordOrDebrief) {
  state.debriefing = Array.isArray(recordOrDebrief.sections)
    ? JSON.parse(JSON.stringify(recordOrDebrief))
    : debriefFor(recordOrDebrief);
  state.ui.debriefResult = null;
}

// Debrief a practice: carry on with the debrief in progress for it, else
// start one (from its saved debrief when it has one), asking first when a
// debrief of another practice has answers in it. Resolves false when the
// coach keeps that one.
export async function openDebrief(ctx, record, saved = null) {
  const { state } = ctx;
  const cur = state.debriefing;
  if (cur && cur.practiceId === record.id) return true;
  if (debriefTouched(cur) && !(await ctx.confirmAction('You have an unsaved debrief for another practice. Throw it away?', 'Discard'))) return false;
  startDebrief(state, saved || state.debriefs.find((x) => x.practiceId === record.id) || record);
  return true;
}
