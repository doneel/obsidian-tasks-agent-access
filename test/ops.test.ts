import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import { todayIn } from '../src/dates.js';
import { TasksError } from '../src/errors.js';
import * as ops from '../src/ops.js';
import { lockPath, readPending } from '../src/sync.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const TODAY = todayIn('UTC');

const NOTE = `---
tags: daily
---
# 2026-10-20

## Tasks
* [ ] Review proposal for Acme 📅 2026-10-21
* [x] Send invoice #billing ✅ 2026-10-19
- [ ] Call Bob [[Bob Smith]] #work [cost:: 2] [value:: 400] 🔼 📅 2026-10-25 🛫 2026-10-22
	- [ ] Sub task nested ⏳ 2026-10-23
	- [ ] Another child
- [/] In progress thing ⏫
- [-] Cancelled thing ❌ 2026-10-18
- [ ] Water plants 🔁 every week 📅 2026-10-20
- [ ] Duplicate text
- [ ] Duplicate text
- [ ] Ünïcödé task 日本語 🔽 📅 2026-10-30 ^block-1

\`\`\`
- [ ] inside code block
\`\`\`

## Notes
Some prose that must survive.
`;

function setup(files: Record<string, string> = {}, cfgOver: Partial<Config> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'Daily Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Private'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Private', 'secret.md'), '- [ ] secret task\n');
  fs.writeFileSync(path.join(vault, 'Daily Notes', '2026-10-20.md'), NOTE);
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, k)), { recursive: true });
    fs.writeFileSync(path.join(vault, k), v);
  }
  process.env.TASKS_CONFIG = path.join(dir, 'config', 'config.json');
  const cfg: Config = { vaultPath: vault, dailyNotesDir: 'Daily Notes', noteFormat: 'YYYY-MM-DD', timezone: 'UTC', sync: { enabled: false }, ...cfgOver };
  const read = (rel = 'Daily Notes/2026-10-20.md') => fs.readFileSync(path.join(vault, rel), 'utf8');
  return { dir, vault, cfg, ctx: () => ops.makeContext(cfg), read };
}

/** A fake `ob sync`: runs `behaviour` on the Nth call (1-based), exits 0 otherwise. */
function fakeSync(dir: string, body: string): string[] {
  const script = path.join(dir, 'fake-sync.cjs');
  fs.writeFileSync(script, `
const fs = require('fs'); const path = require('path');
const counter = path.join(${JSON.stringify(dir)}, 'sync-count');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
const vault = process.env.TASKS_VAULT_PATH;
${body}
`);
  return [process.execPath, script];
}

const find = (ctx: ops.Context, text: string, status = 'all') => {
  const r = ops.list(ctx, { status, text });
  assert.equal(r.tasks.length, 1, `expected exactly one task matching "${text}", got ${r.tasks.length}`);
  return r.tasks[0];
};

function expectError(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof TasksError, `expected TasksError, got ${e}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

test('lists only Daily Notes tasks with metadata, ignoring code blocks and other folders', () => {
  const { ctx } = setup();
  const all = ops.list(ctx(), { status: 'all' });
  assert.equal(all.total, 11);
  assert.ok(!all.tasks.some((t) => t.description.includes('secret') || t.description.includes('inside code')));
  const bob = find(ctx(), 'call bob');
  assert.equal(bob.priority, 'medium');
  assert.equal(bob.due, '2026-10-25');
  assert.equal(bob.start, '2026-10-22');
  assert.deepEqual(bob.inlineFields, { cost: '2', value: '400' });
  assert.equal(bob.section, 'Tasks');
  assert.equal(bob.noteDate, '2026-10-20');
  assert.equal(bob.link, '[[Daily Notes/2026-10-20]]');
  const child = find(ctx(), 'sub task');
  assert.equal(child.parentId, bob.id);
  assert.equal(child.depth, 1);
});

test('filters: status, overdue, tags, priority, unicode search, dates', () => {
  const { ctx } = setup();
  assert.equal(ops.list(ctx(), { status: 'open' }).total, 9);
  assert.equal(ops.list(ctx(), { status: 'done' }).total, 1);
  assert.deepEqual(ops.list(ctx(), { status: 'open', dueBefore: '2026-10-22' }).tasks.map((t) => t.description), ['Water plants', 'Review proposal for Acme']);
  assert.equal(ops.list(ctx(), { tags: ['work'] }).total, 1);
  assert.equal(ops.list(ctx(), { tags: ['#billing'], status: 'all' }).total, 1);
  assert.deepEqual(ops.list(ctx(), { priority: '>=high' }).tasks.map((t) => t.description), ['In progress thing']);
  assert.equal(ops.list(ctx(), { text: '日本語' }).total, 1);
  assert.equal(ops.list(ctx(), { scheduledOn: '2026-10-23' }).total, 1);
  assert.equal(ops.list(ctx(), { happensOnOrBefore: '2026-10-22' }).total, 3);
  assert.equal(ops.list(ctx(), { note: '2026-10-20' }).total, 11);
  assert.equal(ops.list(ctx(), { from: '2026-10-21' }).total, 0);
  assert.equal(ops.list(ctx(), { limit: 2 }).truncated, true);
});

test('complete changes exactly one line and is idempotent', () => {
  const { ctx, read } = setup();
  const t = find(ctx(), 'review proposal');
  const before = read();
  const r = ops.complete(ctx(), t.id, { rev: t.rev });
  assert.equal(r.changed, true);
  assert.equal(r.task!.status, 'done');
  assert.equal(r.task!.id, t.id);
  const after = read();
  assert.equal(after, before.replace('* [ ] Review proposal for Acme 📅 2026-10-21', `* [x] Review proposal for Acme 📅 2026-10-21 ✅ ${TODAY}`));
  const again = ops.complete(ctx(), t.id);
  assert.equal(again.changed, false);
  assert.equal((again as Record<string, unknown>).alreadyInState, true);
  assert.equal(read(), after);
  const re = ops.reopen(ctx(), t.id);
  assert.equal(re.changed, true);
  assert.equal(read(), before);
});

test('recurring tasks are refused, not silently treated as one-off', () => {
  const { ctx, read } = setup();
  const before = read();
  const t = find(ctx(), 'water plants');
  expectError(() => ops.complete(ctx(), t.id), 'UNSUPPORTED');
  expectError(() => ops.update(ctx(), t.id, { status: 'cancelled' }), 'UNSUPPORTED');
  assert.equal(read(), before);
  // rescheduling a recurring task is fine
  ops.update(ctx(), t.id, { due: '2026-10-27' });
  assert.match(read(), /- \[ \] Water plants 🔁 every week 📅 2026-10-27\n/);
});

test('identical task text: ids disambiguate, and shifted lines fail safe', () => {
  const { ctx, read, vault } = setup();
  const dups = ops.list(ctx(), { text: 'duplicate text' }).tasks;
  assert.equal(dups.length, 2);
  assert.notEqual(dups[0].id, dups[1].id);
  ops.complete(ctx(), dups[1].id);
  const lines = read().split('\n');
  assert.equal(lines[dups[0].line - 1], '- [ ] Duplicate text');
  assert.match(lines[dups[1].line - 1], /^- \[x\] Duplicate text ✅/);
  // another device inserts a line above: old ids no longer pin down a single task
  const p = path.join(vault, 'Daily Notes', '2026-10-20.md');
  fs.writeFileSync(p, read().replace('## Tasks\n', '## Tasks\n- [ ] Inserted elsewhere\n'));
  expectError(() => ops.complete(ctx(), dups[0].id), 'AMBIGUOUS');
  // unique tasks survive line shifts
  const bob = find(ctx(), 'call bob');
  assert.ok(ops.update(ctx(), `${bob.id.split(':')[0]}:1`, { priority: 'high' }).changed);
});

test('stale rev and edited text are detected', () => {
  const { ctx, read, vault } = setup();
  const t = find(ctx(), 'review proposal');
  const p = path.join(vault, 'Daily Notes', '2026-10-20.md');
  fs.writeFileSync(p, read().replace('Acme 📅 2026-10-21', 'Acme 📅 2026-10-24'));
  expectError(() => ops.complete(ctx(), t.id, { rev: t.rev }), 'STALE');
  fs.writeFileSync(p, read().replace('Review proposal for Acme', 'Review proposal for Globex'));
  expectError(() => ops.complete(ctx(), t.id), 'NOT_FOUND');
  expectError(() => ops.complete(ctx(), 'garbage'), 'USAGE');
});

test('update edits fields surgically and rejects metadata in text', () => {
  const { ctx, read } = setup();
  const t = find(ctx(), 'call bob');
  const r = ops.update(ctx(), t.id, { due: 'none', scheduled: '2026-10-24', priority: 'highest', addTags: ['urgent'], removeTags: ['#work'] });
  assert.match(read(), /\n- \[ \] Call Bob \[\[Bob Smith\]\] \[cost:: 2\] \[value:: 400\] #urgent 🔺 🛫 2026-10-22 ⏳ 2026-10-24\n\t- \[ \] Sub task/);
  assert.equal(r.task!.priority, 'highest');
  const r2 = ops.update(ctx(), r.task!.id, { text: 'Call Robert [[Bob Smith]] [cost:: 2] [value:: 400]' });
  assert.equal(r2.task!.description, 'Call Robert [[Bob Smith]] [cost:: 2] [value:: 400] #urgent');
  expectError(() => ops.update(ctx(), r2.task!.id, { text: 'sneaky 📅 2026-01-01' }), 'USAGE');
  ops.update(ctx(), r2.task!.id, { status: 'in_progress' });
  assert.match(read(), /- \[\/\] Call Robert/);
  ops.update(ctx(), r2.task!.id, { status: 'cancelled' });
  assert.match(read(), new RegExp(`- \\[-\\] Call Robert .* ❌ ${TODAY}`));
});

test('add: under heading, bullet detection, retry-safe, missing note', () => {
  const { ctx, read, vault } = setup();
  const r = ops.add(ctx(), { text: 'Prepare deck', date: '2026-10-20', heading: '## Tasks', due: '2026-10-28', priority: 'high', tags: ['work'], inlineFields: ['cost=1'] });
  assert.equal(r.changed, true);
  const lines = read().split('\n');
  const idx = lines.indexOf('- [ ] Prepare deck #work [cost:: 1] ⏫ 📅 2026-10-28');
  assert.ok(idx > 0, read());
  assert.equal(lines[idx - 1], '- [ ] Ünïcödé task 日本語 🔽 📅 2026-10-30 ^block-1');
  assert.equal(r.task!.due, '2026-10-28');
  // retry does not duplicate
  const again = ops.add(ctx(), { text: 'Prepare deck', date: '2026-10-20', heading: '## Tasks', due: '2026-10-28', priority: 'high', tags: ['work'], inlineFields: ['cost=1'] });
  assert.equal(again.changed, false);
  assert.equal((again as Record<string, unknown>).alreadyExisted, true);
  assert.equal(read().split('Prepare deck').length, 2);
  // missing note
  expectError(() => ops.add(ctx(), { text: 'x', date: '2030-01-01' }), 'NOTE_NOT_FOUND');
  assert.ok(!fs.existsSync(path.join(vault, 'Daily Notes', '2030-01-01.md')));
  expectError(() => ops.add(ctx(), { text: 'x', date: '2026-10-20', heading: 'Nope' }), 'NOT_FOUND');
  expectError(() => ops.add(ctx(), { text: 'x', date: '2026-10-20', due: 'someday' }), 'USAGE');
});

test('add: --create-note uses the template; bullet follows note style; subtasks nest', () => {
  const { ctx, read, cfg } = setup({ 'Templates/Daily.md': '# {{date:dddd, MMMM D}}\n\n## Tasks\n\n## Log\n' });
  cfg.template = 'Templates/Daily.md';
  cfg.heading = '## Tasks';
  ops.add(ctx(), { text: 'First', date: '2026-10-23', createNote: true });
  assert.equal(read('Daily Notes/2026-10-23.md'), '# Friday, October 23\n\n## Tasks\n- [ ] First\n\n## Log\n');
  const parent = find(ctx(), 'review proposal');
  const child = ops.add(ctx(), { text: 'Child of review', parent: parent.id });
  assert.match(read(), /\* \[ \] Review proposal for Acme 📅 2026-10-21\n\t\* \[ \] Child of review\n\* \[x\] Send invoice/);
  assert.equal(child.task!.parentId, parent.id);
  const bob = find(ctx(), 'call bob');
  ops.add(ctx(), { text: 'Third child', parent: bob.id });
  assert.match(read(), /\t- \[ \] Another child\n\t- \[ \] Third child\n- \[\/\] In progress/);
});

test('path confinement: traversal and symlinks are rejected', () => {
  const { ctx, vault } = setup();
  for (const bad of ['../Private/secret', '/etc/passwd', 'Daily Notes/../../x', '.obsidian/app']) {
    expectError(() => ops.add(ctx(), { text: 'x', file: bad, createNote: true }), 'PATH_REJECTED');
  }
  // a daily-note-named symlink pointing outside is skipped and refused
  fs.symlinkSync(path.join(vault, 'Private', 'secret.md'), path.join(vault, 'Daily Notes', '2026-10-19.md'));
  const r = ops.list(ctx(), { status: 'all' });
  assert.ok(!r.tasks.some((t) => t.description.includes('secret')));
  assert.ok(r.warnings.some((w) => w.includes('symlink')));
  expectError(() => ops.add(ctx(), { text: 'x', file: '2026-10-19' }), 'PATH_REJECTED');
  expectError(() => ops.add(ctx(), { text: 'x', date: '2026-10-19' }), 'PATH_REJECTED');
  // non-daily files inside the folder are out of scope too
  expectError(() => ops.add(ctx(), { text: 'x', file: 'Meeting notes', createNote: true }), 'PATH_REJECTED');
});

test('CRLF notes keep their line endings', () => {
  const { ctx, read } = setup({ 'Daily Notes/2026-10-21.md': '# Day\r\n- [ ] crlf task\r\n' });
  const t = find(ctx(), 'crlf task');
  ops.complete(ctx(), t.id);
  ops.add(ctx(), { text: 'new crlf', date: '2026-10-21' });
  assert.equal(read('Daily Notes/2026-10-21.md'), `# Day\r\n- [x] crlf task ✅ ${TODAY}\r\n- [ ] new crlf\r\n`);
});

test('sync failure before reading or writing: nothing changes', () => {
  const { ctx, cfg, read, dir } = setup();
  cfg.sync = { enabled: true, command: fakeSync(dir, 'process.stderr.write("network down"); process.exit(1);') };
  const before = read();
  expectError(() => ops.list(ctx(), {}), 'SYNC_FAILED');
  const stale = ops.makeContext(cfg, { allowStale: true });
  assert.equal(ops.list(stale, {}).sync.ok, false);
  expectError(() => ops.add(ctx(), { text: 'x', date: '2026-10-20' }), 'SYNC_FAILED');
  assert.equal(read(), before);
});

test('push failure after a write is reported, marked pending, and retry is safe', () => {
  const { ctx, cfg, read, dir } = setup();
  cfg.sync = { enabled: true, command: fakeSync(dir, 'if (n === 2) { console.error("push failed"); process.exit(1); }') };
  const t = ops.list(ops.makeContext({ ...cfg, sync: { enabled: false } }), { text: 'review proposal' }).tasks[0];
  assert.throws(() => ops.complete(ctx(), t.id), (e: TasksError) => e.code === 'SYNC_FAILED' && e.details.localChangeApplied === true);
  assert.equal(readPending(cfg)!.length, 1);
  const retry = ops.complete(ctx(), t.id);
  assert.equal(retry.changed, false);
  assert.equal(retry.sync.ok, true);
  assert.equal(readPending(cfg), null);
  assert.equal(read().split('✅').length, 3); // one existing + one new, not duplicated
});

test('a concurrent remote edit that overrides ours is reported as CONFLICT', () => {
  const { ctx, cfg, dir } = setup();
  const note = 'Daily Notes/2026-10-20.md';
  cfg.sync = {
    enabled: true,
    command: fakeSync(dir, `if (n === 2) { const p = path.join(vault, ${JSON.stringify(note)}); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/- \\[x\\] Duplicate text.*\\n/, '- [ ] Duplicate text (edited on phone)\\n')); }`),
  };
  const t = ops.list(ops.makeContext({ ...cfg, sync: { enabled: false } }), { text: 'duplicate text' }).tasks[0];
  expectError(() => ops.complete(ctx(), t.id), 'CONFLICT');
});

test('conflicted copies are excluded from results and flagged', () => {
  const { ctx } = setup({ 'Daily Notes/2026-10-20 (Conflicted copy agent 202610201200).md': '- [ ] dup from conflict\n' });
  const r = ops.list(ctx(), { status: 'all' });
  assert.ok(!r.tasks.some((t) => t.description.includes('dup from conflict')));
  assert.ok(r.warnings.some((w) => w.includes('conflicted copy')));
});

test('a held lock times out instead of running concurrently', () => {
  const { ctx, cfg } = setup();
  cfg.lockTimeoutSec = 0.3;
  const lock = lockPath(cfg);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
  expectError(() => ops.list(ctx(), {}), 'LOCK_TIMEOUT');
  // a lock left by a dead process is reclaimed
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, host: os.hostname(), at: Date.now() }));
  assert.ok(ops.list(ctx(), {}).total > 0);
});

test('CLI: JSON envelope, exit codes, persistence via config file', () => {
  const { cfg, dir } = setup();
  fs.mkdirSync(path.dirname(process.env.TASKS_CONFIG!), { recursive: true });
  fs.writeFileSync(process.env.TASKS_CONFIG!, JSON.stringify(cfg));
  const env = { ...process.env };
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--json'], { env, encoding: 'utf8' });
  const list = JSON.parse(run('list', '--status', 'open', '--due-before', '2026-10-22').stdout);
  assert.equal(list.ok, true);
  assert.equal(list.total, 2);
  const added = JSON.parse(run('add', '--date', '2026-10-20', '--text', 'From CLI', '--due', 'tomorrow').stdout);
  assert.equal(added.task.description, 'From CLI');
  const search = JSON.parse(run('search', 'from', 'cli').stdout);
  assert.equal(search.tasks[0].id, added.task.id);
  const done = JSON.parse(run('complete', '--id', added.task.id).stdout);
  assert.equal(done.task.status, 'done');
  const bad = run('complete', '--id', 'ffffffffff:1');
  assert.equal(bad.status, 3);
  assert.equal(JSON.parse(bad.stdout).error.code, 'NOT_FOUND');
  assert.equal(run('frobnicate').status, 2);
  const doc = JSON.parse(run('doctor', '--offline').stdout);
  assert.equal(doc.ok, true, JSON.stringify(doc));
  const human = execFileSync(process.execPath, [CLI, 'list', '--note', '2026-10-20'], { env, encoding: 'utf8' });
  assert.match(human, /\[ \] Call Bob/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vault-root daily notes (YYYY-MM-DD.md next to other notes): only daily notes are in scope', () => {
  const template = '**Due**\n```tasks\n(due before {{date:YYYY-MM-DD}}) OR (due on {{date:YYYY-MM-DD}})\n```\n**Today**\n```tasks\n((has start date) AND (starts before {{date+1d:YYYY-MM-DD}}))\n```\n* ';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-root-'));
  const vault = path.join(dir, 'vault');
  const w = (rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), c); };
  w('daily_note_template.md', template);
  w('2026-10-21.md', template.replaceAll('{{date:YYYY-MM-DD}}', '2026-10-21').replace('{{date+1d:YYYY-MM-DD}}', '2026-10-22').replace(/\* $/, '* [ ] [[Vendor]] questionnaire 🛫 2026-10-28 \n* [ ] Can we show more than 5 months'));
  w('Project ideas.md', '- [ ] not a daily task\n');
  w('Work/Client.md', '- [ ] also not daily\n');
  w('2026-10-21 (Conflicted copy phone 202610211200).md', '* [ ] conflict dup\n');
  process.env.TASKS_CONFIG = path.join(dir, 'config', 'config.json');
  const cfg: Config = { vaultPath: vault, dailyNotesDir: '', noteFormat: 'YYYY-MM-DD', timezone: 'UTC', bullet: '*', template: 'daily_note_template.md', sync: { enabled: false } };
  const ctx = () => ops.makeContext(cfg);

  const r = ops.list(ctx(), { status: 'all' });
  assert.deepEqual(r.tasks.map((t) => t.description).sort(), ['Can we show more than 5 months', '[[Vendor]] questionnaire']);
  assert.equal(r.tasks.find((t) => t.description.includes('Vendor'))!.start, '2026-10-28');
  assert.equal(r.tasks[0].link, '[[2026-10-21]]');
  assert.ok(r.warnings.some((w) => w.includes('conflicted copy')));
  for (const bad of ['Project ideas', 'Work/Client', 'daily_note_template']) {
    expectError(() => ops.add(ctx(), { text: 'x', file: bad }), 'PATH_REJECTED');
  }
  ops.add(ctx(), { text: 'Appended', date: '2026-10-21' });
  assert.match(fs.readFileSync(path.join(vault, '2026-10-21.md'), 'utf8'), /\* \[ \] Can we show more than 5 months\n\* \[ \] Appended$/);
  // new note from the template: offsets rendered, the empty "* " placeholder becomes the task
  ops.add(ctx(), { text: 'First of the day', date: '2026-10-23', createNote: true });
  const created = fs.readFileSync(path.join(vault, '2026-10-23.md'), 'utf8');
  assert.match(created, /\(due on 2026-10-23\)/);
  assert.match(created, /starts before 2026-10-24/);
  assert.ok(created.endsWith('```\n* [ ] First of the day'), created); // template had no final newline; none added
  assert.equal(ops.list(ctx(), { note: '2026-10-23' }).total, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bootstrap: no-op when configured, explains missing env otherwise; setup parses --statuses', async () => {
  const { bootstrap, setup: runSetup } = await import('../src/admin.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-boot-'));
  process.env.TASKS_CONFIG = path.join(dir, 'cfg', 'config.json');
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('TASKS_') && k !== 'TASKS_CONFIG') delete process.env[k];
  try {
    process.env.TASKS_VAULT_PATH = path.join(dir, 'vault');
    expectError(() => bootstrap({ offline: true }), 'CONFIG');
    fs.mkdirSync(path.dirname(process.env.TASKS_CONFIG), { recursive: true });
    fs.mkdirSync(path.join(dir, 'vault'), { recursive: true });
    fs.writeFileSync(process.env.TASKS_CONFIG, JSON.stringify({ vaultPath: path.join(dir, 'vault'), sync: { enabled: false } }));
    const r = runSetup({ statuses: '>=in_progress,?=todo', bullet: '*' });
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.TASKS_CONFIG, 'utf8')).statuses, { '>': 'in_progress', '?': 'todo' });
    assert.ok(r.doctor.healthy);
    expectError(() => runSetup({ statuses: '>=busy' }), 'USAGE');
    const b = bootstrap({ offline: true, skillsDir: path.join(dir, 'skills') });
    assert.equal(b.alreadyConfigured, true);
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'obsidian-tasks', 'SKILL.md')));
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
