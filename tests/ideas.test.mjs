import test from 'node:test';
import assert from 'node:assert/strict';
import { blockNote, ideaVersion, lastVersion, normalStages, stageFor, stageText } from '../src/ideas.js';
import { composePractice, defaultPlan, makeBlock, makePhase, migratePlan, practiceRecord, practiceText, recordBlock, suggestPractice } from '../src/practice.js';
import { parseSet, setDistance } from '../src/setlang.js';

// A made-up idea: kick with a snorkel, the snorkel coming off phase by phase.
const IDEA = makeBlock({
  id: 'idea1', name: 'Snorkel kick', category: 'kick', minutes: 20, idea: true, source: 'coach',
  detail: 'Kick on the snorkel between other work',
  stages: { P1: 'build up kick volume', P2: 'last 25% without the snorkel', ' P3 ': ' ', P4: 'no snorkel' },
  lines: ['3 rounds:', '4 x 50 kick snorkel', '100 easy free', ':30 REST', '8 x 25 kick, G2 → G5 by 25'],
});
const yards = (lines) => setDistance(parseSet(lines.join('\n')));

test('an idea keeps its phase notes; empty ones are dropped', () => {
  assert.equal(IDEA.idea, true);
  assert.deepEqual(IDEA.stages, { P1: 'build up kick volume', P2: 'last 25% without the snorkel', P4: 'no snorkel' });
  assert.equal(makeBlock({ name: 'Plain', lines: ['200 easy'] }).idea, undefined);
  assert.deepEqual(normalStages(null), {});
  assert.deepEqual(stageFor(IDEA, 'p2'), { phase: 'P2', text: 'last 25% without the snorkel' });
  assert.equal(stageFor(IDEA, 'Taper'), null);
  assert.equal(stageText(stageFor(IDEA, 'P4')), 'P4: no snorkel');
});

test('an idea is written differently on different days, the same on the same day', () => {
  const a = ideaVersion(IDEA, { date: '2026-11-02', phaseName: 'P2' });
  assert.deepEqual(ideaVersion(IDEA, { date: '2026-11-02', phaseName: 'P2' }).lines, a.lines);
  assert.equal(a.stage, 'P2: last 25% without the snorkel');
  const versions = new Set(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'].map((date) => ideaVersion(IDEA, { date }).lines.join('\n')));
  assert.ok(versions.size >= 3, `only ${versions.size} versions`);
  const base = yards(IDEA.lines);
  for (const v of versions) {
    const y = yards(v.split('\n'));
    assert.ok(Math.abs(y - base) <= base * 0.2, `${y} vs ${base}`);
  }
});

test('a version keeps the mechanism: distances tied to the words stay, the rest line stays', () => {
  for (const date of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
    const v = ideaVersion(IDEA, { date }).lines;
    assert.ok(v.some((l) => /^\d+ x 25 kick, G2 → G5 by 25$/.test(l)), v.join(' / '));
    assert.ok(v.includes(':30 REST'));
    assert.match(v[0], /^\d rounds:$/);
  }
});

test('a version unlike the last one swum', () => {
  const first = ideaVersion(IDEA, { date: '2026-11-02' });
  const again = ideaVersion(IDEA, { date: '2026-11-02', last: first.lines });
  assert.notDeepEqual(again.lines, first.lines);
  const log = [{ date: '2026-11-05', blocks: [{ id: 'idea1', lines: ['later'] }] }, { date: '2026-11-02', blocks: [{ id: 'idea1', lines: first.lines }] }];
  assert.deepEqual(lastVersion(log, 'idea1', '2026-11-03'), first.lines);
  assert.equal(lastVersion(log, 'other'), null);
});

test('a block that is not an idea is used as written', () => {
  const plain = makeBlock({ name: 'Plain', lines: ['8 x 50 free'] });
  assert.equal(ideaVersion(plain, { date: '2026-11-02' }), plain);
});

test('the phase note prints with the block, even with descriptions hidden', () => {
  const v = ideaVersion(IDEA, { date: '2026-11-02', phaseName: 'P4' });
  assert.equal(blockNote(v), 'P4: no snorkel\nKick on the snorkel between other work');
  assert.equal(blockNote(v, false), 'P4: no snorkel');
  const composed = composePractice({ blocks: [{ ...v, circuit: false }], pace: 100, unit: 'y' });
  const text = practiceText(composed, { showDetail: false });
  assert.match(text, /\n {4}P4: no snorkel\n/);
  assert.doesNotMatch(text, /between other work/);
  // Saved with the practice, and back again.
  const rec = practiceRecord({ date: '2026-11-02', focus: 'aerobic', blocks: [v], composed, text });
  assert.equal(rec.blocks[0].stage, 'P4: no snorkel');
  assert.equal(recordBlock(rec.blocks[0]).stage, 'P4: no snorkel');
});

test('the plan suggests an idea written for the day and its phase', () => {
  const plan = migratePlan({ ...defaultPlan('2026-11-02'), phases: [makePhase({ name: 'P2', weeks: 4, am: Array(7).fill('aerobic') })] });
  const warm = makeBlock({ id: 'w', name: 'Warm-up', category: 'warmup', minutes: 20, lines: ['400 easy'] });
  const s = suggestPractice({ plan, library: [warm, IDEA], date: '2026-11-03', slot: 'AM', focus: 'aerobic' });
  const b = s.blocks.find((x) => x.id === 'idea1');
  assert.ok(b, 'the idea is in the suggestion');
  assert.equal(b.stage, 'P2: last 25% without the snorkel');
  assert.deepEqual(b.lines, ideaVersion(IDEA, { date: '2026-11-03', slot: 'AM', phaseName: 'P2' }).lines);
});
