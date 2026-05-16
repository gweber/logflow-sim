import type { IRModel } from '../ir/model.js';
import type { Diagnostic } from '../diagnostics.js';
import type { ValidationRule, ValidationReport, ValidateOptions } from './types.js';
import { undefinedRefsRule } from './rules/undefined-refs.js';
import { deadCodeRule } from './rules/dead-code.js';
import { missingFilesRule } from './rules/missing-files.js';
import { conflictingOutputsRule } from './rules/conflicting-outputs.js';
import { silentDropPathsRule } from './rules/silent-drop-paths.js';
// rsyslog
import { moduleLoadRequiredRule } from './rules/module-load-required.js';
import { rsyslogTemplateUndefinedRule } from './rules/rsyslog-template-undefined.js';
import { rsyslogDefaultRulesetUndefinedRule } from './rules/rsyslog-default-ruleset-undefined.js';
// syslog-ng
import {
  syslogNgOrphanSourceRule,
  syslogNgOrphanDestinationRule,
  syslogNgOrphanFilterRule,
  syslogNgLogWithoutDestinationRule
} from './rules/syslog-ng-orphans.js';
// otel
import {
  otelPipelineComponentUndefinedRule,
  otelPipelineNoExportersRule
} from './rules/otel-pipeline.js';
// vector
import {
  vectorInputRefUndefinedRule,
  vectorSinkWithoutInputsRule
} from './rules/vector-wiring.js';
// starter rules (one per remaining dialect)
import {
  fluentBitOutputWithoutMatchRule,
  logstashOutputWithoutInputRule,
  nxlogRouteTargetUndefinedRule
} from './rules/dialect-starter-rules.js';

/**
 * The default rule set. Add more rules here as they're built — every rule
 * is opt-out via `ValidateOptions.disable`, not opt-in, so new rules light
 * up automatically for existing users.
 */
const DEFAULT_RULES: ValidationRule[] = [
  // Cross-dialect (operate on the normalized IR)
  undefinedRefsRule,
  deadCodeRule,
  missingFilesRule,
  conflictingOutputsRule,
  silentDropPathsRule,
  // rsyslog
  moduleLoadRequiredRule,
  rsyslogTemplateUndefinedRule,
  rsyslogDefaultRulesetUndefinedRule,
  // syslog-ng
  syslogNgOrphanSourceRule,
  syslogNgOrphanDestinationRule,
  syslogNgOrphanFilterRule,
  syslogNgLogWithoutDestinationRule,
  // otel
  otelPipelineComponentUndefinedRule,
  otelPipelineNoExportersRule,
  // vector
  vectorInputRefUndefinedRule,
  vectorSinkWithoutInputsRule,
  // fluent-bit / logstash / nxlog (starter rules — PRs welcome to expand)
  fluentBitOutputWithoutMatchRule,
  logstashOutputWithoutInputRule,
  nxlogRouteTargetUndefinedRule
];

export function validate(model: IRModel, opts: ValidateOptions = {}): ValidationReport {
  const disabled = new Set(opts.disable ?? []);
  const override = opts.severityOverride ?? {};
  const ran: string[] = [];
  const findings: Diagnostic[] = [];
  for (const rule of DEFAULT_RULES) {
    if (disabled.has(rule.id)) continue;
    // Dialect-specific rules opt in via a `dialects` allowlist. Rules
    // without the field run against every model.
    if (rule.dialects && rule.dialects.length > 0) {
      if (!model.dialect || !rule.dialects.includes(model.dialect)) continue;
    }
    ran.push(rule.id);
    let raw: Diagnostic[];
    try {
      raw = rule.run(model);
    } catch (e) {
      findings.push({
        severity: 'error',
        message: `Validation rule "${rule.id}" threw: ${(e as Error).message}`,
        source: { file: '<validator>', line: 0, col: 0, offset: 0, length: 0 },
        code: 'V_RULE_CRASH'
      });
      continue;
    }
    const target = override[rule.id];
    if (target) {
      for (const f of raw) findings.push({ ...f, severity: target });
    } else {
      findings.push(...raw);
    }
  }
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'error') summary.errors++;
    else if (f.severity === 'warning') summary.warnings++;
    else summary.info++;
  }
  return { ranRuleIds: ran, findings, summary };
}

export type { ValidationRule, ValidationReport, ValidateOptions } from './types.js';
