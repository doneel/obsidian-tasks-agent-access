import fs from 'node:fs';
import { timezoneOf, type Config } from './config.js';
import { formatDate, parseNoteDate, resolveDate, todayIn } from './dates.js';
import * as edit from './edit.js';
import { TasksError } from './errors.js';
import {
  DATE_FIELD_EMOJI, PRIORITY_EMOJI, PRIORITY_ORDER, findTasks, identityText, joinNote, parseTaskLine, priorityOf,
  splitNote, statusType, type DateField, type NoteDoc, type NoteItem, type ParsedLine, type Priority, type StatusType,
} from './parser.js';
import { markPending, runSync, withLock, type SyncResult } from './sync.js';
import { DailyRoot, sha, writeAtomic, type NoteRef } from './vault.js';

export interface Task {
  id: string;
  rev: string;
  status: StatusType;
  statusSymbol: string;
  description: string;
  tags: string[];
  priority: Priority;
  due?: string;
  scheduled?: string;
  start?: string;
  created?: string;
  done?: string;
  cancelled?: string;
  recurrence?: string;
  inlineFields?: Record<string, string>;
  file: string;
  line: number;
  noteDate?: string;
  section?: string;
  depth?: number;
  parentId?: string;
  link: string;
  uri?: string;
  raw: string;
}

interface Located {
  task: Task;
  note: LoadedNote;
  item: NoteItem;
  keyHash: string;
}

interface LoadedNote {
  ref: NoteRef;
  content: string;
  doc: NoteDoc;
}

export interface Context {
  cfg: Config;
  root: DailyRoot;
  today: string;
  sync: boolean;
  allowStale: boolean;
}

export function makeContext(cfg: Config, opts: { sync?: boolean; allowStale?: boolean } = {}): Context {
  return {
    cfg,
    root: new DailyRoot(cfg.vaultPath, cfg.dailyNotesDir, cfg.noteFormat),
    today: todayIn(timezoneOf(cfg)),
    sync: opts.sync ?? true,
    allowStale: opts.allowStale ?? false,
  };
}

// ---------------------------------------------------------------------------------------
// Loading & identity

function loadNote(ref: NoteRef): LoadedNote {
  const content = fs.readFileSync(ref.abs, 'utf8');
  return { ref, content, doc: splitNote(content) };
}

const keyHashOf = (vaultRel: string, p: ParsedLine) => sha(`${vaultRel}\0${identityText(p)}`);

function buildTasks(ctx: Context, note: LoadedNote): Located[] {
  const items = findTasks(note.doc, ctx.cfg.globalFilter);
  const headings: (string | undefined)[] = [];
  let current: string | undefined;
  note.doc.lines.forEach((l, i) => {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) current = h[1];
    headings[i] = current;
  });
  const noteDate = parseNoteDate(note.ref.rel.replace(/\.md$/i, ''), ctx.cfg.noteFormat) ?? undefined;
  const linkTarget = note.ref.vaultRel.replace(/\.md$/i, '');
  const byLine = new Map<number, string>();
  const out: Located[] = [];
  for (const item of items) {
    const p = item.parsed;
    const keyHash = keyHashOf(note.ref.vaultRel, p);
    const id = `${keyHash}:${item.lineIndex + 1}`;
    byLine.set(item.lineIndex, id);
    const f = p.fields;
    const task: Task = {
      id,
      rev: sha(p.raw, 8),
      status: statusType(p.statusSymbol, ctx.cfg.statuses),
      statusSymbol: p.statusSymbol,
      description: p.description,
      tags: p.tags,
      priority: priorityOf(p),
      due: f.due?.value,
      scheduled: f.scheduled?.value,
      start: f.start?.value,
      created: f.created?.value,
      done: f.done?.value,
      cancelled: f.cancelled?.value,
      recurrence: f.recurrence?.value,
      inlineFields: Object.keys(p.inlineFields).length ? p.inlineFields : undefined,
      file: note.ref.vaultRel,
      line: item.lineIndex + 1,
      noteDate,
      section: headings[item.lineIndex],
      depth: item.depth || undefined,
      parentId: item.parentLine !== null ? byLine.get(item.parentLine) : undefined,
      link: `[[${linkTarget}]]`,
      uri: ctx.cfg.vaultName
        ? `obsidian://open?vault=${encodeURIComponent(ctx.cfg.vaultName)}&file=${encodeURIComponent(linkTarget)}`
        : undefined,
      raw: p.raw,
    };
    out.push({ task, note, item, keyHash });
  }
  return out;
}

function scanAll(ctx: Context): { located: Located[]; warnings: string[] } {
  const { notes, skipped } = ctx.root.listNotes();
  const warnings = skipped.map((s) => `Skipped ${s.reason}: ${s.path}`);
  const located = notes.flatMap((ref) => buildTasks(ctx, loadNote(ref)));
  return { located, warnings };
}

const ID_RE = /^([0-9a-f]{10}):(\d+)$/;

function resolveId(located: Located[], id: string, rev?: string): Located {
  const m = ID_RE.exec(id.trim());
  if (!m) throw new TasksError('USAGE', `Malformed task id "${id}" (expected e.g. 3f2a9c01be:14)`);
  const line = Number(m[2]);
  const candidates = located.filter((l) => l.keyHash === m[1]);
  if (candidates.length === 0) {
    throw new TasksError('NOT_FOUND', 'Task not found. Its text may have been edited or it was deleted; search again.', { id });
  }
  let hit = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.task.line === line);
  if (!hit) {
    throw new TasksError('AMBIGUOUS', 'Several tasks in this note have identical text and the id no longer pins one down; search again and use a fresh id.', {
      id,
      candidates: candidates.map((c) => summarize(c.task)),
    });
  }
  if (rev && hit.task.rev !== rev) {
    throw new TasksError('STALE', 'Task changed since you last read it (possibly edited in Obsidian). Review the current version and retry.', {
      current: hit.task,
    });
  }
  return hit;
}

const summarize = (t: Task) => ({ id: t.id, rev: t.rev, status: t.status, description: t.description, file: t.file, line: t.line });

// ---------------------------------------------------------------------------------------
// Sync wrappers

export interface Envelope {
  sync: SyncResult | { ok: false; stale: true; error: string };
  warnings: string[];
}

function preSync(ctx: Context): Envelope {
  if (!ctx.sync) return { sync: { ok: true, skipped: true }, warnings: ['Sync skipped (--no-sync): results reflect the local copy only'] };
  const r = runSync(ctx.cfg);
  if (r.ok) return { sync: r, warnings: [] };
  if (ctx.allowStale) {
    return { sync: { ok: false, stale: true, error: r.output ?? 'sync failed' }, warnings: ['Sync failed; results may be out of date'] };
  }
  throw new TasksError('SYNC_FAILED', 'Could not sync with Obsidian Sync before reading; nothing was changed.', { output: r.output, exitCode: r.exitCode });
}

export function readOp<T>(ctx: Context, fn: (located: Located[]) => T): T & Envelope {
  return withLock(ctx.cfg, () => {
    const env = preSync(ctx);
    const { located, warnings } = scanAll(ctx);
    return { ...fn(located), ...env, warnings: [...env.warnings, ...warnings] };
  });
}

interface MutationOutcome {
  changed: boolean;
  note: NoteRef;
  /** the exact line that must exist after sync for the change to count as landed */
  expectLine: string;
  lineHint: number;
  extra?: Record<string, unknown>;
  warnings?: string[];
}

function mutationOp(ctx: Context, fn: (located: Located[]) => MutationOutcome) {
  return withLock(ctx.cfg, () => {
    let pre: SyncResult = { ok: true, skipped: true };
    if (ctx.sync) {
      pre = runSync(ctx.cfg);
      if (!pre.ok) throw new TasksError('SYNC_FAILED', 'Could not sync with Obsidian Sync; nothing was changed.', { output: pre.output, exitCode: pre.exitCode });
    }
    const conflictsBefore = new Set(ctx.root.conflictedCopies());
    const { located, warnings } = scanAll(ctx);
    const outcome = fn(located);
    warnings.push(...(outcome.warnings ?? []));
    let sync = pre;
    if (outcome.changed && ctx.sync) {
      sync = runSync(ctx.cfg);
      if (!sync.ok) {
        markPending(ctx.cfg, { file: outcome.note.vaultRel, line: outcome.expectLine });
        throw new TasksError('SYNC_FAILED',
          'The edit was written to the local vault but could NOT be pushed to Obsidian Sync. Do not report it as done. Retrying the same command is safe.',
          { localChangeApplied: true, file: outcome.note.vaultRel, output: sync.output });
      }
    } else if (!ctx.sync && outcome.changed) {
      warnings.push('Sync skipped (--no-sync): the change is local only until the next sync');
    }
    // Verify the edit survived the push (Obsidian Sync may merge concurrent edits).
    const after = fs.existsSync(outcome.note.abs) ? loadNote(outcome.note) : null;
    const newConflicts = ctx.root.conflictedCopies().filter((c) => !conflictsBefore.has(c));
    const relevant = newConflicts.filter((c) => c.startsWith(outcome.note.rel.replace(/\.md$/i, '')));
    if (!after || !after.doc.lines.includes(outcome.expectLine) || relevant.length) {
      throw new TasksError('CONFLICT', 'The note was changed concurrently on another device; the edit did not land as written. Re-read the task and retry.', {
        file: outcome.note.vaultRel,
        conflictedCopies: relevant,
      });
    }
    const fresh = buildTasks(ctx, after);
    const lineIdx = nearestLine(after.doc.lines, outcome.expectLine, outcome.lineHint);
    const task = fresh.find((l) => l.item.lineIndex === lineIdx)?.task;
    return { changed: outcome.changed, task, ...outcome.extra, sync, warnings };
  });
}

function nearestLine(lines: string[], target: string, hint: number): number {
  let best = -1;
  lines.forEach((l, i) => {
    if (l === target && (best < 0 || Math.abs(i - hint) < Math.abs(best - hint))) best = i;
  });
  return best;
}

/** Re-reads the note and refuses to write if it changed since it was parsed. */
function commit(note: LoadedNote, doc: NoteDoc): void {
  const current = fs.existsSync(note.ref.abs) ? fs.readFileSync(note.ref.abs, 'utf8') : null;
  if (current !== note.content) throw new TasksError('CONFLICT', 'Note changed while editing; nothing was written. Retry.', { file: note.ref.vaultRel });
  writeAtomic(note.ref.abs, joinNote(doc));
}

/** Replaces exactly one line and asserts nothing else changed. */
function replaceLine(loc: Located, newLine: string): MutationOutcome {
  const { note, item } = loc;
  if (newLine === item.parsed.raw) return { changed: false, note: note.ref, expectLine: newLine, lineHint: item.lineIndex };
  const doc: NoteDoc = { ...note.doc, lines: [...note.doc.lines] };
  doc.lines[item.lineIndex] = newLine;
  commit(note, doc);
  return { changed: true, note: note.ref, expectLine: newLine, lineHint: item.lineIndex };
}

// ---------------------------------------------------------------------------------------
// Queries

export interface Filters {
  status?: string;
  text?: string;
  tags?: string[];
  priority?: string;
  dueBefore?: string; dueAfter?: string; dueOn?: string;
  scheduledBefore?: string; scheduledAfter?: string; scheduledOn?: string;
  startBefore?: string; startAfter?: string; startOn?: string;
  happensBefore?: string; happensOnOrBefore?: string;
  hasDue?: boolean; noDue?: boolean;
  note?: string; from?: string; to?: string;
  sort?: string;
  limit?: number;
}

const STATUS_GROUPS: Record<string, StatusType[]> = {
  open: ['todo', 'in_progress'],
  todo: ['todo'],
  in_progress: ['in_progress'],
  done: ['done'],
  completed: ['done'],
  cancelled: ['cancelled'],
  closed: ['done', 'cancelled'],
  all: ['todo', 'in_progress', 'done', 'cancelled'],
};

function parsePriorities(spec: string): Priority[] {
  return spec.split(',').map((s) => s.trim().toLowerCase()).flatMap((s) => {
    const m = /^(>=|<=)?(\w+)$/.exec(s);
    const idx = m ? PRIORITY_ORDER.indexOf(m[2] as Priority) : -1;
    if (!m || idx < 0) throw new TasksError('USAGE', `Unknown priority "${s}". Use ${PRIORITY_ORDER.join(', ')} (optionally prefixed with >= or <=)`);
    if (m[1] === '>=') return PRIORITY_ORDER.slice(0, idx + 1);
    if (m[1] === '<=') return PRIORITY_ORDER.slice(idx);
    return [m[2] as Priority];
  });
}

/** A note given either as a date expression ("today", "2026-10-22") or a path inside the daily folder. */
function noteRef(ctx: Context, spec: string): NoteRef {
  if (!spec.includes('/') && !/\.md$/i.test(spec)) {
    try {
      return ctx.root.resolveNote(formatDate(resolveDate(spec, ctx.today), ctx.cfg.noteFormat));
    } catch (e) {
      if (!(e instanceof TasksError) || e.code !== 'USAGE') throw e;
    }
  }
  return ctx.root.resolveNote(spec);
}

export function applyFilters(ctx: Context, tasks: Task[], f: Filters): Task[] {
  const d = (e?: string) => (e ? resolveDate(e, ctx.today) : undefined);
  const statuses = STATUS_GROUPS[(f.status ?? 'all').toLowerCase()];
  if (!statuses) throw new TasksError('USAGE', `Unknown status "${f.status}". Use ${Object.keys(STATUS_GROUPS).join(', ')}`);
  const priorities = f.priority ? new Set(parsePriorities(f.priority)) : null;
  const terms = (f.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const tags = (f.tags ?? []).map((t) => edit.normalizeTag(t).toLowerCase());
  const noteRel = f.note ? noteRef(ctx, f.note).vaultRel : null;
  const range = (v: string | undefined, before?: string, after?: string, on?: string) =>
    (!before || (v !== undefined && v < before)) && (!after || (v !== undefined && v > after)) && (!on || v === on);
  const [dueB, dueA, dueO, schB, schA, schO, stB, stA, stO, hapB, hapOB, from, to] = [
    f.dueBefore, f.dueAfter, f.dueOn, f.scheduledBefore, f.scheduledAfter, f.scheduledOn,
    f.startBefore, f.startAfter, f.startOn, f.happensBefore, f.happensOnOrBefore, f.from, f.to,
  ].map(d);

  let out = tasks.filter((t) => {
    if (!statuses.includes(t.status)) return false;
    if (priorities && !priorities.has(t.priority)) return false;
    if (terms.length) {
      const hay = `${t.description} ${t.file}`.toLowerCase();
      if (!terms.every((term) => hay.includes(term))) return false;
    }
    if (tags.length && !tags.every((tag) => t.tags.some((x) => x.toLowerCase() === tag || x.toLowerCase().startsWith(tag + '/')))) return false;
    if (f.hasDue && !t.due) return false;
    if (f.noDue && t.due) return false;
    if (!range(t.due, dueB, dueA, dueO)) return false;
    if (!range(t.scheduled, schB, schA, schO)) return false;
    if (!range(t.start, stB, stA, stO)) return false;
    if (hapB || hapOB) {
      const dates = [t.due, t.scheduled, t.start].filter(Boolean) as string[];
      if (!dates.some((x) => (hapB ? x < hapB : true) && (hapOB ? x <= hapOB : true))) return false;
    }
    if (noteRel && t.file !== noteRel) return false;
    if (from && (!t.noteDate || t.noteDate < from)) return false;
    if (to && (!t.noteDate || t.noteDate > to)) return false;
    return true;
  });

  const sort = f.sort ?? 'due';
  const far = '9999-99-99';
  const byFile = (a: Task, b: Task) => a.file.localeCompare(b.file) || a.line - b.line;
  const byPrio = (a: Task, b: Task) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
  const cmp: Record<string, (a: Task, b: Task) => number> = {
    due: (a, b) => (a.due ?? far).localeCompare(b.due ?? far) || byPrio(a, b) || byFile(a, b),
    scheduled: (a, b) => (a.scheduled ?? far).localeCompare(b.scheduled ?? far) || byPrio(a, b) || byFile(a, b),
    priority: (a, b) => byPrio(a, b) || (a.due ?? far).localeCompare(b.due ?? far) || byFile(a, b),
    file: byFile,
    note: (a, b) => (b.noteDate ?? '').localeCompare(a.noteDate ?? '') || byFile(a, b),
  };
  if (!cmp[sort]) throw new TasksError('USAGE', `Unknown sort "${sort}". Use ${Object.keys(cmp).join(', ')}`);
  out = out.sort(cmp[sort]);
  return out;
}

export function list(ctx: Context, f: Filters) {
  return readOp(ctx, (located) => {
    const all = applyFilters(ctx, located.map((l) => l.task), f);
    const limit = f.limit ?? 100;
    return { today: ctx.today, total: all.length, truncated: all.length > limit, tasks: all.slice(0, limit) };
  });
}

export function get(ctx: Context, id: string) {
  return readOp(ctx, (located) => {
    const hit = resolveId(located, id);
    const children = located.filter((l) => l.task.parentId === hit.task.id).map((l) => summarize(l.task));
    const parent = hit.task.parentId ? located.find((l) => l.task.id === hit.task.parentId)?.task : undefined;
    return { today: ctx.today, task: hit.task, parent: parent && summarize(parent), children };
  });
}

// ---------------------------------------------------------------------------------------
// Mutations

function guardRecurring(t: Task, action: string) {
  if (t.recurrence) {
    throw new TasksError('UNSUPPORTED',
      `"${t.description}" is a recurring task (🔁 ${t.recurrence}). ${action} it from Obsidian so the Tasks plugin can create the next occurrence.`,
      { task: summarize(t) });
  }
}

function verify(line: string, check: (p: ParsedLine) => boolean, what: string): string {
  const p = parseTaskLine(line);
  if (!p || !check(p)) throw new TasksError('INTERNAL', `Refusing to write: result failed verification (${what})`, { line });
  return line;
}

export function complete(ctx: Context, id: string, opts: { rev?: string; date?: string } = {}) {
  return mutationOp(ctx, (located) => {
    const hit = resolveId(located, id, opts.rev);
    if (hit.task.status === 'done') return { ...replaceLine(hit, hit.item.parsed.raw), extra: { alreadyInState: true } };
    guardRecurring(hit.task, 'Complete');
    const doneDate = opts.date ? resolveDate(opts.date, ctx.today) : ctx.today;
    let line = edit.setStatus(hit.item.parsed.raw, 'x');
    line = edit.setDateField(line, 'cancelled', null);
    line = edit.setDateField(line, 'done', doneDate);
    verify(line, (p) => p.statusSymbol === 'x' && p.fields.done?.value === doneDate && identityText(p) === identityText(hit.item.parsed), 'complete');
    return replaceLine(hit, line);
  });
}

export function reopen(ctx: Context, id: string, opts: { rev?: string } = {}) {
  return mutationOp(ctx, (located) => {
    const hit = resolveId(located, id, opts.rev);
    if (hit.task.status === 'todo' || hit.task.status === 'in_progress') {
      return { ...replaceLine(hit, hit.item.parsed.raw), extra: { alreadyInState: true } };
    }
    let line = edit.setStatus(hit.item.parsed.raw, ' ');
    line = edit.setDateField(line, 'done', null);
    line = edit.setDateField(line, 'cancelled', null);
    verify(line, (p) => p.statusSymbol === ' ' && !p.fields.done && !p.fields.cancelled, 'reopen');
    const out = replaceLine(hit, line);
    return hit.task.recurrence
      ? { ...out, extra: { warning: 'Recurring task reopened. If Obsidian already generated the next occurrence, it is still there.' } }
      : out;
  });
}

export interface UpdateSpec {
  rev?: string;
  text?: string;
  due?: string | null;
  scheduled?: string | null;
  start?: string | null;
  priority?: string;
  addTags?: string[];
  removeTags?: string[];
  status?: string;
}

export function update(ctx: Context, id: string, spec: UpdateSpec) {
  return mutationOp(ctx, (located) => {
    const hit = resolveId(located, id, spec.rev);
    const before = hit.item.parsed;
    let line = before.raw;
    const expect: ((p: ParsedLine) => boolean)[] = [];

    if (spec.text !== undefined) {
      const text = spec.text.trim();
      if (!text || /[\r\n]/.test(text)) throw new TasksError('USAGE', '--text must be a single non-empty line');
      line = edit.setDescription(line, text);
      const p = parseTaskLine(line);
      // Text must not smuggle in metadata or swallow existing metadata.
      const fieldsBefore = JSON.stringify(Object.entries(before.fields).map(([k, v]) => [k, v!.value]).sort());
      const fieldsAfter = p && JSON.stringify(Object.entries(p.fields).map(([k, v]) => [k, v!.value]).sort());
      if (fieldsBefore !== fieldsAfter) throw new TasksError('USAGE', 'New text contains task metadata (dates/priority emoji). Use --due/--scheduled/--start/--priority instead.');
    }
    for (const name of ['due', 'scheduled', 'start'] as DateField[]) {
      const v = spec[name as 'due' | 'scheduled' | 'start'];
      if (v === undefined) continue;
      const value = v === null || ['none', 'null', ''].includes(v.trim().toLowerCase()) ? null : resolveDate(v, ctx.today);
      line = edit.setDateField(line, name, value);
      expect.push((p) => (p.fields[name]?.value ?? null) === value);
    }
    if (spec.priority !== undefined) {
      const pr = spec.priority.toLowerCase() as Priority;
      if (!PRIORITY_ORDER.includes(pr)) throw new TasksError('USAGE', `Unknown priority "${spec.priority}"`);
      line = edit.setPriority(line, pr);
      expect.push((p) => priorityOf(p) === pr);
    }
    for (const t of spec.addTags ?? []) {
      const tag = edit.normalizeTag(t);
      line = edit.addTag(line, tag);
      expect.push((p) => p.tags.includes(tag));
    }
    for (const t of spec.removeTags ?? []) {
      const tag = edit.normalizeTag(t);
      line = edit.removeTag(line, tag);
      expect.push((p) => !p.tags.includes(tag));
    }
    if (spec.status !== undefined) {
      const s = spec.status.toLowerCase();
      if (s === 'done') throw new TasksError('USAGE', 'Use "tasks complete" to complete a task');
      const symbol = { todo: ' ', in_progress: '/', cancelled: '-' }[s];
      if (symbol === undefined) throw new TasksError('USAGE', `Unknown status "${spec.status}". Use todo, in_progress or cancelled`);
      if (s === 'cancelled' && hit.task.status !== 'cancelled') {
        guardRecurring(hit.task, 'Cancel');
        line = edit.setDateField(edit.setDateField(line, 'done', null), 'cancelled', ctx.today);
      } else if (s !== 'cancelled') {
        line = edit.setDateField(edit.setDateField(line, 'done', null), 'cancelled', null);
      }
      line = edit.setStatus(line, symbol);
      expect.push((p) => p.statusSymbol === symbol);
    }
    verify(line, (p) => expect.every((fn) => fn(p)) && p.indent === before.indent && p.bullet === before.bullet, 'update');
    return replaceLine(hit, line);
  });
}

export interface AddSpec {
  text: string;
  date?: string;
  file?: string;
  heading?: string;
  parent?: string;
  due?: string;
  scheduled?: string;
  start?: string;
  priority?: string;
  tags?: string[];
  inlineFields?: string[];
  createNote?: boolean;
  allowDuplicate?: boolean;
}

/** Core-template style variables, plus Periodic Notes offsets like {{date+1d:YYYY-MM-DD}}. */
function renderTemplate(tpl: string, iso: string, title: string): string {
  return tpl
    .replace(/{{\s*date\s*([+-]\d+[dwm])?\s*:\s*([^}]+?)\s*}}/g, (_, off, fmt) => formatDate(off ? resolveDate(off, iso) : iso, fmt))
    .replace(/{{\s*date\s*([+-]\d+[dwm])\s*}}/g, (_, off) => resolveDate(off, iso))
    .replace(/{{\s*date\s*}}/g, iso)
    .replace(/{{\s*title\s*}}/g, title);
}

export function add(ctx: Context, spec: AddSpec) {
  return mutationOp(ctx, (located) => {
    const text = spec.text.trim();
    if (!text || /[\r\n]/.test(text)) throw new TasksError('USAGE', '--text must be a single non-empty line');

    // Target note
    let ref: NoteRef;
    let noteDate: string | undefined;
    const parentHit = spec.parent ? resolveId(located, spec.parent) : undefined;
    if (parentHit) ref = parentHit.note.ref;
    else if (spec.file) ref = ctx.root.resolveNote(spec.file);
    else {
      noteDate = resolveDate(spec.date ?? 'today', ctx.today);
      ref = ctx.root.resolveNote(formatDate(noteDate, ctx.cfg.noteFormat));
    }
    let note: LoadedNote;
    let created = false;
    if (fs.existsSync(ref.abs)) note = loadNote(ref);
    else {
      if (!spec.createNote) {
        throw new TasksError('NOTE_NOT_FOUND', `Note ${ref.vaultRel} does not exist. Ask the user whether to create it (then pass --create-note), or add the task to an existing note.`, { file: ref.vaultRel });
      }
      const title = ref.rel.split('/').pop()!.replace(/\.md$/i, '');
      const iso = noteDate ?? parseNoteDate(ref.rel.replace(/\.md$/i, ''), ctx.cfg.noteFormat) ?? ctx.today;
      const content = ctx.cfg.template ? renderTemplate(ctx.root.readVaultFile(ctx.cfg.template), iso, title) : '';
      note = { ref, content, doc: splitNote(content) };
      created = true;
    }

    // Build the line
    const priority = spec.priority ? (spec.priority.toLowerCase() as Priority) : 'none';
    if (!PRIORITY_ORDER.includes(priority)) throw new TasksError('USAGE', `Unknown priority "${spec.priority}"`);
    const dates: Partial<Record<DateField, string>> = {};
    if (ctx.cfg.setCreatedDate) dates.created = ctx.today;
    for (const k of ['start', 'scheduled', 'due'] as const) if (spec[k]) dates[k] = resolveDate(spec[k]!, ctx.today);
    const tags = (spec.tags ?? []).map(edit.normalizeTag).filter((t) => !text.split(/\s+/).includes(t));
    const inline = (spec.inlineFields ?? []).map((kv) => {
      const m = /^([^=:\[\]]+)=(.*)$/.exec(kv);
      if (!m) throw new TasksError('USAGE', `--field expects key=value, got "${kv}"`);
      return `[${m[1].trim()}:: ${m[2].trim()}]`;
    });
    const items = findTasks(note.doc, ctx.cfg.globalFilter);
    const bullet = ctx.cfg.bullet ?? (items.length ? items[items.length - 1].parsed.bullet : '-');
    let indent = '';
    if (parentHit) {
      const pi = parentHit.item.parsed.indent;
      const usesTabs = pi.includes('\t') || note.doc.lines.some((l) => /^\t+([-*+]|\d+[.)])\s/.test(l));
      indent = pi + (usesTabs ? '\t' : '    ');
    }
    const parts = [
      text, ...tags, ...inline,
      priority !== 'none' ? PRIORITY_EMOJI[priority] : '',
      ...(['created', 'start', 'scheduled', 'due'] as DateField[]).map((k) => (dates[k] ? `${DATE_FIELD_EMOJI[k]} ${dates[k]}` : '')),
    ].filter(Boolean);
    const newLine = `${indent}${parentHit ? parentHit.item.parsed.bullet : bullet} [ ] ${parts.join(' ')}`;
    verify(newLine, (p) =>
      priorityOf(p) === priority &&
      (['created', 'start', 'scheduled', 'due', 'done', 'cancelled'] as DateField[]).every((k) => (p.fields[k]?.value ?? undefined) === dates[k]) &&
      !p.fields.recurrence, 'add: --text must not contain task metadata emoji');
    const newParsed = parseTaskLine(newLine, ctx.cfg.globalFilter);
    if (!newParsed) throw new TasksError('USAGE', `New task does not contain the global filter "${ctx.cfg.globalFilter}"`);

    // Idempotency: an identical open task already in this note means a retry, not a new task.
    if (!spec.allowDuplicate) {
      const key = identityText(newParsed);
      const dup = items.find((it) => identityText(it.parsed) === key && ['todo', 'in_progress'].includes(statusType(it.parsed.statusSymbol, ctx.cfg.statuses)));
      if (dup) {
        return { changed: false, note: note.ref, expectLine: dup.parsed.raw, lineHint: dup.lineIndex, extra: { created: false, alreadyExisted: true } };
      }
    }

    // Insertion point
    const lines = note.doc.lines;
    const lastNonBlank = (from: number, to: number) => {
      for (let i = to - 1; i >= from; i--) if (lines[i].trim() !== '') return i;
      return -1;
    };
    let insertAt: number;
    const warnings: string[] = [];
    const heading = spec.heading ?? ctx.cfg.heading;
    if (parentHit) {
      // after the parent's existing children (and their continuation lines)
      const depths = new Map(findTasksAll(note.doc).map((x) => [x.line, x.depth]));
      const pd = depths.get(parentHit.item.lineIndex)!;
      insertAt = parentHit.item.lineIndex + 1;
      for (let j = insertAt; j < lines.length; j++) {
        const d = depths.get(j);
        if (d !== undefined ? d > pd : lines[j].trim() !== '' && /^\s/.test(lines[j])) insertAt = j + 1;
        else break;
      }
    } else if (heading) {
      const want = heading.replace(/^#+\s*/, '').trim().toLowerCase();
      const hIdx = lines.findIndex((l) => {
        const m = /^(#{1,6})\s+(.*?)\s*$/.exec(l);
        return m && m[2].toLowerCase() === want;
      });
      if (hIdx < 0) {
        if (spec.heading) throw new TasksError('NOT_FOUND', `Heading "${heading}" not found in ${note.ref.vaultRel}`);
        warnings.push(`Heading "${heading}" not found; task appended to the end of the note`);
        insertAt = -1;
      } else {
        const level = /^(#+)/.exec(lines[hIdx])![1].length;
        let end = lines.findIndex((l, i) => i > hIdx && /^(#{1,6})\s/.test(l) && /^(#+)/.exec(l)![1].length <= level);
        if (end < 0) end = lines.length;
        // after the section's last task (and its children), else after its last content line
        const lastTask = items.filter((it) => it.lineIndex > hIdx && it.lineIndex < end).pop();
        if (lastTask) {
          insertAt = lastTask.lineIndex + 1;
          while (insertAt < end && lines[insertAt].trim() !== '' && /^\s/.test(lines[insertAt])) insertAt++;
        } else {
          const last = lastNonBlank(hIdx + 1, end);
          insertAt = (last < 0 ? hIdx : last) + 1;
        }
      }
    } else insertAt = -1;
    // A trailing empty bullet ("* " left by a template) is a placeholder: fill it instead of adding below it.
    let fillPlaceholder = false;
    if (insertAt < 0) {
      const last = lastNonBlank(0, lines.length);
      fillPlaceholder = last >= 0 && /^[-*+][ \t]*$/.test(lines[last]);
      insertAt = fillPlaceholder ? last : last + 1;
    }

    const doc: NoteDoc = { ...note.doc, lines: [...lines], cr: [...note.doc.cr] };
    const crlf = doc.cr.some(Boolean);
    if (fillPlaceholder) doc.lines[insertAt] = newLine;
    else {
      doc.lines.splice(insertAt, 0, newLine);
      doc.cr.splice(insertAt, 0, crlf);
    }
    if (created) writeAtomic(note.ref.abs, joinNote(doc), { mustNotExist: true });
    else commit(note, doc);
    return { changed: true, note: note.ref, expectLine: newLine, lineHint: insertAt, warnings, extra: { created: true, noteCreated: created } };
  });
}

/** All list items with depth (used to place sub-tasks after a parent's existing children). */
function findTasksAll(doc: NoteDoc): { line: number; depth: number }[] {
  const out: { line: number; depth: number }[] = [];
  const stack: number[] = [];
  doc.lines.forEach((l, i) => {
    const m = /^([\s>]*)([-*+]|\d+[.)])(\s|$)/.exec(l);
    if (!m) {
      if (l.trim() !== '' && !/^\s/.test(l)) stack.length = 0;
      return;
    }
    const w = m[1].replace(/>/g, '').replace(/\t/g, '    ').length;
    while (stack.length && stack[stack.length - 1] >= w) stack.pop();
    stack.push(w);
    out.push({ line: i, depth: stack.length - 1 });
  });
  return out;
}

export function syncNow(ctx: Context) {
  return withLock(ctx.cfg, () => {
    const sync = runSync(ctx.cfg);
    const conflictedCopies = ctx.root.conflictedCopies();
    if (!sync.ok) throw new TasksError('SYNC_FAILED', 'Sync with Obsidian Sync failed', { output: sync.output, exitCode: sync.exitCode });
    return { sync, conflictedCopies, warnings: conflictedCopies.length ? ['Conflicted copies exist in the daily notes folder; ask the user to resolve them in Obsidian'] : [] };
  });
}
