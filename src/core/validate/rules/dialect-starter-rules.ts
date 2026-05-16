/**
 * Starter validation rules for dialects that don't yet have a rich
 * rule-set. One rule each, each pinning the most common boot-time
 * failure mode for that dialect. PRs adding more rules per dialect are
 * the obvious next iteration — see CONTRIBUTING.md.
 */

import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';

// ---------------------------------------------------------------------------
// Fluent Bit
// ---------------------------------------------------------------------------

export const fluentBitOutputWithoutMatchRule: ValidationRule = {
  id: 'fluent-bit/output-without-match',
  description:
    'A Fluent Bit [OUTPUT] section has no Match directive — it will only consume records with the literal tag "fluent_bit", almost never what the operator intended',
  defaultSeverity: 'warning',
  dialects: ['fluent-bit'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const out of model.outputs) {
      const match = out.params['match'] ?? out.params['Match'];
      if (typeof match === 'string' && match.length > 0) continue;
      findings.push({
        severity: 'warning',
        message:
          `[OUTPUT] section "${out.name}" has no Match directive — without it Fluent Bit only ` +
          `processes records whose tag literally equals the section name, which almost never matches ` +
          `real traffic. Add \`Match *\` for catch-all or a specific tag pattern.`,
        source: out.source,
        code: 'V_FLUENT_BIT_OUTPUT_NO_MATCH'
      });
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Logstash
// ---------------------------------------------------------------------------

export const logstashOutputWithoutInputRule: ValidationRule = {
  id: 'logstash/output-without-input',
  description:
    'A Logstash config has output{} blocks but no input{} block — events have no source to come from',
  defaultSeverity: 'error',
  dialects: ['logstash'],
  run(model): Diagnostic[] {
    if (model.outputs.length === 0) return [];
    if (model.inputs.length > 0) return [];
    return [
      {
        severity: 'error',
        message:
          `Logstash config declares ${model.outputs.length} output(s) but no input{} block — ` +
          `Logstash will refuse to start (or run idle, depending on version).`,
        source: model.outputs[0].source,
        code: 'V_LOGSTASH_OUTPUT_NO_INPUT'
      }
    ];
  }
};

// ---------------------------------------------------------------------------
// NXLog
// ---------------------------------------------------------------------------

export const nxlogRouteTargetUndefinedRule: ValidationRule = {
  id: 'nxlog/route-target-undefined',
  description:
    'An NXLog Route declaration references a module (input/processor/output) name not declared elsewhere',
  defaultSeverity: 'error',
  dialects: ['nxlog'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const known = new Set<string>();
    for (const i of model.inputs) known.add(String(i.params['name'] ?? i.id));
    for (const o of model.outputs) known.add(o.name);
    for (const m of model.modules) known.add(String(m.params['name'] ?? m.id));

    for (const r of model.routes) {
      const refs = [...r.inputRefs, ...r.transformRefs, ...r.outputRefs];
      for (const ref of refs) {
        if (known.has(ref)) continue;
        findings.push({
          severity: 'error',
          message:
            `Route "${r.name}" references "${ref}", but no module by that name is declared. ` +
            `NXLog will fail to load this route at startup.`,
          source: r.source,
          code: 'V_NXLOG_ROUTE_TARGET_UNDEFINED'
        });
      }
    }
    return findings;
  }
};
