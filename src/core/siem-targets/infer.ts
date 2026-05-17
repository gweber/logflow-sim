/**
 * Taxonomy + SIEM-target inference.
 *
 * Two post-parse passes that annotate the IR with hints used by the
 * retag flow:
 *
 *   1. `inferLookupTaxonomies()` — when a `set $!FOO = lookup("table", ...)`
 *      assignment is found, tag the referenced lookup table with taxonomy
 *      `FOO` (e.g. `set $!sourcetype = lookup("st", ...)` tags `st` as
 *      `taxonomy: 'sourcetype'`). Drives value rewriting during retag.
 *
 *   2. `inferOutputSIEMs()` — when an IROutput's driver matches a SIEM
 *      target's `outputDrivers`, tag the output with that SIEM's ID. Lets
 *      the kernel pick the right value-map per output without re-running
 *      detection on every retag call.
 *
 * Both passes are idempotent (skip when the field is already set) so user
 * overrides — eventually via `# logflow: ...` comments — survive
 * re-inference.
 */

import type { IRModel, IRStatement } from '../ir/model.js';
import type { Expr } from '../dialects/rsyslog/parser/ast.js';
import { listSIEMTargets } from './registry.js';

/**
 * Well-known structured-field names that map to taxonomy IDs. When a
 * `set $!<name>` assignment appears in a ruleset, the right-hand-side
 * lookup-table reference is tagged with the corresponding taxonomy.
 *
 * Names are matched case-insensitively. Add more as new SIEM-target
 * plugins introduce their own taxonomies.
 */
const FIELD_TO_TAXONOMY: Record<string, string> = {
  sourcetype: 'sourcetype',
  event_category: 'ecs.event.category',
  'event.category': 'ecs.event.category',
  event_type: 'ecs.event.type',
  'event.type': 'ecs.event.type',
  ddsource: 'ddsource',
  category: 'generic',
  log_class: 'generic'
};

/**
 * Walk all rulesets, find `Set` statements whose target is a known
 * taxonomy field and whose value expression is a `lookup(...)` call, and
 * tag the referenced lookup tables with the inferred taxonomy.
 *
 * Mutates the model in place. Existing `taxonomy` annotations are
 * preserved (auto-inference is a default, never an override).
 */
export function inferLookupTaxonomies(model: IRModel): void {
  for (const ruleset of model.rulesets) {
    walk(ruleset.statements, (stmt) => {
      if (stmt.kind !== 'Set' && stmt.kind !== 'Reset') return;
      if (stmt.targetKind !== 'structured') return;
      const taxonomy = FIELD_TO_TAXONOMY[stmt.targetName.toLowerCase()];
      if (!taxonomy) return;
      const tableName = extractLookupTableName(stmt.value);
      if (!tableName) return;
      const lt = model.lookupTableByName[tableName];
      if (!lt || lt.taxonomy) return;
      lt.taxonomy = taxonomy;
    });
  }
}

/**
 * Tag every IROutput whose driver matches a registered SIEM-target's
 * `outputDrivers` list. Idempotent.
 */
export function inferOutputSIEMs(model: IRModel): void {
  const driverIndex = new Map<string, string>();
  for (const target of listSIEMTargets()) {
    for (const driver of target.outputDrivers) {
      driverIndex.set(driver.toLowerCase(), target.id);
    }
  }
  for (const out of model.outputs) {
    if (out.siemTarget) continue;
    const hit = driverIndex.get(out.driver.toLowerCase());
    if (hit) out.siemTarget = hit;
  }
}

/**
 * Convenience: run both passes. The kernel calls this once after
 * `parseFiles()` produces the model.
 */
export function inferAll(model: IRModel): void {
  inferLookupTaxonomies(model);
  inferOutputSIEMs(model);
}

// ---------------------------------------------------------------------------
// Helpers

function walk(statements: IRStatement[], visit: (s: IRStatement) => void): void {
  for (const s of statements) {
    visit(s);
    if (s.kind === 'If') {
      walk(s.then, visit);
      if (s.else) walk(s.else, visit);
    }
  }
}

/**
 * Extract the table name from a `lookup("table", key)` expression.
 *
 * The rsyslog AST encodes `lookup()` as a dedicated `LookupCall` node with
 * `table` and `key` Expr children. Other dialects encode lookups as
 * `CallExpr` with callee="lookup". We handle both shapes and require the
 * table-name argument to be a string literal — runtime-resolved table
 * names (rare) are not inferable.
 */
function extractLookupTableName(expr: Expr): string | null {
  // Treat as a discriminated union narrowed via the `kind` tag.
  const e = expr as unknown as {
    kind?: string;
    table?: { kind?: string; value?: unknown };
    callee?: string;
    args?: Array<{ kind?: string; value?: unknown }>;
  };
  if (e.kind === 'LookupCall') {
    if (e.table?.kind !== 'StringLit') return null;
    return typeof e.table.value === 'string' ? e.table.value : null;
  }
  if (e.kind === 'CallExpr' && e.callee === 'lookup') {
    const first = e.args?.[0];
    if (first?.kind !== 'StringLit') return null;
    return typeof first.value === 'string' ? first.value : null;
  }
  return null;
}
