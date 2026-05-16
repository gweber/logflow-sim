import type { SourceLoc } from '../source-map.js';
import type { Expr, Stmt as AstStmt, KVParam } from '../dialects/rsyslog/parser/ast.js';
import type { Diagnostic } from '../diagnostics.js';

export interface IRBase {
  id: string;
  source: SourceLoc;
  rawText?: string;
}

export interface IRInput extends IRBase {
  kind: 'Input';
  type: string; // imudp, imtcp, imfile, ...
  port?: number;
  ruleset?: string;
  params: Record<string, IRValue>;
}

export interface IRRuleset extends IRBase {
  kind: 'Ruleset';
  name: string;
  statements: IRStatement[];
  queueSettings?: Record<string, IRValue>;
  params: Record<string, IRValue>;
}

export interface IRTemplate extends IRBase {
  kind: 'Template';
  name: string;
  type: string; // string, list, plugin, subtree
  string?: string;
  /**
   * For `type="list"`: ordered render parts. The renderer concatenates them
   * left-to-right. A `constant` part contributes its literal `value`; a
   * `property` part is resolved (with the same property-modifier grammar
   * used in `%foo%` substitution) at render time.
   */
  parts?: TemplatePart[];
  params: Record<string, IRValue>;
}

export type TemplatePart =
  | { kind: 'constant'; value: string }
  | { kind: 'property'; name: string };

/**
 * Generic named output sink. Used by dialects (syslog-ng, NXLog, Fluent Bit,
 * Vector, Logstash) that distinguish "destinations" from inline `action()`
 * statements. The simulator treats a referenced IROutput identically to an
 * IRAction with the same `actionKind` and params.
 */
export interface IROutput extends IRBase {
  kind: 'Output';
  name: string;
  /** Underlying driver/plugin name as written in the config. */
  driver: string;
  /** Best-effort classification mapped to our ActionKind enum. */
  actionKind: ActionKind;
  params: Record<string, IRValue>;
}

/**
 * Named, reusable filter expression. The body is the dialect's AST-Expr —
 * shared with rsyslog's `if` conditions, since they're structurally similar
 * (and/or/not, property comparisons, regex match).
 */
export interface IRFilterDef extends IRBase {
  kind: 'FilterDef';
  name: string;
  expression: import('../dialects/rsyslog/parser/ast.js').Expr;
}

/**
 * A pipeline route binding one-or-more inputs through filters/transforms to
 * one-or-more outputs. This is the shape syslog-ng's `log { … };`,
 * Fluent Bit's tag-based routing, Logstash's pipeline stages, and Vector's
 * source/transform/sink graph all share.
 *
 * For rsyslog dialect, routes are unused; the existing `rulesets` plus
 * input.ruleset reference carry the same information.
 */
export interface IRRoute extends IRBase {
  kind: 'Route';
  /** Optional human-readable name; auto-generated when the dialect doesn't supply one. */
  name?: string;
  /** Names of sources/inputs this route consumes. */
  inputRefs: string[];
  /** Names of filter definitions applied in order. */
  filterRefs: string[];
  /** Names of transforms applied in order (parsers, rewrites). */
  transformRefs: string[];
  /** Names of outputs/destinations the route writes to. */
  outputRefs: string[];
  /** Flag set (drop, final, fallback, …) — dialect-specific. */
  flags: string[];
}

export interface IRLookupTable extends IRBase {
  kind: 'LookupTable';
  name: string;
  file: string;
  reloadOnHUP?: boolean;
  params: Record<string, IRValue>;
}

export interface IRModule extends IRBase {
  kind: 'Module';
  load: string;
  params: Record<string, IRValue>;
}

export interface IRGlobalSettings {
  defaultRuleset?: string;
  workDirectory?: string;
  /** All raw global(...) params merged. */
  params: Record<string, IRValue>;
  /** All legacy $Directives we kept verbatim. */
  legacy: { name: string; value: string; source: SourceLoc }[];
}

// ---- Statements inside rulesets ----

export type IRStatement =
  | IRIf
  | IRAction
  | IRSet
  | IRReset
  | IRUnset
  | IRStop
  | IRContinue
  | IRCall
  | IRReloadLookupTable
  | IRLegacySelector
  | IRUnknown;

export interface IRIf extends IRBase {
  kind: 'If';
  condition: Expr;
  then: IRStatement[];
  else?: IRStatement[];
}

export type ActionKind =
  | 'omfile'
  | 'omfwd'
  | 'omelasticsearch'
  | 'omkafka'
  | 'omhttp'
  | 'mmjsonparse'
  | 'unknown';

export interface IRAction extends IRBase {
  kind: 'Action';
  actionType: string; // raw type= string
  actionKind: ActionKind;
  params: Record<string, IRValue>;
}

export interface IRSet extends IRBase {
  kind: 'Set';
  targetKind: 'local' | 'structured';
  targetName: string;
  value: Expr;
}
export interface IRReset extends IRBase {
  kind: 'Reset';
  targetKind: 'local' | 'structured';
  targetName: string;
  value: Expr;
}
export interface IRUnset extends IRBase {
  kind: 'Unset';
  targetKind: 'local' | 'structured';
  targetName: string;
}
export interface IRStop extends IRBase {
  kind: 'Stop';
}
export interface IRContinue extends IRBase {
  kind: 'Continue';
}
/**
 * BSD-style legacy selector line. Resolved at simulation time as
 * `prifilt(facspec)`-guarded equivalent action (omfile/omfwd/discard/...).
 */
export interface IRLegacySelector extends IRBase {
  kind: 'LegacySelector';
  facspec: string;
  target: string;
}
export interface IRCall extends IRBase {
  kind: 'Call';
  ruleset: string;
}
export interface IRReloadLookupTable extends IRBase {
  kind: 'ReloadLookupTable';
  table: string;
}
export interface IRUnknown extends IRBase {
  kind: 'Unknown';
  raw: string;
}

// ---- Values used inside IR params (mostly string literals at config time) ----

export type IRValue = string | number | boolean | string[] | Expr;

export interface IRModel {
  inputs: IRInput[];
  rulesets: IRRuleset[];
  templates: IRTemplate[];
  lookupTables: IRLookupTable[];
  modules: IRModule[];
  globals: IRGlobalSettings;
  diagnostics: Diagnostic[];
  /** Map ruleset name → IRRuleset for quick lookup. */
  rulesetByName: Record<string, IRRuleset>;
  /** Map template name → IRTemplate. */
  templateByName: Record<string, IRTemplate>;
  /** Map lookup-table name → IRLookupTable. */
  lookupTableByName: Record<string, IRLookupTable>;
  files: string[];

  // ---- Multi-dialect additions (empty for rsyslog) ----
  /** Named outputs/destinations for dialects that separate them from actions. */
  outputs: IROutput[];
  /** Map output name → IROutput. */
  outputByName: Record<string, IROutput>;
  /** Reusable filter definitions referenced by name. */
  filters: IRFilterDef[];
  filterByName: Record<string, IRFilterDef>;
  /** Pipeline routes binding inputs to outputs through filters/transforms. */
  routes: IRRoute[];
  /** Which dialect produced this IR. Used by the simulator dispatch and the converter. */
  dialect: string;
}

export type { KVParam, AstStmt };
