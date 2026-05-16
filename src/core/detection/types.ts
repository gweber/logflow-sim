/**
 * Sigma-rule subset that logflow-sim understands. The full SigmaHQ grammar
 * is sprawling — we implement the slice that's actually used by Linux /
 * syslog-shape rules in the wild (~80% of community rules).
 *
 * Supported:
 *   • `detection.<selection-name>` maps with field/value pairs
 *   • Field modifiers: `|contains`, `|startswith`, `|endswith`, `|re`,
 *     `|all` (every list element must match), `|i` (case-insensitive)
 *   • Values: scalars and lists (list semantics = OR)
 *   • `condition`: any boolean of selection names with `and`, `or`, `not`,
 *     parentheses, and the `1 of <prefix>*` shorthand
 *
 * Out of scope (silently treated as never-matching):
 *   • Windows-only fields (Computer, EventID) — we keep the rule loaded
 *     so it counts as a "no impact" entry in the report rather than an
 *     error, which is exactly how a SOC operator would interpret it.
 *   • Aggregation conditions (`count() > N`) — useful but stateful;
 *     out of scope for batch routing-impact analysis.
 *   • Timeframe windows.
 */

export type SigmaModifier = 'contains' | 'startswith' | 'endswith' | 're' | 'all' | 'i';

export interface SigmaField {
  /** Source field name (the part before `|` in the YAML key). */
  name: string;
  /** Modifiers parsed from the key (`programname|contains|i` → ['contains','i']). */
  modifiers: SigmaModifier[];
  /** One or more candidate values; list semantics = OR unless `|all` is set. */
  values: string[];
}

export interface SigmaSelection {
  /** Selection name as it appears in `detection`. */
  name: string;
  /** Fields collected under this selection. Field semantics = AND. */
  fields: SigmaField[];
}

export interface SigmaRule {
  id?: string;
  title: string;
  description?: string;
  /** logsource fields, kept verbatim so the matcher can short-circuit. */
  logsource: {
    product?: string;
    service?: string;
    category?: string;
  };
  selections: SigmaSelection[];
  /** Raw condition string, e.g. "selection and not filter". */
  condition: string;
  level?: string;
  tags?: string[];
  /** Source file path for error messages. */
  source?: { file: string };
}
