// Parser for Obsidian Tasks-plugin task lines (emoji format), modelled on the plugin's
// DefaultTaskSerializer: metadata is read from the END of the line backwards, so
// anything the plugin would not treat as a field stays part of the description.
// Every field keeps its character offsets so edits can be applied surgically.

export type FieldName =
  | 'priority' | 'start' | 'created' | 'scheduled' | 'due' | 'done' | 'cancelled'
  | 'recurrence' | 'onCompletion' | 'dependsOn' | 'id';

export type Priority = 'highest' | 'high' | 'medium' | 'none' | 'low' | 'lowest';
export type StatusType = 'todo' | 'in_progress' | 'done' | 'cancelled';

export const PRIORITY_EMOJI: Record<Exclude<Priority, 'none'>, string> = {
  highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬',
};
const EMOJI_PRIORITY: Record<string, Priority> = Object.fromEntries(
  Object.entries(PRIORITY_EMOJI).map(([k, v]) => [v, k as Priority]),
);
export const PRIORITY_ORDER: Priority[] = ['highest', 'high', 'medium', 'none', 'low', 'lowest'];

export const DATE_FIELD_EMOJI = { start: '🛫', created: '➕', scheduled: '⏳', due: '📅', done: '✅', cancelled: '❌' } as const;
export type DateField = keyof typeof DATE_FIELD_EMOJI;

const DATE = '(\\d{4}-\\d{2}-\\d{2})';
const VS = '\\uFE0F?';
const FIELD_PATTERNS: { name: FieldName; re: RegExp }[] = [
  { name: 'priority', re: new RegExp(`(🔺|⏫|🔼|🔽|⏬)${VS}$`, 'u') },
  { name: 'start', re: new RegExp(`🛫${VS} *${DATE}$`, 'u') },
  { name: 'created', re: new RegExp(`➕${VS} *${DATE}$`, 'u') },
  { name: 'scheduled', re: new RegExp(`(?:⏳|⌛)${VS} *${DATE}$`, 'u') },
  { name: 'due', re: new RegExp(`(?:📅|📆|🗓)${VS} *${DATE}$`, 'u') },
  { name: 'done', re: new RegExp(`✅${VS} *${DATE}$`, 'u') },
  { name: 'cancelled', re: new RegExp(`❌${VS} *${DATE}$`, 'u') },
  { name: 'recurrence', re: new RegExp(`🔁${VS} *([a-zA-Z0-9, !]+)$`, 'iu') },
  { name: 'onCompletion', re: new RegExp(`🏁${VS} *([a-zA-Z]+)$`, 'iu') },
  { name: 'dependsOn', re: new RegExp(`⛔${VS} *([a-zA-Z0-9-_]+( *, *[a-zA-Z0-9-_]+ *)*)$`, 'iu') },
  { name: 'id', re: new RegExp(`🆔${VS} *([a-zA-Z0-9-_]+)$`, 'iu') },
];
const TAG_FROM_END = /(^|\s)(#[^ !@#$%^&*(),.?":{}|<>]+)$/u;
const TAG_ALL = /(^|\s)(#[^\s!@#$%^&*(),.?":{}|<>]+)/gu;
const BLOCK_LINK = / \^[a-zA-Z0-9-]+$/u;
const INLINE_FIELD = /\[([^[\]:]+?)::\s*([^\]]*)\]|\(([^()[\]:]+?)::\s*([^)]*)\)/g;

export const TASK_LINE = /^([\s>]*)([-*+]|\d+[.)])( +)\[(.)\]( *)(.*)$/u;
const LIST_LINE = /^([\s>]*)([-*+]|\d+[.)])(\s|$)/u;
const FENCE = /^[\s>]*(`{3,}|~{3,})/;

export interface FieldSpan {
  value: string;
  /** offset (in the full line) where the field's emoji starts */
  start: number;
  /** offset just after the field's value */
  end: number;
  /** offset to remove from when deleting the field (includes the preceding whitespace) */
  removeStart: number;
}

export interface ParsedLine {
  raw: string;
  indent: string;
  bullet: string;
  statusSymbol: string;
  statusIndex: number;
  bodyStart: number;
  /** offset where description text ends and the trailing metadata region begins */
  descEnd: number;
  /** offset where new metadata can be appended (end of line, before any ^block-link) */
  appendAt: number;
  fields: Partial<Record<FieldName, FieldSpan>>;
  duplicateFields: FieldName[];
  blockLink: string | null;
  description: string;
  tags: string[];
  inlineFields: Record<string, string>;
}

/** Status type for a checkbox symbol; `overrides` mirrors custom statuses from the Tasks plugin settings. */
export function statusType(symbol: string, overrides?: Record<string, StatusType>): StatusType {
  if (overrides?.[symbol]) return overrides[symbol];
  if (symbol === 'x' || symbol === 'X') return 'done';
  if (symbol === '-') return 'cancelled';
  if (symbol === '/') return 'in_progress';
  // The Tasks plugin treats unknown status symbols as TODO.
  return 'todo';
}

function trimEndAt(s: string, end: number, min: number): number {
  while (end > min && /\s/.test(s[end - 1])) end--;
  return end;
}

export function parseTaskLine(line: string, globalFilter = ''): ParsedLine | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const [, indent, bullet, gap, statusSymbol, afterStatus] = m;
  const statusIndex = indent.length + bullet.length + gap.length + 1;
  const bodyStart = statusIndex + statusSymbol.length + 1 + afterStatus.length;
  if (globalFilter && !line.slice(bodyStart).includes(globalFilter)) return null;

  let end = trimEndAt(line, line.length, bodyStart);
  let blockLink: string | null = null;
  const bl = BLOCK_LINK.exec(line.slice(bodyStart, end));
  let appendAt = end;
  if (bl) {
    blockLink = bl[0].trim();
    end = trimEndAt(line, bodyStart + bl.index, bodyStart);
    appendAt = end;
  }

  const fields: ParsedLine['fields'] = {};
  const duplicateFields: FieldName[] = [];
  const spans: [number, number][] = [];
  for (let runs = 0; runs < 25; runs++) {
    let matched = false;
    for (const { name, re } of FIELD_PATTERNS) {
      const fm = re.exec(line.slice(bodyStart, end));
      if (!fm) continue;
      const start = bodyStart + fm.index;
      const removeStart = trimEndAt(line, start, bodyStart);
      const value = (fm[1] ?? fm[0]).trim();
      if (fields[name]) duplicateFields.push(name);
      else fields[name] = { value, start, end, removeStart };
      spans.push([start, end]);
      end = removeStart;
      matched = true;
    }
    const tm = TAG_FROM_END.exec(line.slice(bodyStart, end));
    if (tm) {
      end = trimEndAt(line, bodyStart + tm.index + tm[1].length, bodyStart);
      matched = true;
    }
    if (!matched) break;
  }
  const descEnd = end;

  // Description = body minus metadata spans, whitespace-normalised (like the plugin's).
  let body = '';
  let cursor = bodyStart;
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    body += line.slice(cursor, s) + ' ';
    cursor = e;
  }
  body += line.slice(cursor, blockLink ? appendAt : line.length);
  const description = body.replace(/\s+/g, ' ').trim();
  const tags = [...description.matchAll(TAG_ALL)].map((t) => t[2]);
  const inlineFields: Record<string, string> = {};
  for (const f of description.matchAll(INLINE_FIELD)) {
    inlineFields[(f[1] ?? f[3]).trim()] = (f[2] ?? f[4]).trim();
  }

  return {
    raw: line, indent, bullet, statusSymbol, statusIndex, bodyStart, descEnd, appendAt,
    fields, duplicateFields, blockLink, description, tags, inlineFields,
  };
}

export function priorityOf(p: ParsedLine): Priority {
  const v = p.fields.priority?.value;
  return v ? EMOJI_PRIORITY[v.replace('️', '')] ?? 'none' : 'none';
}

/** Identity text: description without tags or metadata. Stable across status/date/tag edits. */
export function identityText(p: ParsedLine): string {
  return p.description.replace(TAG_ALL, '$1').replace(/\s+/g, ' ').trim();
}

export function indentWidth(indent: string): number {
  let w = 0;
  for (const ch of indent.replace(/>/g, '')) w += ch === '\t' ? 4 : 1;
  return w;
}

export interface NoteDoc {
  bom: boolean;
  lines: string[];
  cr: boolean[];
}

export function splitNote(content: string): NoteDoc {
  const bom = content.startsWith('﻿');
  const parts = (bom ? content.slice(1) : content).split('\n');
  const cr = parts.map((l) => l.endsWith('\r'));
  return { bom, lines: parts.map((l, i) => (cr[i] ? l.slice(0, -1) : l)), cr };
}

export function joinNote(doc: NoteDoc): string {
  return (doc.bom ? '﻿' : '') + doc.lines.map((l, i) => l + (doc.cr[i] ? '\r' : '')).join('\n');
}

export interface NoteItem {
  lineIndex: number;
  parsed: ParsedLine;
  depth: number;
  parentLine: number | null;
}

/** Finds task lines, skipping YAML frontmatter and fenced code blocks. */
export function findTasks(doc: NoteDoc, globalFilter = ''): NoteItem[] {
  const items: NoteItem[] = [];
  const stack: { width: number; line: number }[] = [];
  let i = 0;
  if (doc.lines[0] === '---') {
    const close = doc.lines.findIndex((l, j) => j > 0 && (l === '---' || l === '...'));
    if (close > 0) i = close + 1;
  }
  let fence: string | null = null;
  for (; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const lm = LIST_LINE.exec(line);
    if (!lm) {
      if (line.trim() !== '' && !/^\s/.test(line)) stack.length = 0;
      continue;
    }
    const width = indentWidth(lm[1]);
    while (stack.length && stack[stack.length - 1].width >= width) stack.pop();
    const parentLine = stack.length ? stack[stack.length - 1].line : null;
    stack.push({ width, line: i });
    const parsed = parseTaskLine(line, globalFilter);
    if (parsed) items.push({ lineIndex: i, parsed, depth: stack.length - 1, parentLine });
  }
  return items;
}
