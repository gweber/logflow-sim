import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { IRStatement } from '../../ir/model.js';

/**
 * rsyslog action references a `template="..."` name that isn't declared
 * anywhere. rsyslog at startup errors out for the affected action and
 * silently routes to default — messages disappear into the catch-all
 * template, which usually means everything lands in /var/log/messages
 * instead of the operator-intended path.
 */
export const rsyslogTemplateUndefinedRule: ValidationRule = {
  id: 'rsyslog/template-undefined',
  description:
    'An rsyslog action references a template name that no template(...) statement declares',
  defaultSeverity: 'error',
  dialects: ['rsyslog'],

  run(model): Diagnostic[] {
    const declared = new Set(model.templates.map((t) => t.name));
    const findings: Diagnostic[] = [];

    function visit(stmts: IRStatement[]): void {
      for (const s of stmts) {
        if (s.kind === 'If') {
          visit(s.then);
          if (s.else) visit(s.else);
          continue;
        }
        if (s.kind !== 'Action') continue;
        // Common keys rsyslog uses to name an output template per action.
        for (const key of ['template', 'DynaFileCacheSize', 'dynafile']) {
          const v = s.params[key];
          if (typeof v !== 'string') continue;
          // `dynafile` references a template name; literal file paths
          // (starting with `/`) are bareword filenames, not template refs.
          if (key === 'dynafile' && v.startsWith('/')) continue;
          if (key === 'DynaFileCacheSize') continue; // numeric, not a template
          if (!declared.has(v)) {
            findings.push({
              severity: 'error',
              message:
                `Action references template "${v}" via \`${key}=\`, but no \`template(name="${v}" ...)\` ` +
                `is declared. rsyslog will error at startup and the affected route won't fire.`,
              source: s.source,
              code: 'V_RSYSLOG_TEMPLATE_UNDEFINED'
            });
          }
        }
      }
    }
    for (const rs of model.rulesets) visit(rs.statements);
    return findings;
  }
};
