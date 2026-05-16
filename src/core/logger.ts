/**
 * Tiny structured logger used by the kernel + server.
 *
 * No external dependency. Output is one JSON line per call when
 * `LOG_FORMAT=json` is set (suitable for Docker/k8s log shipping), else
 * a single human line with ISO timestamp + level + message + key-value
 * context.
 *
 * The logger has no IO of its own — it just calls `console.log` /
 * `console.error`. That means it works unchanged in Node, in the browser,
 * and in the Web Worker. Hosts that want a different sink can replace
 * `Logger.sink`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogFields {
  [k: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Return a logger that adds the given fields to every record. */
  child(fields: LogFields): Logger;
}

type Sink = (level: LogLevel, msg: string, fields: LogFields) => void;

function envVar(name: string): string | undefined {
  // process.env doesn't exist in browser; guard.
  if (typeof process !== 'undefined' && process.env) return process.env[name];
  return undefined;
}

const levelThreshold: LogLevel =
  (envVar('LOG_LEVEL') as LogLevel | undefined) ?? 'info';

const useJson = envVar('LOG_FORMAT') === 'json';

const defaultSink: Sink = (level, msg, fields) => {
  if (ORDER[level] < ORDER[levelThreshold]) return;
  if (useJson) {
    const record = { ts: new Date().toISOString(), level, msg, ...fields };
    const out = JSON.stringify(record);
    if (level === 'error' || level === 'warn') console.error(out);
    else console.log(out);
    return;
  }
  const stamp = new Date().toISOString();
  const ctx = Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${formatVal(v)}`).join(' ')
    : '';
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${msg}${ctx}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') {
    return /[\s"]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class StdLogger implements Logger {
  constructor(private fields: LogFields = {}, private sink: Sink = defaultSink) {}
  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    this.sink(level, message, { ...this.fields, ...(fields ?? {}) });
  }
  debug(m: string, f?: LogFields): void { this.emit('debug', m, f); }
  info(m: string, f?: LogFields): void { this.emit('info', m, f); }
  warn(m: string, f?: LogFields): void { this.emit('warn', m, f); }
  error(m: string, f?: LogFields): void { this.emit('error', m, f); }
  child(fields: LogFields): Logger {
    return new StdLogger({ ...this.fields, ...fields }, this.sink);
  }
}

/** The default, shared logger. Bind context with `.child()` rather than mutating. */
export const log: Logger = new StdLogger({ component: 'logflow-sim' });
