import { TasksError } from './errors.js';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function todayIn(tz: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isRealDate(iso: string): boolean {
  return ISO_DATE.test(iso) && fromUtc(toUtc(iso)) === iso;
}

export function addDays(iso: string, days: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function addMonths(iso: string, months: number): string {
  const d = toUtc(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return fromUtc(d);
}

export function weekday(iso: string): number {
  return toUtc(iso).getUTCDay();
}

/**
 * Resolves a date expression relative to `today` (already in the configured timezone).
 * Accepts: YYYY-MM-DD, today, tomorrow, yesterday, +3d / -2w / +1m, and weekday names
 * (the next occurrence on or after today; "next <weekday>" is strictly after today).
 */
export function resolveDate(expr: string, today: string): string {
  const e = expr.trim().toLowerCase();
  if (ISO_DATE.test(e)) {
    if (!isRealDate(e)) throw new TasksError('USAGE', `Invalid calendar date: ${expr}`);
    return e;
  }
  if (e === 'today') return today;
  if (e === 'tomorrow') return addDays(today, 1);
  if (e === 'yesterday') return addDays(today, -1);
  const rel = /^([+-])(\d+)([dwm])$/.exec(e);
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === '-' ? -1 : 1);
    if (rel[3] === 'd') return addDays(today, n);
    if (rel[3] === 'w') return addDays(today, n * 7);
    return addMonths(today, n);
  }
  const wd = /^(next\s+)?([a-z]+)$/.exec(e);
  if (wd) {
    const idx = WEEKDAYS.findIndex((w) => w === wd[2] || w.slice(0, 3) === wd[2]);
    if (idx >= 0) {
      let delta = (idx - weekday(today) + 7) % 7;
      if (wd[1] && delta === 0) delta = 7;
      return addDays(today, delta);
    }
  }
  throw new TasksError('USAGE', `Unrecognized date "${expr}". Use YYYY-MM-DD, today, tomorrow, yesterday, +Nd/+Nw/+Nm, or a weekday name.`);
}

type Token = { kind: 'lit'; text: string } | { kind: 'tok'; tok: string };

const TOKEN_RE = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D/g;

function tokenize(format: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of format.matchAll(TOKEN_RE)) {
    if (m.index! > last) out.push({ kind: 'lit', text: format.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: 'lit', text: m[1] } : { kind: 'tok', tok: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < format.length) out.push({ kind: 'lit', text: format.slice(last) });
  return out;
}

/** Formats an ISO date using a subset of moment.js tokens (as used by Obsidian Daily Notes). */
export function formatDate(iso: string, format: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAYS[weekday(iso)];
  return tokenize(format)
    .map((t) => {
      if (t.kind === 'lit') return t.text;
      switch (t.tok) {
        case 'YYYY': return String(y);
        case 'YY': return String(y).slice(2);
        case 'MMMM': return MONTHS[m - 1];
        case 'MMM': return MONTHS[m - 1].slice(0, 3);
        case 'MM': return String(m).padStart(2, '0');
        case 'M': return String(m);
        case 'dddd': return wd[0].toUpperCase() + wd.slice(1);
        case 'ddd': return wd[0].toUpperCase() + wd.slice(1, 3);
        case 'DD': return String(d).padStart(2, '0');
        case 'D': return String(d);
      }
      return '';
    })
    .join('');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extracts the ISO date from a note path (relative to the daily root, without ".md"), or null. */
export function parseNoteDate(relPathNoExt: string, format: string): string | null {
  let y: string | undefined, m: string | undefined, d: string | undefined;
  const groups: string[] = [];
  const pattern = tokenize(format)
    .map((t) => {
      if (t.kind === 'lit') return escapeRe(t.text);
      groups.push(t.tok);
      switch (t.tok) {
        case 'YYYY': return '(\\d{4})';
        case 'YY': return '(\\d{2})';
        case 'MMMM': return `(${MONTHS.join('|')})`;
        case 'MMM': return `(${MONTHS.map((x) => x.slice(0, 3)).join('|')})`;
        case 'MM': case 'DD': return '(\\d{2})';
        case 'M': case 'D': return '(\\d{1,2})';
        default: return '([A-Za-z]+)';
      }
    })
    .join('');
  const match = new RegExp(`^${pattern}$`, 'i').exec(relPathNoExt);
  if (!match) return null;
  groups.forEach((tok, i) => {
    const v = match[i + 1];
    if (tok === 'YYYY') y = v;
    else if (tok === 'YY') y = `20${v}`;
    else if (tok === 'MMMM' || tok === 'MMM') m = String(MONTHS.findIndex((x) => x.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))) + 1);
    else if (tok === 'MM' || tok === 'M') m = v;
    else if (tok === 'DD' || tok === 'D') d = v;
  });
  if (!y || !m || !d) return null;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isRealDate(iso) ? iso : null;
}
