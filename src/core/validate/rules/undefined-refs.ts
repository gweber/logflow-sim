import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { IRStatement } from '../../ir/model.js';
import { suggest, withSuggestion } from '../../diagnostics-suggest.js';

/**
 * Catch references that point at things that don't exist:
 *   - `input(... ruleset="X")` where ruleset X is never defined
 *   - `call X` where X is never defined
 *   - `action(type="omfile" DynaFile="T")` where template T is never defined
 *   - `lookup("T", k)` where lookup table T is never declared
 *
 * The parser/loader catch some of these already (missing lookup *files*,
 * missing template names at simulate time). This rule surfaces them as
 * dedicated static-analysis warnings, with file:line attached.
 */
export const undefinedRefsRule: ValidationRule = {
  id: 'undefined-refs',
  description: 'Reference to a ruleset, template, or lookup table that is never defined',
  defaultSeverity: 'warning',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const rulesetNames = new Set(model.rulesets.map((r) => r.name));
    const templateNames = new Set(model.templates.map((t) => t.name).filter(Boolean));
    const lookupNames = new Set(model.lookupTables.map((l) => l.name));

    for (const inp of model.inputs) {
      if (inp.ruleset && !rulesetNames.has(inp.ruleset)) {
        findings.push({
          severity: 'warning',
          message: withSuggestion(
            `Input on port ${inp.port ?? '?'} references undefined ruleset "${inp.ruleset}"`,
            suggest(inp.ruleset, rulesetNames)
          ),
          source: inp.source,
          code: 'V_UNDEFINED_RULESET'
        });
      }
    }
    if (model.globals.defaultRuleset && !rulesetNames.has(model.globals.defaultRuleset)) {
      findings.push({
        severity: 'warning',
        message: withSuggestion(
          `$DefaultRuleset "${model.globals.defaultRuleset}" is never defined`,
          suggest(model.globals.defaultRuleset, rulesetNames)
        ),
        source: model.rulesets[0]?.source ?? { file: '?', line: 0, col: 0, offset: 0, length: 0 },
        code: 'V_UNDEFINED_DEFAULT_RULESET'
      });
    }

    function walk(stmts: IRStatement[]): void {
      for (const s of stmts) {
        switch (s.kind) {
          case 'If':
            walkExpr(s.condition);
            walk(s.then);
            if (s.else) walk(s.else);
            break;
          case 'Set':
          case 'Reset':
            walkExpr(s.value);
            break;
          case 'Call':
            if (!rulesetNames.has(s.ruleset)) {
              findings.push({
                severity: 'warning',
                message: withSuggestion(
                  `\`call ${s.ruleset}\` references undefined ruleset`,
                  suggest(s.ruleset, rulesetNames)
                ),
                source: s.source,
                code: 'V_UNDEFINED_RULESET'
              });
            }
            break;
          case 'Action': {
            for (const k of ['dynafile', 'template']) {
              const v = s.params[k];
              if (typeof v === 'string' && v && !templateNames.has(v)) {
                findings.push({
                  severity: 'warning',
                  message: withSuggestion(
                    `action ${s.actionType} references undefined template "${v}"`,
                    suggest(v, templateNames)
                  ),
                  source: s.source,
                  code: 'V_UNDEFINED_TEMPLATE'
                });
              }
            }
            for (const v of Object.values(s.params)) walkExpr(v);
            break;
          }
          case 'ReloadLookupTable':
            if (!lookupNames.has(s.table)) {
              findings.push({
                severity: 'warning',
                message: withSuggestion(
                  `reload_lookup_table("${s.table}") on a table that is never declared`,
                  suggest(s.table, lookupNames)
                ),
                source: s.source,
                code: 'V_UNDEFINED_LOOKUP'
              });
            }
            break;
        }
      }
    }

    function walkExpr(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const e = value as {
        kind?: string;
        table?: unknown;
        callee?: string;
        args?: unknown[];
        elements?: unknown[];
        left?: unknown;
        right?: unknown;
        operand?: unknown;
        inner?: unknown;
        key?: unknown;
      };
      if (e.kind === 'LookupCall' && e.table) {
        const tt = e.table as { kind?: string; value?: string };
        if (tt.kind === 'StringLit' && typeof tt.value === 'string' && !lookupNames.has(tt.value)) {
          findings.push({
            severity: 'warning',
            message: withSuggestion(
              `lookup("${tt.value}", …) references undeclared table`,
              suggest(tt.value, lookupNames)
            ),
            source: (e as { source?: import('../../source-map.js').SourceLoc }).source ?? {
              file: '?',
              line: 0,
              col: 0,
              offset: 0,
              length: 0
            },
            code: 'V_UNDEFINED_LOOKUP'
          });
        }
      }
      if (e.kind === 'CallExpr' && e.callee === 'exec_template' && Array.isArray(e.args)) {
        const arg0 = e.args[0] as { kind?: string; value?: string } | undefined;
        if (
          arg0 &&
          arg0.kind === 'StringLit' &&
          typeof arg0.value === 'string' &&
          !templateNames.has(arg0.value)
        ) {
          findings.push({
            severity: 'warning',
            message: withSuggestion(
              `exec_template("${arg0.value}") references undefined template`,
              suggest(arg0.value, templateNames)
            ),
            source: (e as { source?: import('../../source-map.js').SourceLoc }).source ?? {
              file: '?',
              line: 0,
              col: 0,
              offset: 0,
              length: 0
            },
            code: 'V_UNDEFINED_TEMPLATE'
          });
        }
      }
      for (const k of ['left', 'right', 'operand', 'inner', 'table', 'key']) {
        if (k in e) walkExpr((e as Record<string, unknown>)[k]);
      }
      if (Array.isArray(e.args)) for (const a of e.args) walkExpr(a);
      if (Array.isArray(e.elements)) for (const el of e.elements) walkExpr(el);
    }

    for (const rs of model.rulesets) walk(rs.statements);
    return findings;
  }
};
