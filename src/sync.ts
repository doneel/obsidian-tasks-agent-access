import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, configDir, type Config } from './config.js';
import { TasksError } from './errors.js';
import { sha } from './vault.js';

export interface SyncResult {
  ok: boolean;
  skipped?: boolean;
  durationMs?: number;
  exitCode?: number | null;
  output?: string;
}

/** argv prefix for the bundled `ob` CLI, falling back to `ob` on PATH. */
export function obCommand(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('obsidian-headless/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ob;
    if (bin) return [process.execPath, path.join(path.dirname(pkgPath), bin)];
  } catch {
    // not installed alongside us
  }
  return ['ob'];
}

export function runOb(args: string[], timeoutSec = 60) {
  const [cmd, ...pre] = obCommand();
  const r = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', timeout: timeoutSec * 1000 });
  return { ok: r.status === 0 && !r.error, status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

const tail = (s: string, n = 15) => s.trim().split('\n').slice(-n).join('\n');

export function runSync(cfg: Config): SyncResult {
  if (!cfg.sync.enabled) return { ok: true, skipped: true };
  const argv = cfg.sync.command ?? [...obCommand(), 'sync', '--path', cfg.vaultPath];
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: (cfg.sync.timeoutSec ?? DEFAULTS.syncTimeoutSec) * 1000,
    env: { ...process.env, TASKS_VAULT_PATH: cfg.vaultPath },
  });
  const output = tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
  const ok = r.status === 0 && !r.error;
  const result = { ok, durationMs: Date.now() - started, exitCode: r.status, output };
  if (ok) clearPending(cfg);
  return result;
}

// --- pending marker: local edits written but not yet confirmed pushed -------------------

const pendingPath = (cfg: Config) => path.join(configDir(), `pending-${sha(cfg.vaultPath, 12)}.json`);

export function markPending(cfg: Config, entry: Record<string, unknown>): void {
  const p = pendingPath(cfg);
  const cur = readPending(cfg) ?? [];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify([...cur, { at: new Date().toISOString(), ...entry }], null, 2));
}

export function readPending(cfg: Config): Record<string, unknown>[] | null {
  try {
    return JSON.parse(fs.readFileSync(pendingPath(cfg), 'utf8'));
  } catch {
    return null;
  }
}

function clearPending(cfg: Config): void {
  fs.rmSync(pendingPath(cfg), { force: true });
}

// --- cross-process lock -----------------------------------------------------------------

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const STALE_MS = 15 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockPath(cfg: Config): string {
  return path.join(configDir(), 'locks', `${sha(cfg.vaultPath, 12)}.lock`);
}

export function withLock<T>(cfg: Config, fn: () => T): T {
  const dir = lockPath(cfg);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + (cfg.lockTimeoutSec ?? DEFAULTS.lockTimeoutSec) * 1000;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let owner: { pid?: number; host?: string; at?: number } = {};
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      } catch {
        owner = { at: fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs };
      }
      const stale = (owner.host === os.hostname() && owner.pid && !pidAlive(owner.pid)) || (owner.at && Date.now() - owner.at > STALE_MS);
      if (stale) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new TasksError('LOCK_TIMEOUT', 'Another tasks command is still running against this vault; retry shortly', { owner });
      sleep(200);
    }
  }
  const release = () => fs.rmSync(dir, { recursive: true, force: true });
  process.once('exit', release);
  try {
    return fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}
