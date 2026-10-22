// Pure, surgical edits to a single task line. Each function changes only the bytes it
// must and leaves everything else (unknown fields, links, spacing) exactly as it was.
import { TasksError } from './errors.js';
import { DATE_FIELD_EMOJI, PRIORITY_EMOJI, parseTaskLine, type DateField, type ParsedLine, type Priority } from './parser.js';

function reparse(line: string): ParsedLine {
  const p = parseTaskLine(line);
  if (!p) throw new TasksError('INTERNAL', 'Edited line is no longer a task', { line });
  return p;
}

function insertAt(line: string, at: number, token: string): string {
  const sep = at > 0 && !/\s/.test(line[at - 1]) ? ' ' : '';
  return line.slice(0, at) + sep + token + line.slice(at);
}

export function setStatus(line: string, symbol: string): string {
  const p = reparse(line);
  return line.slice(0, p.statusIndex) + symbol + line.slice(p.statusIndex + p.statusSymbol.length);
}

export function setDateField(line: string, name: DateField, value: string | null): string {
  const p = reparse(line);
  if (p.duplicateFields.includes(name)) {
    throw new TasksError('UNSUPPORTED', `Task has more than one ${name} date; edit it in Obsidian`, { line });
  }
  const f = p.fields[name];
  if (value === null) return f ? line.slice(0, f.removeStart) + line.slice(f.end) : line;
  if (f) return line.slice(0, f.end - f.value.length) + value + line.slice(f.end);
  return insertAt(line, p.appendAt, `${DATE_FIELD_EMOJI[name]} ${value}`);
}

export function setPriority(line: string, priority: Priority): string {
  const p = reparse(line);
  if (p.duplicateFields.includes('priority')) {
    throw new TasksError('UNSUPPORTED', 'Task has more than one priority marker; edit it in Obsidian', { line });
  }
  const f = p.fields.priority;
  if (priority === 'none') return f ? line.slice(0, f.removeStart) + line.slice(f.end) : line;
  const emoji = PRIORITY_EMOJI[priority];
  if (f) return line.slice(0, f.start) + emoji + line.slice(f.end);
  return insertAt(line, p.appendAt, emoji);
}

/** Replaces the description text; trailing tags and all metadata are kept. */
export function setDescription(line: string, text: string): string {
  const p = reparse(line);
  const rest = line.slice(p.descEnd);
  const sep = rest && !/^\s/.test(rest) ? ' ' : '';
  return line.slice(0, p.bodyStart) + text + sep + rest;
}

export function addTag(line: string, tag: string): string {
  const p = reparse(line);
  if (p.tags.includes(tag)) return line;
  return insertAt(line, p.descEnd, tag);
}

export function removeTag(line: string, tag: string): string {
  const p = reparse(line);
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\s+)${esc}(?=\\s|$)`, 'u');
  let body = line.slice(p.bodyStart);
  // a tag at the very start of the body has no leading whitespace to consume
  if (body.startsWith(tag) && (body.length === tag.length || /\s/.test(body[tag.length]))) {
    body = body.slice(tag.length).replace(/^\s+/, '');
  }
  for (let m = re.exec(body); m; m = re.exec(body)) body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
  return line.slice(0, p.bodyStart) + body;
}

export function normalizeTag(tag: string): string {
  const t = tag.startsWith('#') ? tag : `#${tag}`;
  if (!/^#[^\s!@#$%^&*(),.?":{}|<>]+$/u.test(t)) throw new TasksError('USAGE', `Invalid tag: ${tag}`);
  return t;
}
