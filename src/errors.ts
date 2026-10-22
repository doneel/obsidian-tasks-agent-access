export type ErrorCode =
  | 'USAGE'
  | 'CONFIG'
  | 'NOT_FOUND'
  | 'NOTE_NOT_FOUND'
  | 'AMBIGUOUS'
  | 'STALE'
  | 'CONFLICT'
  | 'SYNC_FAILED'
  | 'UNSUPPORTED'
  | 'PATH_REJECTED'
  | 'LOCK_TIMEOUT'
  | 'INTERNAL';

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  CONFIG: 8,
  NOT_FOUND: 3,
  NOTE_NOT_FOUND: 3,
  AMBIGUOUS: 4,
  STALE: 5,
  CONFLICT: 5,
  SYNC_FAILED: 6,
  UNSUPPORTED: 7,
  PATH_REJECTED: 2,
  LOCK_TIMEOUT: 9,
  INTERNAL: 1,
};

export class TasksError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(Object.keys(this.details).length ? { details: this.details } : {}) };
  }
}
