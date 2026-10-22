// Filesystem access confined to daily notes: files in the configured folder (which may be the
// vault root) whose path matches the daily-note format. Every path is checked against the real
// (symlink-resolved) root, and symlinks are never followed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatDate, parseNoteDate } from './dates.js';
import { TasksError } from './errors.js';

export const CONFLICT_MARKER = ' (Conflicted copy';

export interface NoteRef {
  /** path relative to the daily root, forward slashes */
  rel: string;
  /** path relative to the vault, forward slashes */
  vaultRel: string;
  abs: string;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export class DailyRoot {
  readonly vaultReal: string;
  readonly rootReal: string;

  constructor(readonly vaultPath: string, readonly dailyDir: string, readonly noteFormat: string) {
    if (!fs.existsSync(vaultPath)) throw new TasksError('CONFIG', `Vault path does not exist: ${vaultPath}`);
    this.vaultReal = fs.realpathSync(vaultPath);
    const rootPath = path.resolve(this.vaultReal, dailyDir);
    if (!isInside(this.vaultReal, rootPath)) throw new TasksError('CONFIG', `dailyNotesDir "${dailyDir}" must be inside the vault`);
    if (!fs.existsSync(rootPath)) {
      throw new TasksError('CONFIG', `Daily notes folder not found: ${rootPath}. Has the vault synced yet? Run "tasks doctor".`);
    }
    if (rootPath !== this.vaultReal && fs.lstatSync(rootPath).isSymbolicLink()) {
      throw new TasksError('PATH_REJECTED', `Daily notes folder is a symlink: ${rootPath}`);
    }
    this.rootReal = fs.realpathSync(rootPath);
    if (!isInside(this.vaultReal, this.rootReal)) throw new TasksError('PATH_REJECTED', 'Daily notes folder resolves outside the vault');
  }

  /** Only files whose path matches the daily-note format are in scope (the folder may be the vault root). */
  isDailyNote(rel: string): boolean {
    return /\.md$/i.test(rel) && parseNoteDate(rel.replace(/\.md$/i, ''), this.noteFormat) !== null;
  }

  ref(rel: string): NoteRef {
    return { rel, vaultRel: toPosix(path.relative(this.vaultReal, path.join(this.rootReal, rel))), abs: path.join(this.rootReal, rel) };
  }

  /**
   * Validates a caller-supplied note path (relative to the daily root, or vault-relative
   * starting with the daily folder name). Rejects traversal, absolute paths and symlinks.
   */
  resolveNote(input: string): NoteRef {
    let rel = input.replace(/\\/g, '/').trim();
    const dir = toPosix(this.dailyDir).replace(/^\/+|\/+$/g, '');
    if (dir && rel.startsWith(dir + '/')) rel = rel.slice(dir.length + 1);
    if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
    if (path.isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s === '.' || s === '' || s.startsWith('.'))) {
      throw new TasksError('PATH_REJECTED', `Path "${input}" is not a plain path inside the daily notes folder`);
    }
    if (rel.includes(CONFLICT_MARKER)) throw new TasksError('PATH_REJECTED', 'Conflicted copies cannot be edited through this tool');
    if (!this.isDailyNote(rel)) {
      throw new TasksError('PATH_REJECTED', `"${input}" is not a daily note (expected names like ${formatDate('2026-01-31', this.noteFormat)}.md)`);
    }
    const abs = path.join(this.rootReal, rel);
    if (!isInside(this.rootReal, abs)) throw new TasksError('PATH_REJECTED', `Path "${input}" escapes the daily notes folder`);
    // Walk every existing component and refuse symlinks.
    let cur = this.rootReal;
    for (const seg of rel.split('/')) {
      cur = path.join(cur, seg);
      if (!fs.existsSync(cur)) break;
      if (fs.lstatSync(cur).isSymbolicLink()) throw new TasksError('PATH_REJECTED', `Refusing to follow symlink: ${toPosix(path.relative(this.rootReal, cur))}`);
    }
    return this.ref(rel);
  }

  listNotes(): { notes: NoteRef[]; skipped: { path: string; reason: string }[] } {
    const notes: NoteRef[] = [];
    const skipped: { path: string; reason: string }[] = [];
    // Recurse only as deep as the note format has folders (e.g. "YYYY/MM/YYYY-MM-DD" → 2 levels).
    const maxDepth = this.noteFormat.replace(/\[[^\]]*\]/g, '').split('/').length - 1;
    const walk = (dir: string, depth: number) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ent.name.startsWith('.')) continue;
        const abs = path.join(dir, ent.name);
        const rel = toPosix(path.relative(this.rootReal, abs));
        if (ent.isDirectory()) {
          if (depth < maxDepth) walk(abs, depth + 1);
        } else if (ent.isSymbolicLink()) {
          if (this.isDailyNote(rel)) skipped.push({ path: rel, reason: 'symlink' });
        } else if (ent.isFile()) {
          const marker = rel.indexOf(CONFLICT_MARKER);
          if (marker > 0 && this.isDailyNote(rel.slice(0, marker) + '.md')) skipped.push({ path: rel, reason: 'conflicted copy' });
          else if (this.isDailyNote(rel)) notes.push(this.ref(rel));
        }
      }
    };
    walk(this.rootReal, 0);
    return { notes, skipped };
  }

  conflictedCopies(): string[] {
    return this.listNotes().skipped.filter((s) => s.reason === 'conflicted copy').map((s) => s.path);
  }

  /** Reads a vault-relative file outside the root (template only). Read-only, still symlink-checked. */
  readVaultFile(vaultRel: string): string {
    const abs = path.resolve(this.vaultReal, vaultRel);
    if (!isInside(this.vaultReal, abs) || !fs.existsSync(abs)) throw new TasksError('CONFIG', `Template not found in vault: ${vaultRel}`);
    if (!isInside(this.vaultReal, fs.realpathSync(abs))) throw new TasksError('PATH_REJECTED', 'Template resolves outside the vault');
    return fs.readFileSync(abs, 'utf8');
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function sha(text: string, len = 10): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, len);
}

/** Writes via a dot-prefixed temp file (ignored by Obsidian Sync) and an atomic rename. */
export function writeAtomic(abs: string, content: string, opts: { mustNotExist?: boolean } = {}): void {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.tasks-${process.pid}-${Date.now()}.tmp`);
  const mode = fs.existsSync(abs) ? fs.statSync(abs).mode & 0o777 : 0o644;
  fs.writeFileSync(tmp, content, { mode });
  try {
    if (opts.mustNotExist) {
      fs.linkSync(tmp, abs); // fails with EEXIST instead of clobbering a note that appeared meanwhile
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, abs);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new TasksError('CONFLICT', `Note appeared while creating it: ${abs}`);
    throw e;
  }
}
