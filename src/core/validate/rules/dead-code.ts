import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import { analyzeReachability } from '../../analyze/reachability.js';

/**
 * Surface dead-code findings as validation diagnostics so they show up in
 * the standard severity-filterable list:
 *   - rulesets that are never reached from any input
 *   - lookup tables that are never queried
 *   - templates that are never referenced
 *
 * These are info-level by default — they don't break a deploy, but a clean
 * repository is one where every defined thing is used.
 */
export const deadCodeRule: ValidationRule = {
  id: 'dead-code',
  description: 'Rulesets, templates, or lookup tables that are defined but never used',
  defaultSeverity: 'info',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const report = analyzeReachability(model);

    for (const name of report.deadRulesets) {
      const rs = model.rulesetByName[name];
      if (!rs) continue;
      // Special case: synthetic _default_legacy is internally generated; skip.
      if (name === '_default_legacy') continue;
      findings.push({
        severity: 'info',
        message: `Ruleset "${name}" is defined but never bound to an input or called`,
        source: rs.source,
        code: 'V_DEAD_RULESET'
      });
    }
    for (const name of report.unusedLookupTables) {
      const lt = model.lookupTableByName[name];
      if (!lt) continue;
      findings.push({
        severity: 'info',
        message: `Lookup table "${name}" is loaded but never queried via lookup()`,
        source: lt.source,
        code: 'V_UNUSED_LOOKUP'
      });
    }
    for (const name of report.unusedTemplates) {
      const tpl = model.templateByName[name];
      if (!tpl) continue;
      findings.push({
        severity: 'info',
        message: `Template "${name}" is defined but never referenced`,
        source: tpl.source,
        code: 'V_UNUSED_TEMPLATE'
      });
    }

    return findings;
  }
};
