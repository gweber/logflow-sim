import type { IRModel, IRStatement } from '../ir/model.js';
import { buildFlowGraph } from './flow.js';

/**
 * Reachability analysis: starting from every input (and `$DefaultRuleset`),
 * which rulesets can a message actually visit, and which sit there but are
 * never invoked?
 *
 * Dead rulesets are a strong signal of stale configuration — they often
 * mean someone removed an input binding but forgot the ruleset.
 *
 * The implementation reuses the flow graph: any ruleset node reachable from
 * an input or default-ruleset node is "live"; the rest are "dead".
 */
export interface ReachabilityReport {
  liveRulesets: string[];
  deadRulesets: string[];
  /** Rulesets bound to inputs (entry points). */
  entryRulesets: string[];
  /** Lookup tables defined but never queried via `lookup("name", …)`. */
  unusedLookupTables: string[];
  /** Templates defined but never referenced by any action's DynaFile/template. */
  unusedTemplates: string[];
}

export function analyzeReachability(model: IRModel): ReachabilityReport {
  const graph = buildFlowGraph(model);
  const adjacency = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }

  // Entry points: ruleset nodes reachable from input nodes.
  const entryRulesetIds = new Set<string>();
  for (const e of graph.edges) {
    if (e.reason === 'input' || e.reason === 'fallback') {
      entryRulesetIds.add(e.to);
    }
  }

  // BFS from each entry
  const visited = new Set<string>();
  const queue = [...entryRulesetIds];
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of adjacency.get(cur) ?? []) queue.push(next);
  }

  const liveRulesets: string[] = [];
  const deadRulesets: string[] = [];
  for (const rs of model.rulesets) {
    if (visited.has(rs.id)) liveRulesets.push(rs.name);
    else deadRulesets.push(rs.name);
  }

  // Unused lookup tables: walk all expressions; collect every LookupCall.
  const usedLookups = new Set<string>();
  function walk(stmts: IRStatement[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case 'If':
          collectLookups(s.condition);
          walk(s.then);
          if (s.else) walk(s.else);
          break;
        case 'Set':
        case 'Reset':
          collectLookups(s.value);
          break;
        case 'Action':
          for (const v of Object.values(s.params)) collectLookups(v);
          break;
      }
    }
  }
  function collectLookups(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const e = value as { kind?: string; table?: unknown; left?: unknown; right?: unknown; operand?: unknown; inner?: unknown; args?: unknown[]; elements?: unknown[] };
    if (e.kind === 'LookupCall' && e.table && typeof e.table === 'object') {
      const tt = e.table as { kind?: string; value?: string };
      if (tt.kind === 'StringLit' && typeof tt.value === 'string') usedLookups.add(tt.value);
    }
    for (const k of ['left', 'right', 'operand', 'inner', 'table', 'key']) {
      if (k in e) collectLookups((e as Record<string, unknown>)[k]);
    }
    if (Array.isArray(e.args)) for (const a of e.args) collectLookups(a);
    if (Array.isArray(e.elements)) for (const el of e.elements) collectLookups(el);
  }
  for (const rs of model.rulesets) walk(rs.statements);

  const unusedLookupTables = model.lookupTables
    .map((lt) => lt.name)
    .filter((n) => !usedLookups.has(n));

  // Unused templates: walk all actions, collect template/DynaFile params,
  // also `exec_template("...")` calls.
  const usedTemplates = new Set<string>();
  function collectTemplates(stmts: IRStatement[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case 'If':
          collectTemplatesFromExpr(s.condition);
          collectTemplates(s.then);
          if (s.else) collectTemplates(s.else);
          break;
        case 'Set':
        case 'Reset':
          collectTemplatesFromExpr(s.value);
          break;
        case 'Action': {
          const dyna = s.params['dynafile'];
          if (typeof dyna === 'string') usedTemplates.add(dyna);
          const tmpl = s.params['template'];
          if (typeof tmpl === 'string') usedTemplates.add(tmpl);
          break;
        }
      }
    }
  }
  function collectTemplatesFromExpr(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const e = value as { kind?: string; callee?: string; args?: unknown[] };
    if (e.kind === 'CallExpr' && e.callee === 'exec_template' && Array.isArray(e.args)) {
      const arg0 = e.args[0] as { kind?: string; value?: string } | undefined;
      if (arg0 && arg0.kind === 'StringLit' && typeof arg0.value === 'string') {
        usedTemplates.add(arg0.value);
      }
    }
    const o = value as Record<string, unknown>;
    for (const k of ['left', 'right', 'operand', 'inner', 'table', 'key']) {
      if (k in o) collectTemplatesFromExpr(o[k]);
    }
    if (Array.isArray(e.args)) for (const a of e.args) collectTemplatesFromExpr(a);
  }
  for (const rs of model.rulesets) collectTemplates(rs.statements);

  const unusedTemplates = model.templates
    .map((t) => t.name)
    .filter((n) => n && !usedTemplates.has(n));

  return {
    liveRulesets,
    deadRulesets,
    entryRulesets: [...entryRulesetIds]
      .map((id) => model.rulesets.find((r) => r.id === id)?.name)
      .filter((n): n is string => !!n),
    unusedLookupTables,
    unusedTemplates
  };
}
