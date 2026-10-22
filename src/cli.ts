#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { BOOTSTRAP_ENV, bootstrap, doctor, installSkill, setup } from './admin.js';
import { loadConfig } from './config.js';
import { TasksError } from './errors.js';
import * as ops from './ops.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version as string;

type Opts = NonNullable<ParseArgsConfig['options']>;
const str = { type: 'string' } as const;
const strs = { type: 'string', multiple: true } as const;
const bool = { type: 'boolean' } as const;

const COMMON: Opts = { json: bool, 'no-sync': bool, 'allow-stale': bool, help: { type: 'boolean', short: 'h' } };
const FILTERS: Opts = {
  status: str, text: str, tag: strs, priority: str,
  'due-before': str, 'due-after': str, 'due-on': str,
  'scheduled-before': str, 'scheduled-after': str, 'scheduled-on': str,
  'start-before': str, 'start-after': str, 'start-on': str,
  'happens-before': str, 'happens-on-or-before': str,
  'has-due': bool, 'no-due': bool, overdue: bool,
  note: str, from: str, to: str, sort: str, limit: str,
};
const FIELDS: Opts = { due: str, scheduled: str, start: str, priority: str };

const COMMANDS: Record<string, { options: Opts; positionals?: boolean; usage: string }> = {
  list: { options: FILTERS, usage: 'tasks list [--status open|done|cancelled|in_progress|closed|all] [--due-before DATE] [--tag T] [--priority P] [--note DATE|PATH] [--overdue] [--sort due|priority|scheduled|file|note] [--limit N]' },
  search: { options: FILTERS, positionals: true, usage: 'tasks search <words...> [list filters]   (default --status all)' },
  get: { options: { id: str }, usage: 'tasks get --id ID' },
  add: {
    options: { text: str, date: str, file: str, heading: str, parent: str, tag: strs, field: strs, 'create-note': bool, 'allow-duplicate': bool, ...FIELDS },
    positionals: true,
    usage: 'tasks add --text "..." [--date today] [--due DATE] [--scheduled DATE] [--start DATE] [--priority P] [--tag T] [--field key=value] [--heading "## Tasks"] [--parent ID] [--create-note]',
  },
  update: {
    options: { id: str, rev: str, text: str, status: str, 'add-tag': strs, 'remove-tag': strs, ...FIELDS },
    usage: 'tasks update --id ID [--rev REV] [--text "..."] [--due DATE|none] [--scheduled DATE|none] [--start DATE|none] [--priority P|none] [--add-tag T] [--remove-tag T] [--status todo|in_progress|cancelled]',
  },
  complete: { options: { id: str, rev: str, date: str }, usage: 'tasks complete --id ID [--rev REV] [--date DATE]' },
  reopen: { options: { id: str, rev: str }, usage: 'tasks reopen --id ID [--rev REV]' },
  sync: { options: {}, usage: 'tasks sync' },
  doctor: { options: { offline: bool }, usage: 'tasks doctor [--offline]' },
  setup: {
    options: {
      'vault-path': str, 'remote-vault': str, 'vault-name': str, 'daily-dir': str, 'note-format': str, timezone: str,
      bullet: str, heading: str, template: str, 'global-filter': str, 'exclude-folders': str, 'file-types': str,
      'device-name': str, statuses: str, 'skip-initial-sync': bool,
    },
    usage: 'tasks setup --remote-vault "<Vault>" [--vault-path ~/obsidian-vault] [--daily-dir "" (vault root)] [--note-format YYYY-MM-DD] [--timezone Area/City] [--bullet -|*] [--heading "## Tasks"] [--exclude-folders "A,B"] [--file-types unsupported] [--statuses ">=in_progress"]',
  },
  bootstrap: { options: { 'skills-dir': str, offline: bool }, usage: 'tasks bootstrap [--skills-dir DIR] [--offline]   (configures from TASKS_* env vars; no-op when already set up)' },
  skill: { options: { install: str }, usage: 'tasks skill [--install <skills-dir>]' },
};

const HELP = `obsidian-tasks-agent-access ${VERSION} — Obsidian Tasks in your Daily Notes, for agents.

${Object.values(COMMANDS).map((c) => `  ${c.usage}`).join('\n')}

Global flags: --json (structured output), --no-sync (use local copy only), --allow-stale (read even if sync fails)
Dates: YYYY-MM-DD, today, tomorrow, yesterday, +3d, -1w, +1m, friday, "next monday"
Priorities: highest, high, medium, none, low, lowest (filters also accept ">=high")

bootstrap environment:
${Object.entries(BOOTSTRAP_ENV).map(([k, d]) => `  ${k.padEnd(22)} ${d}`).join('\n')}`;

const nullable = (v: string | undefined) => (v === undefined ? undefined : ['none', 'null', ''].includes(v.toLowerCase()) ? null : v);

function need(v: unknown, flag: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new TasksError('USAGE', `Missing required ${flag}`);
  return v;
}

function filtersFrom(v: Record<string, unknown>, defaultStatus: string, text?: string): ops.Filters {
  const s = (k: string) => v[k] as string | undefined;
  const limit = s('limit') !== undefined ? Number(s('limit')) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new TasksError('USAGE', '--limit must be a positive integer');
  return {
    status: s('status') ?? defaultStatus,
    text: [text, s('text')].filter(Boolean).join(' ') || undefined,
    tags: v.tag as string[] | undefined,
    priority: s('priority'),
    dueBefore: s('due-before') ?? (v.overdue ? 'today' : undefined),
    dueAfter: s('due-after'), dueOn: s('due-on'),
    scheduledBefore: s('scheduled-before'), scheduledAfter: s('scheduled-after'), scheduledOn: s('scheduled-on'),
    startBefore: s('start-before'), startAfter: s('start-after'), startOn: s('start-on'),
    happensBefore: s('happens-before'), happensOnOrBefore: s('happens-on-or-before'),
    hasDue: v['has-due'] as boolean | undefined, noDue: v['no-due'] as boolean | undefined,
    note: s('note'), from: s('from'), to: s('to'), sort: s('sort'), limit,
  };
}

function run(cmd: string, v: Record<string, unknown>, positionals: string[]): object {
  const ctx = () => ops.makeContext(loadConfig(), { sync: !v['no-sync'], allowStale: Boolean(v['allow-stale']) });
  switch (cmd) {
    case 'list':
      return ops.list(ctx(), filtersFrom(v, 'open'));
    case 'search': {
      if (!positionals.length && !v.text) throw new TasksError('USAGE', 'search needs at least one word');
      return ops.list(ctx(), filtersFrom(v, 'all', positionals.join(' ')));
    }
    case 'get':
      return ops.get(ctx(), need(v.id, '--id'));
    case 'add':
      return ops.add(ctx(), {
        text: need((v.text as string) ?? positionals.join(' '), '--text'),
        date: v.date as string, file: v.file as string, heading: v.heading as string, parent: v.parent as string,
        due: v.due as string, scheduled: v.scheduled as string, start: v.start as string, priority: v.priority as string,
        tags: v.tag as string[], inlineFields: v.field as string[],
        createNote: Boolean(v['create-note']), allowDuplicate: Boolean(v['allow-duplicate']),
      });
    case 'update': {
      const spec: ops.UpdateSpec = {
        rev: v.rev as string, text: v.text as string, status: v.status as string,
        due: nullable(v.due as string), scheduled: nullable(v.scheduled as string), start: nullable(v.start as string),
        priority: v.priority as string, addTags: v['add-tag'] as string[], removeTags: v['remove-tag'] as string[],
      };
      if (Object.entries(spec).every(([k, x]) => k === 'rev' || x === undefined)) throw new TasksError('USAGE', 'update needs at least one change');
      return ops.update(ctx(), need(v.id, '--id'), spec);
    }
    case 'complete':
      return ops.complete(ctx(), need(v.id, '--id'), { rev: v.rev as string, date: v.date as string });
    case 'reopen':
      return ops.reopen(ctx(), need(v.id, '--id'), { rev: v.rev as string });
    case 'sync':
      return ops.syncNow(ops.makeContext(loadConfig()));
    case 'doctor':
      return doctor({ offline: Boolean(v.offline) });
    case 'setup':
      return setup({
        vaultPath: v['vault-path'] as string, remoteVault: v['remote-vault'] as string, vaultName: v['vault-name'] as string,
        dailyDir: v['daily-dir'] as string, noteFormat: v['note-format'] as string, timezone: v.timezone as string,
        bullet: v.bullet as string, heading: v.heading as string, template: v.template as string,
        globalFilter: v['global-filter'] as string, excludeFolders: v['exclude-folders'] as string,
        fileTypes: v['file-types'] as string, deviceName: v['device-name'] as string, statuses: v.statuses as string,
        skipSync: Boolean(v['skip-initial-sync']),
      });
    case 'bootstrap':
      return bootstrap({ skillsDir: v['skills-dir'] as string, offline: Boolean(v.offline) });
    case 'skill': {
      if (v.install) return { installed: installSkill(v.install as string) };
      const src = path.join(PKG_DIR, 'SKILL.md');
      return { path: src, content: fs.readFileSync(src, 'utf8') };
    }
  }
  throw new TasksError('USAGE', `Unknown command "${cmd}"`);
}

// ---------------------------------------------------------------------------------------
// Human-readable output

const CHECK: Record<string, string> = { todo: '[ ]', in_progress: '[/]', done: '[x]', cancelled: '[-]' };

function fmtTask(t: ops.Task): string {
  const meta = [
    t.priority !== 'none' ? t.priority : '', t.due ? `due ${t.due}` : '', t.scheduled ? `sched ${t.scheduled}` : '',
    t.start ? `start ${t.start}` : '', t.done ? `done ${t.done}` : '', t.recurrence ? `🔁 ${t.recurrence}` : '',
  ].filter(Boolean).join(', ');
  return `${'  '.repeat(t.depth ?? 0)}${CHECK[t.status]} ${t.description}${meta ? `  (${meta})` : ''}\n${'  '.repeat(t.depth ?? 0)}    ${t.file}:${t.line}  id=${t.id} rev=${t.rev}`;
}

function human(cmd: string, r: Record<string, unknown>): string {
  const out: string[] = [];
  if (Array.isArray(r.tasks)) {
    const tasks = r.tasks as ops.Task[];
    out.push(...tasks.map(fmtTask));
    out.push(`${r.total} task(s)${r.truncated ? `, showing ${tasks.length}` : ''}`);
  } else if (r.task) {
    if (cmd === 'add') out.push(r.alreadyExisted ? 'Already exists (no duplicate added):' : 'Added:');
    else if (cmd !== 'get') out.push(r.changed ? 'Updated:' : 'No change needed:');
    out.push(fmtTask(r.task as ops.Task));
  } else if (Array.isArray(r.checks)) {
    for (const c of r.checks as { name: string; status: string; message: string }[]) out.push(`${c.status.toUpperCase().padEnd(5)} ${c.name}: ${c.message}`);
    out.push(r.healthy ? 'Healthy.' : 'Problems found.');
  } else if (Array.isArray(r.steps)) {
    out.push(...(r.steps as string[]), human('doctor', r.doctor as Record<string, unknown>));
  } else if (typeof r.content === 'string') out.push(r.content);
  else out.push(JSON.stringify(r, null, 2));
  for (const w of (r.warnings as string[] | undefined) ?? []) out.push(`warning: ${w}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  const json = rest.includes('--json');
  try {
    const spec = COMMANDS[cmd];
    if (!spec) throw new TasksError('USAGE', `Unknown command "${cmd}". Run "tasks help".`);
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { ...COMMON, ...spec.options }, allowPositionals: true, strict: true });
    } catch (e) {
      throw new TasksError('USAGE', `${(e as Error).message}\nUsage: ${spec.usage}`);
    }
    if (parsed.values.help) {
      console.log(spec.usage);
      return 0;
    }
    if (parsed.positionals.length && !spec.positionals) throw new TasksError('USAGE', `Unexpected argument "${parsed.positionals[0]}"\nUsage: ${spec.usage}`);
    const result = run(cmd, parsed.values as Record<string, unknown>, parsed.positionals) as Record<string, unknown>;
    const ok = cmd === 'doctor' ? Boolean(result.healthy) : cmd === 'bootstrap' ? Boolean((result.doctor as { healthy: boolean }).healthy) : true;
    console.log(json ? JSON.stringify({ ok, ...result }) : human(cmd, result));
    return ok ? 0 : 1;
  } catch (e) {
    const err = e instanceof TasksError ? e : new TasksError('INTERNAL', (e as Error).stack ?? String(e));
    if (json) console.log(JSON.stringify({ ok: false, error: err.toJSON() }));
    else {
      console.error(`error [${err.code}]: ${err.message}`);
      if (Object.keys(err.details).length) console.error(JSON.stringify(err.details, null, 2));
    }
    return err.exitCode;
  }
}

process.exitCode = main(process.argv.slice(2));
