import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRequests, blockHeading, dayHeading, docEnd, docIdFrom, lineParagraph, sessionParagraphs, weekDocTitle } from '../src/gdoc.js';

// A made-up documents.get shape: one tab, one non-empty paragraph.
const DOC = {
  documentId: 'doc123', revisionId: 'rev9', title: 'Week 2 Base',
  tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [
    { endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 8, paragraph: { elements: [{ startIndex: 1, endIndex: 8, textRun: { content: 'Monday\n', textStyle: { bold: true, weightedFontFamily: { fontFamily: 'Georgia' } } } }] } },
  ] } } }],
};
const EMPTY = { documentId: 'new1', revisionId: 'r1', body: { content: [{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } };

test('day and block headings follow the coach\'s doc format', () => {
  assert.equal(dayHeading(1, 'AM'), 'Tuesday');
  assert.equal(dayHeading(3, 'PM'), 'Thursday PM');
  assert.equal(blockHeading('WU', 25), 'WU - 25 min');
  assert.equal(blockHeading('38 min free pace', 38), '38 min free pace');
  assert.equal(weekDocTitle({ name: 'B2 · threshold + race pace' }, 1), 'Week 2 B2');
  assert.equal(weekDocTitle({ name: 'Base' }, 0), 'Week 1 Base');
  const phases = [{ name: 'B1 · aerobic base', weeks: 4 }, { name: 'B2 · threshold', weeks: 2 }, { name: 'B2 · race pace + meet', weeks: 1 }, { name: 'B3', weeks: 3 }];
  assert.equal(weekDocTitle(phases[2], 0, phases, 2), 'Week 3 B2');
  assert.equal(weekDocTitle(phases[3], 1, phases, 3), 'Week 2 B3');
  assert.equal(docIdFrom('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWx/edit?tab=t.0'), '1AbCdEfGhIjKlMnOpQrStUvWx');
  assert.equal(docIdFrom('not a link'), null);
});

test('set lines: send-offs pushed right by tabs, rounds/REST bold, adjustments italic', () => {
  const p = lineParagraph('6 x 100 free G2   1:20 | 1:27');
  assert.match(p.text, /^6 x 100 free G2\t+1:20 \| 1:27$/);
  assert.equal(p.bold || false, false);
  assert.deepEqual(lineParagraph('3 rounds:'), { text: '3 rounds:', bold: true });
  assert.deepEqual(lineParagraph(':30 REST'), { text: ':30 REST', bold: true });
  assert.equal(lineParagraph('3rd interval - skip #6').italic, true);
  assert.equal(lineParagraph('G3 pace   1:02 | 1:08').italic, true);
  assert.match(lineParagraph('G3 pace   1:02 | 1:08').text, /^G3 pace\t+1:02 \| 1:08$/);
  assert.deepEqual(lineParagraph('8 x 50 free odds - G2 evens - G4   :50').boldWords.length, 2);
  assert.equal(lineParagraph('  ').spacer, true);
});

test('a session becomes the day heading, block headings and their lines', () => {
  const ps = sessionParagraphs({ weekday: 1, slot: 'PM', sections: [
    { title: 'WU', minutes: 15, lines: ['250 easy   4:00'] },
    { title: 'Kick', minutes: 20, lines: ['3 rounds:', '6 x 50 kick, G4   1:00'] },
  ] });
  assert.deepEqual(ps.map((p) => p.text.replace(/\t+/g, '→')), ['Tuesday PM', '', 'WU - 15 min', '250 easy→4:00', '', 'Kick - 20 min', '3 rounds:', '6 x 50 kick, G4→1:00', '']);
  assert.equal(ps[0].bold, true);
  assert.equal(ps[1].spacer, true);
});

test('docEnd reads where to append and the doc\'s font', () => {
  const e = docEnd({ content: DOC });
  assert.deepEqual([e.documentId, e.revisionId, e.tabId, e.endIndex, e.empty, e.font], ['doc123', 'rev9', 't.0', 8, false, 'Georgia']);
  const n = docEnd(EMPTY);
  assert.deepEqual([n.endIndex, n.empty, n.tabId], [2, true, null]);
});

test('append requests insert once, then style ranges that match the inserted text', () => {
  const paragraphs = sessionParagraphs({ weekday: 2, slot: 'AM', sections: [{ title: 'Main', minutes: 30, lines: ['4 rounds:', '4 x 100 free G3   1:12 | 1:18', '3rd interval - 3 x 100 in RD4'] }] });
  const { documentId, requests, writeControl } = appendRequests(DOC, paragraphs);
  assert.equal(documentId, 'doc123');
  assert.deepEqual(writeControl, { requiredRevisionId: 'rev9' });
  const ins = requests[0].insertText;
  assert.equal(ins.location.index, 7); // end - 1
  assert.equal(ins.location.tabId, 't.0');
  // The doc's last paragraph has text: it is ended, then a blank line.
  assert.ok(ins.text.startsWith('\n\nWednesday\n'));
  const all = `${ins.text}\n`; // the doc's final newline now ends the last paragraph
  const textAt = (r) => all.slice(r.startIndex - 7, r.endIndex - 7);
  const styled = requests.slice(4).map((r) => r.updateTextStyle).filter((u) => u.textStyle.bold || u.textStyle.italic).map((u) => [textAt(u.range), u.textStyle.bold ? 'b' : 'i']);
  assert.deepEqual(styled, [['Wednesday', 'b'], ['Main - 30 min', 'b'], ['4 rounds:', 'b'], ['3rd interval - 3 x 100 in RD4', 'i']]);
  // The reset starts after the doc's own last paragraph (index 7 ends it)
  // and runs through the final newline: no bullets, Normal text, Calibri 11
  // (the font the tabs are measured for), every other text style cleared.
  const [bullets, para, text] = requests.slice(1, 4);
  for (const r of [bullets.deleteParagraphBullets, para.updateParagraphStyle, text.updateTextStyle]) {
    assert.deepEqual([r.range.startIndex, r.range.endIndex], [8, 7 + all.length]);
  }
  assert.equal(para.updateParagraphStyle.paragraphStyle.namedStyleType, 'NORMAL_TEXT');
  assert.equal(para.updateParagraphStyle.fields, '*');
  assert.equal(text.updateTextStyle.fields, '*');
  assert.equal(text.updateTextStyle.textStyle.weightedFontFamily.fontFamily, 'Calibri');
  // An empty new doc starts at index 1 with no leading newline.
  const e = appendRequests(EMPTY, paragraphs);
  assert.equal(e.requests[0].insertText.location.index, 1);
  assert.ok(e.requests[0].insertText.text.startsWith('Wednesday\n'));
  assert.equal(e.requests[1].deleteParagraphBullets.range.startIndex, 1);
});

test('appending after a blank last line adds no second blank; an image or chip is content', () => {
  const paragraphs = sessionParagraphs({ weekday: 0, slot: 'AM', sections: [{ title: 'WU', minutes: 10, lines: ['200 easy   3:30'] }] });
  const blankEnd = { documentId: 'd', revisionId: 'r', body: { content: [
    { endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 8, paragraph: { elements: [{ textRun: { content: 'Monday\n' } }] } },
    { startIndex: 8, endIndex: 9, paragraph: { elements: [{ textRun: { content: '\n' } }] } },
  ] } };
  const a = appendRequests(blankEnd, paragraphs);
  assert.ok(a.requests[0].insertText.text.startsWith('\nMonday\n'));
  assert.equal(a.requests[1].deleteParagraphBullets.range.startIndex, 9);
  const image = { documentId: 'd', revisionId: 'r', body: { content: [
    { endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 3, paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'i1' } }, { textRun: { content: '\n' } }] } },
  ] } };
  assert.equal(docEnd(image).empty, false);
  assert.ok(appendRequests(image, paragraphs).requests[0].insertText.text.startsWith('\n\nMonday'));
});

test('a session never ends on a spacer, whatever blank lines its blocks carry', () => {
  const ps = sessionParagraphs({ weekday: 1, slot: 'AM', sections: [
    { title: 'WU', minutes: 10, lines: ['', '200 easy   3:30', '', ''] },
    { title: 'Main', minutes: 20, lines: ['4 x 100 free   1:20', '', ''] },
  ] });
  assert.deepEqual(ps.at(-1), { text: '' });
  assert.ok(!ps.some((p, i) => p.text === '' && ps[i + 1]?.text === ''), 'no blank runs');
  const { requests } = appendRequests(DOC, ps);
  const end = 7 + requests[0].insertText.text.length + 1;
  for (const r of requests) {
    const range = Object.values(r)[0].range;
    if (range) assert.ok(range.endIndex <= end, 'nothing past the end');
  }
});

test('doc lines: tenths in reference rows, adjustments keyed by group name, odds/evens only as markers', () => {
  assert.match(lineParagraph('G3 pace   1:02.5 | 1:05 | 1:08').text, /^G3 pace\t+1:02\.5 \| 1:05 \| 1:08$/);
  assert.equal(lineParagraph('Mid - 3 x 100 (start on #2)', 4.5, null, [{ name: 'Mid' }]).italic, true);
  assert.equal(lineParagraph('L4 - same as L3', 4.5, null, [{ key: 'L4', name: 'Lane 4' }]).italic, true);
  const p = lineParagraph('6 x 50 odd - fast, even - easy, hold even pace   :50');
  assert.deepEqual(p.boldWords.map(([a, b]) => p.text.slice(a, b)), ['odd', 'even']);
  assert.deepEqual(lineParagraph('# odds: fast, evens: easy').boldWords.length, 2);
});

test('doc links: multi-account, Drive and bare ids', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const u of [`https://docs.google.com/document/u/1/d/${id}/edit`, `https://drive.google.com/open?id=${id}`, `https://drive.google.com/file/d/${id}/view`,
    `https://docs.google.com/a/club.org/document/d/${id}/edit?tab=t.0#heading=h.x`, `https://docs.google.com/document/d/${id}/edit?usp=sharing`, id]) assert.equal(docIdFrom(u), id, u);
});
