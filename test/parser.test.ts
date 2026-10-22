import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDate, parseNoteDate, resolveDate } from '../src/dates.js';
import * as edit from '../src/edit.js';
import { findTasks, identityText, parseTaskLine, priorityOf, splitNote, joinNote, statusType } from '../src/parser.js';

test('parses Tasks-plugin emoji fields, tags and dataview inline fields', () => {
  const p = parseTaskLine('- [ ] Call Bob [[Bob Smith]] #work [cost:: 2] [value:: 400] 🔼 📅 2026-10-25 🛫 2026-10-22')!;
  assert.equal(p.statusSymbol, ' ');
  assert.equal(p.fields.due?.value, '2026-10-25');
  assert.equal(p.fields.start?.value, '2026-10-22');
  assert.equal(priorityOf(p), 'medium');
  assert.deepEqual(p.tags, ['#work']);
  assert.deepEqual(p.inlineFields, { cost: '2', value: '400' });
  assert.equal(p.description, 'Call Bob [[Bob Smith]] #work [cost:: 2] [value:: 400]');
  assert.equal(identityText(p), 'Call Bob [[Bob Smith]] [cost:: 2] [value:: 400]');
});

test('fields are only read from the end of the line, like the plugin', () => {
  const p = parseTaskLine('- [ ] Fields then text 📅 2026-10-21 trailing words')!;
  assert.equal(p.fields.due, undefined);
  assert.match(p.description, /📅 2026-10-21 trailing words/);
});

test('unknown emoji stays in the description; trailing tags and block links are handled', () => {
  const p = parseTaskLine('- [ ] Unknown 🆕 thing 📅 2026-11-01 #later ^block-1')!;
  assert.equal(p.fields.due?.value, '2026-11-01');
  assert.equal(p.blockLink, '^block-1');
  assert.deepEqual(p.tags, ['#later']);
  assert.equal(p.description, 'Unknown 🆕 thing #later');
});

test('variation selectors, alternative emoji and all status symbols', () => {
  const p = parseTaskLine('* [/] Thing 📆️ 2026-01-02 ⌛ 2026-01-01 ⏫️')!;
  assert.equal(p.fields.due?.value, '2026-01-02');
  assert.equal(p.fields.scheduled?.value, '2026-01-01');
  assert.equal(priorityOf(p), 'high');
  assert.equal(p.bullet, '*');
  assert.equal(parseTaskLine('- [X] done')!.statusSymbol, 'X');
  assert.equal(parseTaskLine('1. [ ] numbered')!.bullet, '1.');
  assert.equal(parseTaskLine('> - [ ] in callout')!.indent, '> ');
  assert.equal(parseTaskLine('- [ ]')!.description, '');
  assert.equal(parseTaskLine('- not a task'), null);
  assert.equal(parseTaskLine('-[ ] no space'), null);
});

test('recurrence and global filter', () => {
  const p = parseTaskLine('- [ ] Water plants 🔁 every week on Sunday when done 📅 2026-10-20')!;
  assert.equal(p.fields.recurrence?.value, 'every week on Sunday when done');
  assert.equal(parseTaskLine('- [ ] no filter here', '#task'), null);
  assert.ok(parseTaskLine('- [ ] #task has filter', '#task'));
});

test('findTasks skips frontmatter and code fences, tracks nesting', () => {
  const doc = splitNote(['---', 'x: - [ ] not a task', '---', '- [ ] parent', '\t- [ ] child', '\t\t- [ ] grandchild', '```', '- [ ] code', '```', '- [ ] sibling', ''].join('\n'));
  const items = findTasks(doc);
  assert.deepEqual(items.map((i) => [i.lineIndex, i.depth, i.parentLine]), [[3, 0, null], [4, 1, 3], [5, 2, 4], [9, 0, null]]);
});

test('CRLF and BOM round-trip', () => {
  const src = '﻿# Note\r\n- [ ] a\r\n- [ ] b\r\n';
  assert.equal(joinNote(splitNote(src)), src);
  assert.equal(findTasks(splitNote(src)).length, 2);
});

test('surgical line edits preserve everything else', () => {
  const line = '* [ ] Call Bob [[Bob]] #work [cost:: 2] 🔼 📅 2026-10-25 ^abc';
  assert.equal(edit.setDateField(line, 'due', '2026-11-01'), '* [ ] Call Bob [[Bob]] #work [cost:: 2] 🔼 📅 2026-11-01 ^abc');
  assert.equal(edit.setDateField(line, 'due', null), '* [ ] Call Bob [[Bob]] #work [cost:: 2] 🔼 ^abc');
  assert.equal(edit.setDateField(line, 'scheduled', '2026-10-24'), '* [ ] Call Bob [[Bob]] #work [cost:: 2] 🔼 📅 2026-10-25 ⏳ 2026-10-24 ^abc');
  assert.equal(edit.setPriority(line, 'highest'), '* [ ] Call Bob [[Bob]] #work [cost:: 2] 🔺 📅 2026-10-25 ^abc');
  assert.equal(edit.setPriority(line, 'none'), '* [ ] Call Bob [[Bob]] #work [cost:: 2] 📅 2026-10-25 ^abc');
  assert.equal(edit.setStatus(line, 'x'), '* [x] Call Bob [[Bob]] #work [cost:: 2] 🔼 📅 2026-10-25 ^abc');
  assert.equal(edit.setDescription(line, 'Call Alice'), '* [ ] Call Alice 🔼 📅 2026-10-25 ^abc');
  assert.equal(edit.addTag(line, '#urgent'), '* [ ] Call Bob [[Bob]] #work [cost:: 2] #urgent 🔼 📅 2026-10-25 ^abc');
  assert.equal(edit.removeTag(line, '#work'), '* [ ] Call Bob [[Bob]] [cost:: 2] 🔼 📅 2026-10-25 ^abc');
  // keeps the original emoji variant when replacing a value
  assert.equal(edit.setDateField('- [ ] x 📆 2026-01-01', 'due', '2026-02-02'), '- [ ] x 📆 2026-02-02');
  // trailing tags are kept when the description is replaced
  assert.equal(edit.setDescription('- [ ] old text #tag 📅 2026-01-01', 'new'), '- [ ] new #tag 📅 2026-01-01');
});

test('duplicate fields are refused rather than guessed', () => {
  assert.throws(() => edit.setDateField('- [ ] x 📅 2026-01-01 📅 2026-02-01', 'due', '2026-03-01'), /more than one due/);
});

test('relative dates and note formats', () => {
  assert.equal(resolveDate('today', '2026-10-22'), '2026-10-22');
  assert.equal(resolveDate('tomorrow', '2026-10-22'), '2026-10-23');
  assert.equal(resolveDate('+1w', '2026-10-22'), '2026-10-29');
  assert.equal(resolveDate('+1m', '2026-01-31'), '2026-02-28');
  assert.equal(resolveDate('thursday', '2026-10-22'), '2026-10-22'); // 2026-10-22 is a Thursday
  assert.equal(resolveDate('next thursday', '2026-10-22'), '2026-10-29');
  assert.equal(resolveDate('fri', '2026-10-22'), '2026-10-23');
  assert.throws(() => resolveDate('2026-02-30', '2026-10-22'), /Invalid calendar date/);
  assert.equal(formatDate('2026-10-22', 'YYYY/MM/YYYY-MM-DD dddd'), '2026/10/2026-10-22 Thursday');
  assert.equal(parseNoteDate('2026/10/2026-10-22 Thursday', 'YYYY/MM/YYYY-MM-DD dddd'), '2026-10-22');
  assert.equal(parseNoteDate('Meeting notes', 'YYYY-MM-DD'), null);
  assert.equal(formatDate('2026-10-22', '[Week] MMM D'), 'Week Oct 22');
});

test('custom status symbols follow configured types, else plugin defaults', () => {
  assert.equal(statusType('>'), 'todo');
  assert.equal(statusType('>', { '>': 'in_progress' }), 'in_progress');
  assert.equal(statusType('d', { '>': 'in_progress' }), 'todo');
  assert.equal(statusType('x', { '>': 'in_progress' }), 'done');
});
