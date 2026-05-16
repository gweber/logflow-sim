import type { IRModel } from '../ir/model.js';
import type { Diagnostic } from '../diagnostics.js';

/**
 * A validation rule inspects a parsed IR and produces zero-or-more diagnostics
 * that go BEYOND parse errors — semantic checks the parser can't perform
 * (undefined references, dead code, suspicious patterns).
 *
 * Rules are pure functions. They never mutate the IR. They MAY look at
 * lookup-table contents (loaded into `IRModel.lookupTables[*]` metadata),
 * but they MUST NOT read the filesystem.
 *
 * Each rule has a stable `id` so users can disable specific checks via
 * `ValidateOptions.disable`.
 */
export interface ValidationRule {
  /** Stable identifier, e.g. "undefined-ruleset-call". */
  id: string;
  /** One-line summary shown in CLI/UI. */
  description: string;
  /** Severity to emit for findings — rules can promote individual findings up but not down. */
  defaultSeverity: 'error' | 'warning' | 'info';
  /**
   * Optional dialect filter. When set, the rule only runs against models
   * whose `model.dialect` matches one of these IDs. Cross-dialect rules
   * (silent drops, undefined refs, dead code) omit this and run on every
   * dialect — they reason on the normalized IR.
   *
   * Use this for rules that encode dialect-specific runtime behavior, e.g.
   * "rsyslog silently drops an input when its module isn't loaded" or
   * "syslog-ng won't route messages from sources never named in a log{}".
   */
  dialects?: string[];
  /** Run the rule and produce diagnostics. */
  run(model: IRModel): Diagnostic[];
}

export interface ValidateOptions {
  /** Rule IDs to skip entirely. */
  disable?: string[];
  /** Promote a rule's findings to a different severity. */
  severityOverride?: Record<string, 'error' | 'warning' | 'info'>;
}

export interface ValidationReport {
  ranRuleIds: string[];
  findings: Diagnostic[];
  summary: { errors: number; warnings: number; info: number };
}
