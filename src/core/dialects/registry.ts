import type { Dialect } from './types.js';
import { rsyslogDialect } from './rsyslog/index.js';
import { syslogNgDialect } from './syslog-ng/index.js';
import { fluentBitDialect } from './fluent-bit/index.js';
import { nxlogDialect } from './nxlog/index.js';
import { logstashDialect } from './logstash/index.js';
import { vectorDialect } from './vector/index.js';
import { otelDialect } from './otel/index.js';
import { filebeatDialect } from './filebeat/index.js';
import { promtailDialect } from './promtail/index.js';
import { fluentdDialect } from './fluentd/index.js';

/**
 * The dialect registry.
 *
 * Each implemented dialect registers itself here. Consumers pick a dialect
 * either explicitly (by ID) or via `detectDialect()` which probes a sample
 * file against every registered plugin's `detect()` method and returns the
 * highest-confidence match.
 *
 * Plugins are pure data — they hold no per-invocation state — so a single
 * registry instance is shared across server, CLI, and worker contexts.
 */
const DIALECTS: Record<string, Dialect> = {
  [rsyslogDialect.id]: rsyslogDialect,
  [syslogNgDialect.id]: syslogNgDialect,
  [fluentBitDialect.id]: fluentBitDialect,
  [nxlogDialect.id]: nxlogDialect,
  [logstashDialect.id]: logstashDialect,
  [vectorDialect.id]: vectorDialect,
  [otelDialect.id]: otelDialect,
  [filebeatDialect.id]: filebeatDialect,
  [promtailDialect.id]: promtailDialect,
  [fluentdDialect.id]: fluentdDialect
};

export function registerDialect(dialect: Dialect): void {
  DIALECTS[dialect.id] = dialect;
}

export function getDialect(id: string): Dialect | undefined {
  return DIALECTS[id];
}

export function listDialects(): Dialect[] {
  return Object.values(DIALECTS).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Pick the most likely dialect for a given config sample by polling every
 * registered plugin. Returns null when no dialect's `detect()` returns
 * a non-zero score.
 *
 * If multiple files are available, score them in aggregate — the more
 * evidence the better.
 */
export function detectDialect(
  samples: { path: string; content: string }[]
): { dialect: Dialect; confidence: number } | null {
  let best: { dialect: Dialect; confidence: number } | null = null;
  for (const d of listDialects()) {
    let total = 0;
    for (const s of samples) total += d.detect(s);
    const score = samples.length > 0 ? total / samples.length : 0;
    if (score > 0 && (!best || score > best.confidence)) {
      best = { dialect: d, confidence: score };
    }
  }
  return best;
}
