// setup + doctor: everything that touches Obsidian Headless configuration directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, configPath, loadConfig, readConfigFile, saveConfig, timezoneOf, type Config } from './config.js';
import { formatDate, isValidTimeZone, todayIn } from './dates.js';
import { TasksError } from './errors.js';
import { findTasks, splitNote, type StatusType } from './parser.js';
import { lockPath, readPending, runOb, runSync, withLock } from './sync.js';
import { DailyRoot } from './vault.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'error' | 'info';
  message: string;
}

function obConfigDir(): string {
  return os.platform() === 'linux'
    ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'obsidian-headless')
    : path.join(os.homedir(), '.obsidian-headless');
}

function hasObAuth(): boolean {
  return Boolean(process.env.OBSIDIAN_AUTH_TOKEN) || fs.existsSync(path.join(obConfigDir(), 'auth_token'));
}

function obStatus(vaultPath: string): Record<string, unknown> | null {
  const r = runOb(['sync-status', '--path', vaultPath, '--json']);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}

export function doctor(opts: { offline?: boolean } = {}) {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], message: string) => checks.push({ name, status, message });
  const done = () => ({ healthy: !checks.some((c) => c.status === 'error'), checks });

  let cfg: Config;
  try {
    cfg = loadConfig();
    add('config', 'ok', configPath());
  } catch (e) {
    add('config', 'error', (e as Error).message);
    return done();
  }
  const tz = timezoneOf(cfg);
  add('timezone', isValidTimeZone(tz) ? 'ok' : 'error', `${tz} (today is ${todayIn(tz)})`);

  if (!fs.existsSync(cfg.vaultPath)) {
    add('vault', 'error', `Vault folder missing: ${cfg.vaultPath}. Run "tasks setup".`);
    return done();
  }
  add('vault', 'ok', cfg.vaultPath);

  if (cfg.sync.enabled && !cfg.sync.command) {
    const ver = runOb(['--version']);
    add('obsidian-headless', ver.ok ? 'ok' : 'error', ver.ok ? `ob ${ver.stdout.trim()}` : 'ob CLI not found; reinstall obsidian-tasks-agent-access or npm i -g obsidian-headless');
    add('auth', hasObAuth() ? 'ok' : 'error', hasObAuth() ? 'Obsidian account token present' : 'Not logged in: run "ob login" in an interactive terminal or set OBSIDIAN_AUTH_TOKEN');
    const st = obStatus(cfg.vaultPath);
    if (!st) add('sync-config', 'error', `No Obsidian Sync configuration for ${cfg.vaultPath}. Run "tasks setup --remote-vault <name>".`);
    else {
      const mode = String(st.syncMode ?? 'bidirectional');
      add('sync-config', mode === 'bidirectional' ? 'ok' : 'error', `mode=${mode}, conflictStrategy=${st.conflictStrategy ?? '?'}, vault=${st.vaultName ?? '?'}`);
      add('file-types', 'info', `Attachment types synced: ${((st.fileTypes ?? []) as string[]).join(', ') || 'none'} (markdown always syncs)`);
      const excluded = ((st.excludedFolders ?? []) as string[]).map((f) => f.replace(/\/+$/, ''));
      const top = cfg.dailyNotesDir.split('/')[0];
      const extra = fs.readdirSync(cfg.vaultPath, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.') && d.name !== top);
      const dirs = extra.filter((d) => d.isDirectory() && !excluded.includes(d.name)).map((d) => d.name);
      const files = extra.filter((d) => d.isFile()).map((d) => d.name);
      if (dirs.length) add('selective-sync', 'warn', `Folders still synced but unused: ${dirs.join(', ')}. Exclude with: tasks setup --exclude-folders "${dirs.join(',')}"`);
      else add('selective-sync', 'ok', `Excluded: ${excluded.join(', ') || '(none)'}`);
      if (files.length) add('root-files', 'info', `${files.length} root-level file(s) always sync (exclusions only cover folders): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''}`);
    }
  } else {
    add('sync-config', cfg.sync.enabled ? 'info' : 'warn', cfg.sync.enabled ? `custom sync command: ${cfg.sync.command!.join(' ')}` : 'Sync disabled in config; changes stay local');
  }

  if (fs.existsSync(lockPath(cfg))) add('lock', 'warn', `Lock held: ${lockPath(cfg)} (another command running, or stale)`);

  if (!opts.offline && cfg.sync.enabled) {
    try {
      const r = withLock(cfg, () => runSync(cfg));
      add('sync', r.ok ? 'ok' : 'error', r.ok ? `Synced in ${r.durationMs} ms` : `Sync failed (exit ${r.exitCode}): ${r.output}`);
    } catch (e) {
      add('sync', 'error', (e as Error).message);
    }
  }
  const pending = readPending(cfg);
  if (pending?.length) add('pending', 'warn', `${pending.length} local edit(s) not yet confirmed pushed to Obsidian Sync`);

  let root: DailyRoot;
  try {
    root = new DailyRoot(cfg.vaultPath, cfg.dailyNotesDir, cfg.noteFormat);
  } catch (e) {
    add('daily-folder', 'error', (e as Error).message);
    return done();
  }
  const { notes, skipped } = root.listNotes();
  let taskCount = 0;
  for (const n of notes) taskCount += findTasks(splitNote(fs.readFileSync(n.abs, 'utf8')), cfg.globalFilter).length;
  add('daily-folder', 'ok', `${cfg.dailyNotesDir}: ${notes.length} notes, ${taskCount} tasks`);
  const conflicts = skipped.filter((s) => s.reason === 'conflicted copy');
  if (conflicts.length) add('conflicts', 'warn', `Conflicted copies need resolving in Obsidian: ${conflicts.map((c) => c.path).join(', ')}`);
  const symlinks = skipped.filter((s) => s.reason === 'symlink');
  if (symlinks.length) add('symlinks', 'warn', `Ignored symlinks: ${symlinks.map((c) => c.path).join(', ')}`);
  const todayNote = formatDate(todayIn(tz), cfg.noteFormat) + '.md';
  add('today-note', 'info', fs.existsSync(path.join(root.rootReal, todayNote)) ? `${todayNote} exists` : `${todayNote} does not exist yet (add will need --create-note)`);
  return done();
}

export interface SetupOpts {
  vaultPath?: string;
  remoteVault?: string;
  dailyDir?: string;
  noteFormat?: string;
  timezone?: string;
  bullet?: string;
  heading?: string;
  template?: string;
  globalFilter?: string;
  excludeFolders?: string;
  fileTypes?: string;
  deviceName?: string;
  vaultName?: string;
  /** custom status symbols, e.g. ">=in_progress,?=todo" */
  statuses?: string;
  skipSync?: boolean;
}

const STATUS_TYPES = ['todo', 'in_progress', 'done', 'cancelled'];

function parseStatuses(spec: string): Record<string, StatusType> {
  const out: Record<string, StatusType> = {};
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.lastIndexOf('=');
    const sym = part.slice(0, i);
    const type = part.slice(i + 1);
    if (i < 1 || [...sym].length !== 1 || !STATUS_TYPES.includes(type)) {
      throw new TasksError('USAGE', `Invalid status mapping "${part}". Use symbol=type, e.g. ">=in_progress" (types: ${STATUS_TYPES.join(', ')})`);
    }
    out[sym] = type as StatusType;
  }
  return out;
}

const expandHome = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

export function setup(o: SetupOpts) {
  const prev = readConfigFile() ?? {};
  const vaultPath = expandHome(o.vaultPath ?? prev.vaultPath ?? path.join(os.homedir(), 'obsidian-vault'));
  if (o.timezone && !isValidTimeZone(o.timezone)) throw new TasksError('USAGE', `Invalid timezone "${o.timezone}"`);
  if (o.bullet && !['-', '*', '+'].includes(o.bullet)) throw new TasksError('USAGE', '--bullet must be -, * or +');
  const cfg: Partial<Config> = {
    ...prev,
    vaultPath,
    dailyNotesDir: o.dailyDir ?? prev.dailyNotesDir ?? DEFAULTS.dailyNotesDir,
    noteFormat: o.noteFormat ?? prev.noteFormat ?? DEFAULTS.noteFormat,
    sync: prev.sync ?? { enabled: true },
  };
  for (const [k, v] of Object.entries({ timezone: o.timezone, bullet: o.bullet, heading: o.heading, template: o.template, globalFilter: o.globalFilter, vaultName: o.vaultName ?? o.remoteVault })) {
    if (v !== undefined) (cfg as Record<string, unknown>)[k] = v;
  }
  if (o.statuses !== undefined) cfg.statuses = parseStatuses(o.statuses);
  const steps: string[] = [];
  fs.mkdirSync(vaultPath, { recursive: true });
  steps.push(`Saved config to ${saveConfig(cfg)}`);

  if (cfg.sync!.enabled && !cfg.sync!.command) {
    if (!hasObAuth()) {
      throw new TasksError('CONFIG', 'Not logged in to Obsidian. The user must run "ob login" once in an interactive terminal (or set OBSIDIAN_AUTH_TOKEN), then re-run setup.', { steps });
    }
    const linked = obStatus(vaultPath);
    if (linked && o.remoteVault && linked.vaultName !== o.remoteVault && linked.vaultId !== o.remoteVault) {
      throw new TasksError('CONFIG', `${vaultPath} is already linked to vault "${linked.vaultName}", not "${o.remoteVault}". Use another --vault-path or run "ob sync-unlink --path ${vaultPath}".`, { steps });
    }
    if (linked) {
      steps.push(`${vaultPath} is already linked to "${linked.vaultName}"`);
    } else if (o.remoteVault) {
      const args = ['sync-setup', '--vault', o.remoteVault, '--path', vaultPath, '--device-name', o.deviceName ?? `tasks-agent-${os.hostname()}`, '--json'];
      if (process.env.OBSIDIAN_E2E_PASSWORD) args.push('--password', process.env.OBSIDIAN_E2E_PASSWORD);
      const r = runOb(args, 120);
      if (!r.ok) throw new TasksError('CONFIG', `ob sync-setup failed: ${(r.stderr || r.stdout).trim()}`, { steps });
      steps.push(`Linked ${vaultPath} to remote vault "${o.remoteVault}"`);
    } else {
      throw new TasksError('USAGE', 'This vault folder is not linked to Obsidian Sync yet; pass --remote-vault "<vault name>" (see "ob sync-list-remote").', { steps });
    }
    // No app-config syncing; optionally skip unrelated folders and attachment types.
    // (An empty --file-types would RESET to all types, so it is only passed when given.)
    const cfgArgs = ['sync-config', '--path', vaultPath, '--mode', 'bidirectional', '--configs', ''];
    if (o.excludeFolders !== undefined) cfgArgs.push('--excluded-folders', o.excludeFolders);
    if (o.fileTypes) cfgArgs.push('--file-types', o.fileTypes);
    const r = runOb(cfgArgs);
    if (!r.ok) throw new TasksError('CONFIG', `ob sync-config failed: ${(r.stderr || r.stdout).trim()}`, { steps });
    steps.push(`Configured selective sync (no app config${o.excludeFolders ? `, excluding ${o.excludeFolders}` : ''}${o.fileTypes ? `, file types: ${o.fileTypes}` : ''})`);
    if (!o.skipSync) {
      const s = withLock(loadConfig(), () => runSync(loadConfig()));
      if (!s.ok) throw new TasksError('SYNC_FAILED', 'Initial sync failed', { output: s.output, steps });
      steps.push(`Initial sync completed in ${s.durationMs} ms`);
    }
  }
  return { steps, doctor: doctor({ offline: true }) };
}

/** Environment variables read by `tasks bootstrap` (all optional except TASKS_REMOTE_VAULT on first run). */
export const BOOTSTRAP_ENV: Record<string, string> = {
  OBSIDIAN_AUTH_TOKEN: 'Obsidian account token (required unless ob login was run on this machine)',
  OBSIDIAN_E2E_PASSWORD: 'vault encryption password, for end-to-end encrypted vaults',
  TASKS_REMOTE_VAULT: 'remote vault name or id (required on first run)',
  TASKS_VAULT_PATH: 'local vault folder (default ~/obsidian-vault)',
  TASKS_DAILY_DIR: 'daily notes folder in the vault ("" = vault root, the default)',
  TASKS_NOTE_FORMAT: 'daily note name format (default YYYY-MM-DD)',
  TASKS_TZ: 'IANA timezone, e.g. America/Los_Angeles',
  TASKS_BULLET: 'bullet for new tasks: -, * or +',
  TASKS_HEADING: 'heading new tasks go under (default: end of note)',
  TASKS_TEMPLATE: 'vault-relative daily note template',
  TASKS_GLOBAL_FILTER: 'Tasks plugin global filter',
  TASKS_STATUSES: 'custom status symbols, e.g. ">=in_progress"',
  TASKS_EXCLUDE_FOLDERS: 'comma-separated top-level folders not to sync',
  TASKS_FILE_TYPES: 'attachment types to sync (e.g. "unsupported" to skip media)',
  TASKS_DEVICE_NAME: 'device name shown in Obsidian Sync history',
  TASKS_SKILLS_DIR: 'install SKILL.md into this skills directory',
};

/**
 * Idempotent, non-interactive setup for agents: configures from environment variables on the
 * first run, does nothing (beyond a health check) when this machine is already configured.
 */
export function bootstrap(o: { skillsDir?: string; offline?: boolean } = {}) {
  const env = process.env;
  const prev = readConfigFile();
  const vaultPath = expandHome(env.TASKS_VAULT_PATH ?? prev?.vaultPath ?? path.join(os.homedir(), 'obsidian-vault'));
  const customSync = prev?.sync?.enabled === false || Boolean(prev?.sync?.command);
  const alreadyConfigured = Boolean(prev?.vaultPath) && expandHome(prev!.vaultPath!) === vaultPath && fs.existsSync(vaultPath) && (customSync || obStatus(vaultPath) !== null);
  const steps: string[] = [];
  if (alreadyConfigured) steps.push(`Already configured (${configPath()}); nothing to set up`);
  else {
    if (!env.TASKS_REMOTE_VAULT && !(prev?.vaultPath && obStatus(vaultPath))) {
      throw new TasksError('CONFIG', 'Not configured yet. Set TASKS_REMOTE_VAULT (and OBSIDIAN_AUTH_TOKEN) and run "tasks bootstrap" again.', {
        environment: BOOTSTRAP_ENV,
      });
    }
    const r = setup({
      vaultPath, remoteVault: env.TASKS_REMOTE_VAULT, dailyDir: env.TASKS_DAILY_DIR, noteFormat: env.TASKS_NOTE_FORMAT,
      timezone: env.TASKS_TZ, bullet: env.TASKS_BULLET, heading: env.TASKS_HEADING, template: env.TASKS_TEMPLATE,
      globalFilter: env.TASKS_GLOBAL_FILTER, statuses: env.TASKS_STATUSES, excludeFolders: env.TASKS_EXCLUDE_FOLDERS,
      fileTypes: env.TASKS_FILE_TYPES, deviceName: env.TASKS_DEVICE_NAME,
    });
    steps.push(...r.steps);
  }
  const skillsDir = o.skillsDir ?? env.TASKS_SKILLS_DIR;
  if (skillsDir) steps.push(`Installed agent skill to ${installSkill(skillsDir)}`);
  return { alreadyConfigured, steps, doctor: doctor({ offline: o.offline }) };
}

export function installSkill(skillsDir: string): string {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'SKILL.md');
  const dest = path.join(expandHome(skillsDir), 'obsidian-tasks', 'SKILL.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}
