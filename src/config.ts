import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidTimeZone } from './dates.js';
import { TasksError } from './errors.js';
import type { StatusType } from './parser.js';

export interface Config {
  /** Absolute path of the local vault managed by Obsidian Headless Sync. */
  vaultPath: string;
  /** Obsidian vault name, used to build obsidian:// links (optional). */
  vaultName?: string;
  /** Folder (relative to the vault; "" = vault root) holding daily notes. Only files in it whose path matches noteFormat are reachable. */
  dailyNotesDir: string;
  /** Daily note filename format (moment.js subset), relative to dailyNotesDir, without ".md". */
  noteFormat: string;
  /** IANA timezone used for "today" and relative dates. Defaults to the system zone. */
  timezone?: string;
  /** Bullet for new tasks. Defaults to the bullet used by the note's last task, else "-". */
  bullet?: '-' | '*' | '+';
  /** Heading under which new tasks are inserted, e.g. "## Tasks". Appends to the end of the note when absent. */
  heading?: string;
  /** Vault-relative template used with `add --create-note`. */
  template?: string;
  /** Tasks-plugin global filter (e.g. "#task"); lines without it are not tasks. */
  globalFilter?: string;
  /** Custom status symbols → type, mirroring the Tasks plugin's status settings, e.g. {">": "in_progress"}. Unlisted symbols follow the plugin defaults. */
  statuses?: Record<string, StatusType>;
  /** Add ➕ created date to new tasks (Tasks plugin "Set created date" setting). */
  setCreatedDate?: boolean;
  sync: {
    enabled: boolean;
    /** Override the sync command (argv). Defaults to the bundled `ob sync --path <vaultPath>`. */
    command?: string[];
    timeoutSec?: number;
  };
  lockTimeoutSec?: number;
}

export const DEFAULTS = {
  dailyNotesDir: '', // Obsidian's Daily Notes default: the vault root
  noteFormat: 'YYYY-MM-DD',
  syncTimeoutSec: 180,
  lockTimeoutSec: 120,
};

export function configDir(): string {
  if (process.env.TASKS_CONFIG) return path.dirname(path.resolve(process.env.TASKS_CONFIG));
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'obsidian-tasks-agent-access');
}

export function configPath(): string {
  return process.env.TASKS_CONFIG ? path.resolve(process.env.TASKS_CONFIG) : path.join(configDir(), 'config.json');
}

export function readConfigFile(): Partial<Config> | null {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new TasksError('CONFIG', `Config file ${p} is not valid JSON: ${(e as Error).message}`);
  }
}

export function loadConfig(): Config {
  const raw = readConfigFile();
  if (!raw) throw new TasksError('CONFIG', `Not configured: ${configPath()} does not exist. Run "tasks setup" first.`);
  if (!raw.vaultPath) throw new TasksError('CONFIG', `Config ${configPath()} is missing "vaultPath".`);
  const cfg: Config = {
    ...raw,
    vaultPath: path.resolve(raw.vaultPath.replace(/^~(?=$|\/)/, os.homedir())),
    dailyNotesDir: raw.dailyNotesDir ?? DEFAULTS.dailyNotesDir,
    noteFormat: raw.noteFormat ?? DEFAULTS.noteFormat,
    sync: { enabled: true, ...raw.sync },
  };
  if (process.env.TASKS_TZ) cfg.timezone = process.env.TASKS_TZ;
  for (const [sym, type] of Object.entries(cfg.statuses ?? {})) {
    if ([...sym].length !== 1 || !['todo', 'in_progress', 'done', 'cancelled'].includes(type)) {
      throw new TasksError('CONFIG', `Invalid statuses entry "${sym}": "${type}" (use one symbol → todo|in_progress|done|cancelled)`);
    }
  }
  if (cfg.timezone && !isValidTimeZone(cfg.timezone)) throw new TasksError('CONFIG', `Invalid timezone "${cfg.timezone}"`);
  return cfg;
}

export function saveConfig(cfg: Partial<Config>): string {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return p;
}

export function timezoneOf(cfg: Config): string {
  return cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
