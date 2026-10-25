import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_MAX, RULES, coachContext, coachTurns, offlineReply, parseCoachReply, relevantBlocks, replyContent, slotOf } from '../src/coach.js';
import { composePractice, defaultPlan, makeBlock, makeMeet, practiceRecord, starterBlocks } from '../src/practice.js';
import { debriefFor, makeDebrief } from '../src/learn.js';
import { learnStyle, writingContext } from '../src/setlang.js';

// Made-up season, groups and blocks (no real coach data).
const plan = defaultPlan('2026-10-19'); // Monday; Base phase
plan.groups = [{ name: 'Lane 1', key: '1:02', g3: 62 }, { name: 'Lane 2', key: '1:05', g3: 65 }, { name: 'Lane 3', key: '1:08', g3: 68, im400: 300 }];
plan.meets = [makeMeet({ name: 'Harvest Invite', start: '2026-11-06', end: '2026-11-08', course: 'SCY' }), makeMeet({ name: 'Far Meet', start: '2026-12-20' })];
const own = makeBlock({
  name: '38 min IM + FL builds', category: 'race', stroke: 'IM', minutes: 38, gears: ['G2', 'G5'], session: 'AM', source: 'pasted',
  lines: ['G3 pace       1:02 | 1:05 | 1:08', '5 x 100 IM    1:36 | 1:41 | 1:46', ':20 REST', '3 rounds:', '6 x 50 FL, G2 → G5 by 25    :53 | :56 | :59'],
});
const kick = makeBlock({ name: '20 min kick', category: 'kick', minutes: 20, lines: ['8 x 100 kick, G2'], source: 'coach' });
const blocks = [...starterBlocks(), own, kick];
const record = {
  id: 's1', date: '2026-10-26', slot: 'AM', title: 'Monday aerobic', focus: 'aerobic', minutes: 120, distance: 6000, text: 'Monday aerobic\n38 min IM + FL builds\n    5 x 100 IM',
  blocks: [{ id: own.id, name: own.name, category: 'race', stroke: 'IM', gears: ['G3'], lines: own.lines, distance: 2400 }],
};
const d0 = debriefFor(record);
const debrief = makeDebrief({ ...d0, overall: 4, sections: [{ ...d0.sections[0], verdict: 'mixed', intervals: 'too-hard', why: 'FL 50s too tight for lane 3', changed: 'gave lane 3 :05 more' }] });
const style = { ...learnStyle([own.lines.join('\n')]), guide: 'Pre-set, :20 REST, then 3 rounds. Kick after the main set.' };
const state = { today: '2026-10-27', plan, blocks, log: [record], debriefs: [debrief], style };
const learned = { weights: {}, calibration: { G3: { breast: 1 } }, writing: writingContext(plan, { style }) };

test('the context covers today, the week, meets, gears, groups, style, library, practices and debriefs', () => {
  const ctx = coachContext({ state, learned, slot: 'PM' });
  assert.ok(new TextEncoder().encode(ctx).length <= CONTEXT_MAX);
  assert.match(ctx, /Session: AM 120 min · Technique \(gears G1, G2\)/); // Tuesday of week 2 (Base)
  assert.match(ctx, /Session: PM 60 min · Aerobic/);
  assert.match(ctx, /Asked about: the PM session\./);
  assert.match(ctx, /Base · week 2 of 6/);
  assert.match(ctx, /Tue 10-27: AM 120 Technique \[open\] \+ PM 60 Aerobic \[open\] {2}<- today/);
  assert.match(ctx, /Harvest Invite: 2026-11-06 to 2026-11-08 \(SCY\), in 10 days/);
  assert.doesNotMatch(ctx, /Far Meet/); // beyond 21 days
  assert.match(ctx, /G3 Threshold · rest ratio 0\.1 /);
  // G2 = 62 × (14400 / 3600)^(0.06 / 1.06) = 67.1 s with the default F of 1.06.
  assert.match(ctx, /1\. Lane 1 \(column key 1:02\): G2 1:07 · G3 1:02/);
  assert.match(ctx, /3\. Lane 3 .* IM G3 /);
  assert.match(ctx, /G3 breast \+1s\/100/);
  assert.match(ctx, /Kick after the main set/);
  assert.match(ctx, /rest line ":20 REST"/);
  assert.match(ctx, /## 38 min IM \+ FL builds · 38 min · race · IM/);
  assert.match(ctx, /6 x 50 FL, G2 → G5 by 25/);
  assert.match(ctx, /### 2026-10-26 AM · Aerobic · Monday aerobic/);
  assert.match(ctx, /4\/5 · 38 min IM \+ FL builds: mixed, intervals too hard/);
  assert.match(ctx, /38 min IM \+ FL builds: 2026-10-26, mixed, why: FL 50s too tight for lane 3, changed: gave lane 3 :05 more/);
});

test('the context stays under 20 KB with a big library and log', () => {
  const longLines = Array.from({ length: 40 }, (_, i) => `${i + 2} x 100 free G${(i % 5) + 2}, holding stroke count, breathe every 3    1:2${i % 10} | 1:3${i % 10}`);
  const many = Array.from({ length: 200 }, (_, i) => makeBlock({ name: `${30 + (i % 20)} min set ${i}`, category: 'aerobic', minutes: 30, lines: longLines, source: 'coach' }));
  const log = Array.from({ length: 30 }, (_, i) => ({ ...record, id: `r${i}`, date: `2026-10-${String(26 - (i % 20)).padStart(2, '0')}`, text: longLines.join('\n').repeat(3) }));
  const big = { ...state, blocks: many, log, style: { ...style, guide: 'x '.repeat(20000) } };
  const ctx = coachContext({ state: big, learned });
  assert.ok(new TextEncoder().encode(ctx).length <= CONTEXT_MAX, String(ctx.length));
  assert.match(ctx, /TODAY/);
  assert.match(ctx, /GROUPS/);
});

test('rest days and meet days say so', () => {
  const sunday = coachContext({ state: { ...state, today: '2026-10-25' }, learned });
  assert.match(sunday, /No practice today \(rest day\)/);
  const meetDay = coachContext({ state, learned, date: '2026-11-07' });
  assert.match(meetDay, /Meet today: Harvest Invite\. No practice\./);
  const dayBefore = coachContext({ state, learned, date: '2026-11-05' });
  assert.match(dayBefore, /Sharpen for Harvest Invite/);
});

test('library excerpt puts blocks for the focus and the coach\'s written blocks first', () => {
  const race = relevantBlocks(blocks, { focuses: ['race'], max: 3 });
  assert.equal(race[0].name, '38 min IM + FL builds');
  const pm = relevantBlocks(blocks, { focuses: ['aerobic'], slot: 'PM', max: 30 });
  assert.ok(pm.indexOf(own) > pm.indexOf(kick)); // AM-only block sinks for a PM question
  assert.equal(relevantBlocks(blocks, { focuses: ['rest'], max: 10 }).length, 10);
  assert.equal(slotOf("Write today's PM"), 'PM');
  assert.equal(slotOf('the morning set'), 'AM');
  assert.equal(slotOf('What did the debriefs say about kick?'), null);
});

test('turns: rules + context first, oldest history dropped to fit, the new message last', () => {
  const history = [
    { role: 'user', content: 'a'.repeat(60000) },
    { role: 'assistant', content: 'b'.repeat(50000), practice: { x: 1 } },
    { role: 'user', content: 'c'.repeat(10000) },
    { role: 'assistant', content: '' },
    { role: 'system', content: 'ignored' },
  ];
  const turns = coachTurns(history, 'Make the main set shorter', 'CONTEXT here');
  assert.equal(turns[0].role, 'user');
  assert.ok(turns[0].content.startsWith(RULES));
  assert.ok(turns[0].content.endsWith('CONTEXT here'));
  assert.deepEqual(turns.at(-1), { role: 'user', content: 'Make the main set shorter' });
  assert.deepEqual(turns.slice(1, -1).map((t) => t.content[0]), ['b', 'c']);
  assert.ok(turns.reduce((s, t) => s + t.content.length, 0) < 120000);
  assert.ok(turns.every((t) => Object.keys(t).join() === 'role,content'));
  // The first turn is never dropped, even when it alone is large.
  const huge = coachTurns(history, 'hi', 'x'.repeat(130000));
  assert.equal(huge.length, 2);
  assert.ok(huge[0].content.includes('x'.repeat(1000)));
});

test('replies are read tolerantly into blocks and a practice', () => {
  const r = parseCoachReply({
    reply: 'Lane 3 gets :05 more on the FL 50s after Monday.',
    practice: {
      title: 'Tuesday technique', slot: 'am', rounds: '3', pattern: 'build',
      blocks: [
        { name: '30 min warm-up', category: 'warm-up', minutes: 30, lines: ['600 choice easy', '4 x 50 build    :50'] },
        { category: 'BOGUS', stroke: 'FL', gears: 'G3, G6', equipment: 'fins, laser', circuit: true, lines: '40 min FL drill + build\n4 x 50 FL D1-4, G2 → G4\n:20 REST' },
      ],
    },
    blocks: [{ name: '20 min kick', category: 'kick', minutes: '20', lines: ['8 x 100 kick, G2'], session: 'pm' }, null, 42, { lines: [] }],
  });
  assert.match(r.reply, /Lane 3/);
  assert.equal(r.practice.title, 'Tuesday technique');
  assert.equal(r.practice.slot, 'AM');
  assert.equal(r.practice.rounds, 3);
  assert.equal(r.practice.pattern, 'build');
  const [warm, fly] = r.practice.blocks;
  assert.equal(warm.category, 'warmup');
  assert.equal(warm.source, 'claude');
  assert.equal(warm.circuit, false);
  assert.equal(fly.name, '40 min FL drill + build'); // heading line becomes the name
  assert.equal(fly.minutes, 40);
  assert.equal(fly.category, 'aerobic');
  assert.equal(fly.stroke, 'fly');
  assert.deepEqual(fly.gears, ['G3', 'G6']);
  assert.deepEqual(fly.equipment, ['fins']);
  assert.equal(fly.circuit, true);
  assert.deepEqual(fly.lines, ['4 x 50 FL D1-4, G2 → G4', ':20 REST']);
  assert.equal(r.blocks.length, 1); // null, 42 and an empty block are dropped
  assert.equal(r.blocks[0].minutes, 20);
  assert.equal(r.blocks[0].session, 'PM');
  assert.equal(r.blocks[0].source, 'claude');
  assert.equal('circuit' in r.blocks[0], false);
  // Kept in the chat as the JSON shape Claude was asked for, and read back the same.
  const again = parseCoachReply(replyContent(r));
  assert.equal(again.reply, r.reply);
  assert.deepEqual(again.practice.blocks.map((b) => [b.name, b.minutes, b.circuit, b.lines]), r.practice.blocks.map((b) => [b.name, b.minutes, b.circuit, b.lines]));
  assert.deepEqual(again.blocks.map((b) => b.name), ['20 min kick']);
});

test('replies that are strings, fenced JSON, arrays or junk still give a reply', () => {
  assert.deepEqual(parseCoachReply('Just text back'), { reply: 'Just text back', practice: null, blocks: [] });
  const fenced = parseCoachReply('Sure:\n```json\n{"reply": "ok", "practice": null, "blocks": []}\n```');
  assert.equal(fenced.reply, 'ok');
  const arr = parseCoachReply([{ name: '10 min drill', category: 'technique', minutes: 10, lines: ['8 x 25 FL drill'] }]);
  assert.equal(arr.blocks.length, 1);
  assert.match(arr.reply, /block/);
  assert.deepEqual(parseCoachReply(null), { reply: '', practice: null, blocks: [] });
  assert.equal(parseCoachReply({ reply: 7, practice: 'nope', blocks: 'nope' }).reply, '7');
  assert.equal(parseCoachReply({ reply: 'x', practice: { blocks: [] } }).practice, null);
  assert.equal(parseCoachReply({ message: 'from message' }).reply, 'from message');
});

test('offline: a pasted set becomes a block, anything else explains', () => {
  const wctx = writingContext(plan);
  const set = offlineReply('38 min IM + FL builds\n5 x 100 IM\n:20 REST\n3 rounds:\n6 x 50 FL, G2 → G5 by 25   :53 | :56 | :59', wctx);
  assert.equal(set.blocks.length, 1);
  assert.equal(set.blocks[0].name, '38 min IM + FL builds');
  assert.equal(set.blocks[0].minutes, 38);
  assert.match(set.reply, /^Saved as a block: 38 min IM \+ FL builds/);
  const q = offlineReply('What did the debriefs say about kick?', wctx);
  assert.equal(q.blocks.length, 0);
  assert.match(q.reply, /Claude isn't available on this page/);
  assert.equal(offlineReply('', wctx).blocks.length, 0);
});

test('the week section shows every session with its status, the totals against the targets and the gaps', () => {
  // Made-up week: Base week 2, a meet Friday to Sunday, two practices written.
  const wp = defaultPlan('2026-10-19');
  wp.weeklyYards = 40000;
  wp.meets = [makeMeet({ name: 'Made-up Invite', start: '2026-10-30', end: '2026-11-01', course: 'SCY' })];
  const rec = (date, slot, title, blocks) => {
    const bs = blocks.map((b) => ({ ...makeBlock(b), circuit: false }));
    const composed = composePractice({ blocks: bs, pace: 100, unit: 'y' });
    return practiceRecord({ date, slot, title, focus: 'aerobic', blocks: bs, rounds: 1, composed, text: title });
  };
  const mon = rec('2026-10-26', 'AM', 'Made-up aerobic', [{ name: 'Long aerobic', category: 'aerobic', distance: 6000, lines: ['60 x 100 free G2   1:15'] }]);
  const tue = rec('2026-10-27', 'AM', 'Made-up threshold', [
    { name: 'Threshold 100s', category: 'threshold', distance: 2000, lines: ['20 x 100 free G3   1:10'] },
    { name: 'Kick 100s', category: 'kick', distance: 800, lines: ['8 x 100 kick G2   1:50'] },
  ]);
  const monDebrief = makeDebrief({ ...debriefFor(mon), overall: 4 });
  const st = { today: '2026-10-28', plan: wp, blocks, log: [tue, mon], debriefs: [monDebrief], style };
  const lw = { weights: {}, calibration: {}, writing: writingContext(wp, { style }) };

  const ctx = coachContext({ state: st, learned: lw });
  assert.ok(new TextEncoder().encode(ctx).length <= CONTEXT_MAX);
  assert.match(ctx, /THIS WEEK/);
  assert.match(ctx, /Mon 10-26: AM 120 Aerobic \[debriefed: "Made-up aerobic", 6,000y, \d+ min\]/);
  assert.match(ctx, /Tue 10-27: AM 120 Technique \[swum: "Made-up threshold", 2,800y, \d+ min\] \+ PM 60 Aerobic \[open\]/);
  assert.match(ctx, /Wed 10-28: AM 120 Aerobic \[open\] {2}<- today/);
  assert.match(ctx, /Thu 10-29: AM 72 Speed \(Sharpen for Made-up Invite\) \[open\]/);
  assert.match(ctx, /Fri 10-30: meet: Made-up Invite/);
  assert.match(ctx, /Written: 2 of \d+ planned sessions, 8,800y, \d+ min; target about 40,000y for the week \(Base at 100% volume\)/);
  assert.match(ctx, /Gear bands of the written yards: G1–G2\.5 77%, G3–G3\.5 23%, G4–G4\.5 0%, G5–G6 0%; kick 9%/);
  assert.match(ctx, /Targets: G1–G2\.5 75%, G3–G3\.5 13%, G4–G4\.5 6%, G5–G6 6%; kick 20%/);
  assert.match(ctx, /Off target: More threshold \(G3–G3\.5\) than planned: 23% of yards vs 13%; .*Kick is 9% of yards vs 20% planned/);

  // Asking about another day of the week marks it; the phase's own targets show.
  wp.phases[0].targets = { threshold: 0.2 };
  wp.weeklyYards = null;
  const thu = coachContext({ state: st, learned: lw, date: '2026-10-29', slot: 'AM' });
  assert.match(thu, /Thu 10-29: .*<- asked about/);
  assert.match(thu, /Wed 10-28: .*<- today/);
  assert.match(thu, /today is .*2026-10-28/);
  assert.match(thu, /Targets: G1–G2\.5 75%, G3–G3\.5 20%/);
  assert.doesNotMatch(thu, /target about/);

  // A week with nothing written says so instead of shares.
  const empty = coachContext({ state: { ...st, log: [], debriefs: [] }, learned: lw });
  assert.match(empty, /Written: 0 of \d+ planned sessions/);
  assert.match(empty, /Nothing written yet\. Targets:/);
  assert.doesNotMatch(empty, /Off target/);
});

test("the coach's week counts CNS as Build, Today and the Week do (circuit rounds and gear shifts)", async () => {
  const { recordCns, savedRecord } = await import('../src/pw/load.js');
  const { recordGearYards } = await import('../src/week.js');
  const { cnsPoints } = await import('../src/gears.js');
  // Made-up week with one circuit practice on Monday.
  const wp = defaultPlan('2026-10-19');
  const lw = { weights: {}, calibration: {}, writing: writingContext(wp) };
  const set = makeBlock({ name: 'Made-up circuit set', category: 'aerobic', distance: 1800, lines: ['3 rounds:', '4 x 100 free G2   1:30', '4 x 50 kick G2   1:00'] });
  const fast = makeBlock({ name: 'Made-up fast 50s', category: 'race', distance: 450, lines: ['9 x 50 free G4   1:00'] });
  const drill = makeBlock({ name: 'Made-up drill', category: 'technique', distance: 300 }); // no lines
  const esc = (n) => String(n).replace('.', '\\.');
  for (const pattern of ['build', 'hard-last']) {
    const blocks = [{ ...set, circuit: true }, { ...fast, circuit: true }, { ...drill, circuit: true }];
    const composed = composePractice({ blocks, rounds: 3, pattern, pace: wp.pace, unit: 'y' });
    const ctx = { state: { plan: wp, log: [], debriefs: [] }, learned: lw };
    const r = savedRecord(ctx, { date: '2026-10-26', title: 'Made-up circuit', focus: 'aerobic', slot: 'AM', blocks, rounds: 3, pattern, composed, text: '' });
    const st = { today: '2026-10-27', plan: wp, blocks: [], log: [r], debriefs: [], style: null };
    const points = recordCns(r, { ...ctx, state: st });
    const once = cnsPoints(lw.writing.model, recordGearYards(r).byGear); // the old count: each block's lines once
    assert.ok(points > once, `${pattern}: ${points} vs ${once}`);
    const text = coachContext({ state: st, learned: lw });
    assert.match(text, new RegExp(`CNS points written: Mon ${esc(points)}\\.`), pattern);
    // The app may hand over its own count (recordCns); it is used as given.
    assert.match(coachContext({ state: st, learned: lw, cns: (rec) => recordCns(rec, { ...ctx, state: st }) }), new RegExp(`CNS points written: Mon ${esc(points)}\\.`));
    assert.match(coachContext({ state: st, learned: lw, cns: () => 12.5 }), /CNS points written: Mon 12\.5\./);
  }
});

test('the coach sees each block\'s description, with or without lines', async () => {
  const { coachContext } = await import('../src/coach.js');
  const { defaultPlan, makeBlock } = await import('../src/practice.js');
  const plan = defaultPlan('2026-10-19');
  const blocks = [makeBlock({ name: 'Made-up pull', category: 'pull', minutes: 20, lines: ['4 x 200 pull   2:50'], detail: 'Paddles off for the last one' })];
  const state = { plan, blocks, log: [], debriefs: [], style: null, prefs: {} };
  const text = coachContext({ state, learned: { weights: {}, calibration: {}, writing: null }, date: '2026-10-20', slot: 'AM' });
  assert.match(typeof text === 'string' ? text : JSON.stringify(text), /description: Paddles off for the last one/);
});
