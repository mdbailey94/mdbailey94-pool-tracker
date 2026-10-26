import test from 'node:test';
import assert from 'node:assert/strict';
import { blockFromDoc, dayOf, docSessions, headingOf, joinBlocks, matchBlock, nameKey, scanPlan } from '../src/docscan.js';
import { makeBlock, subCategories } from '../src/practice.js';

// A made-up week doc: paragraphs as documents.get returns them.
const para = (text, { bold = false, underline = false } = {}) => ({ paragraph: { elements: [{ textRun: { content: `${text}\n`, textStyle: { ...(bold ? { bold } : {}), ...(underline ? { underline } : {}) } } }] } });
const doc = (paras) => ({ content: { documentId: 'D', revisionId: 'r', tabs: [{ documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, ...paras] } } }] } });
const B = { bold: true };
const BU = { bold: true, underline: true };

const WEEK = doc([
  para('Week 3 B2', B),
  para(''),
  para('Tuesday', B),
  para('WU - 20 min, everyone', BU),
  para('300 easy choice\t\t\t\t\t\t5:00 | 5:15'),
  para('4 x 50 drill / swim\t\t\t\t\t\t1:00'),
  para('Threshold - 30 min', BU),
  para('3 rounds:', B),
  para('3 x 100 free G3\t\t\t\t\t\t1:20 | 1:25'),
  para(':30 REST', B),
  para('Tuesday PM', B),
  para('Easy start, then power.'),
  para('Fins kick - 15 min', BU),
  para('8 x 50 kick with fins\t\t\t\t\t:55'),
  para('Tuesday PM', B),
  para('Fins kick - 15 min', BU),
  para('8 x 50 kick with fins\t\t\t\t\t:55'),
  para('Saturday', B),
  para('400 easy\t\t\t\t\t\t6:00'),
  para('8 x 25 fast\t\t\t\t\t\t:40'),
]);

test('day headings and block headings as coaches write them', () => {
  assert.deepEqual(dayOf('Tuesday'), { weekday: 1, slot: 'AM' });
  assert.deepEqual(dayOf('Thursday PM '), { weekday: 3, slot: 'PM' });
  assert.deepEqual(dayOf('Friday 10/30'), { weekday: 4, slot: 'AM' });
  assert.equal(dayOf('Monday 6 x 50 kick'), null);
  assert.equal(dayOf('Mondays we kick'), null);
  assert.deepEqual(headingOf('WU - 25 min, everyone'), { name: 'WU', minutes: 25, extra: 'everyone' });
  assert.deepEqual(headingOf('36 min IM builds'), { name: '36 min IM builds', minutes: 36, extra: '' });
  assert.deepEqual(headingOf('All together'), { name: 'All together', minutes: null, extra: '' });
});

test('docSessions: days, PM doubles, notes, blocks with their bold lines, pasted copies, headless days', () => {
  const s = docSessions(WEEK, '2026-10-19');
  assert.deepEqual(s.map((x) => [x.date, x.slot, x.copies, x.blocks.length]), [['2026-10-20', 'AM', 1, 2], ['2026-10-20', 'PM', 2, 1], ['2026-10-24', 'AM', 1, 1]]);
  const [wu, thr] = s[0].blocks;
  assert.deepEqual([wu.name, wu.minutes, wu.extra], ['WU', 20, 'everyone']);
  assert.deepEqual(wu.lines, ['300 easy choice   5:00 | 5:15', '4 x 50 drill / swim   1:00']);
  assert.deepEqual(thr.lines, ['3 rounds:', '3 x 100 free G3   1:20 | 1:25', ':30 REST'], 'rounds and REST stay in the block');
  assert.equal(s[1].note, 'Easy start, then power.');
  assert.equal(s[2].blocks[0].name, 'Sat practice');
  assert.equal(s[2].blocks[0].lines.length, 2);
});

test('blocks are matched to the library by lines, then by name; new ones get a category', () => {
  const library = [
    makeBlock({ id: 'k1', name: '15 min Fins kick', category: 'kick', minutes: 15, lines: [] }),
    makeBlock({ id: 'w1', name: 'Warm-up A', category: 'warmup', minutes: 20, lines: ['300 easy choice   5:00 | 5:15', '4 x 50 drill / swim   1:00'] }),
  ];
  const plan = scanPlan(docSessions(WEEK, '2026-10-19'), { library, log: [{ id: 'r1', date: '2026-10-20', slot: 'PM' }] });
  assert.equal(plan[0].blocks[0].match.id, 'w1', 'same lines, other name');
  assert.equal(plan[0].blocks[1].match, null);
  assert.equal(plan[1].blocks[0].match.id, 'k1', 'same name without its minutes');
  assert.equal(plan[1].existing.id, 'r1');
  assert.equal(plan[0].existing, null);
  assert.equal(nameKey('15 min Fins kick'), nameKey('Fins kick'));
  const nb = blockFromDoc(plan[0].blocks[1]);
  assert.equal(nb.category, 'threshold');
  assert.equal(nb.minutes, 30);
  assert.equal(nb.source, 'drive');
  assert.equal(matchBlock({ name: '', lines: [] }, library), null);
});

test('"WU" and "WD" headings are warm-ups and cool-downs', () => {
  assert.equal(blockFromDoc({ name: 'WU', minutes: 20, extra: '', lines: ['300 easy', '4 x 50 drill / swim   1:00'] }).category, 'warmup');
  assert.equal(blockFromDoc({ name: 'WD', minutes: 10, extra: '', lines: ['200 easy'] }).category, 'cooldown');
});

test('a block split in two by mistake is joined back, its heading kept as a line', () => {
  const blocks = [
    { name: 'Main', minutes: 30, extra: '', head: 'Main - 30 min', lines: ['3 x 200 free'] },
    { name: 'Second half', minutes: null, extra: 'fins', head: 'Second half', lines: ['6 x 50 kick'] },
    { name: 'Kick', minutes: 10, extra: '', head: 'Kick - 10 min', lines: ['200 kick'] },
  ];
  assert.deepEqual(joinBlocks(blocks).map((b) => b.parts), [[0], [1], [2]]);
  const [one, two] = joinBlocks(blocks, new Set([1]));
  assert.deepEqual(one.lines, ['3 x 200 free', 'Second half', '6 x 50 kick']);
  assert.equal(one.minutes, 30);
  assert.equal(one.extra, 'fins');
  assert.deepEqual(one.parts, [0, 1]);
  assert.deepEqual(two.parts, [2]);
  const all = joinBlocks(blocks, new Set([1, 2]));
  assert.equal(all.length, 1);
  assert.equal(all[0].minutes, 40);
  assert.equal(joinBlocks(blocks, new Set([0])).length, 3); // nothing above the first
  assert.equal(blocks[0].lines.length, 1); // the scanned blocks are left as they were
  // Headings are kept for joining.
  assert.equal(docSessions(WEEK, '2026-10-26')[0].blocks[1].head, 'Threshold - 30 min');
});

test('blocks carry an optional sub-category', () => {
  assert.equal(makeBlock({ name: 'A', sub: '  Socks  ' }).sub, 'Socks');
  assert.equal(makeBlock({ name: 'A', sub: ' ' }).sub, undefined);
  const lib = [makeBlock({ name: 'A', category: 'kick', sub: 'Socks' }), makeBlock({ name: 'B', category: 'kick', sub: 'socks' }), makeBlock({ name: 'C', category: 'speed', sub: 'Blocks' })];
  assert.deepEqual(subCategories(lib), ['Blocks', 'Socks']);
  assert.deepEqual(subCategories(lib, 'kick'), ['Socks']);
});
