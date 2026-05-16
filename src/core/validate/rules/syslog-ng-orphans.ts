import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';

/**
 * Orphan-detection for syslog-ng. A syslog-ng config declares sources,
 * destinations, filters, and parsers as top-level statements, then wires
 * them into `log { source(s); filter(f); destination(d); };` blocks. The
 * footgun: declare a destination but forget to mention it in any `log`,
 * and messages don't flow there — silently. Same for sources and filters.
 *
 * We surface each kind separately so an operator can disable just the
 * "orphan filter" finding (which is sometimes intentional — operators
 * keep stub filters around for documentation) without losing the
 * critical "orphan source" warning (which is almost always a real bug).
 */

const COMMON: Pick<ValidationRule, 'defaultSeverity' | 'dialects'> = {
  defaultSeverity: 'warning',
  dialects: ['syslog-ng']
};

export const syslogNgOrphanSourceRule: ValidationRule = {
  ...COMMON,
  id: 'syslog-ng/orphan-source',
  description: 'A syslog-ng source is declared but never referenced by any log{} block',
  run(model): Diagnostic[] {
    const used = new Set<string>();
    for (const r of model.routes) for (const ref of r.inputRefs) used.add(ref);
    const findings: Diagnostic[] = [];
    for (const inp of model.inputs) {
      // syslog-ng sources are named in `inp.params.name` after the parser
      // strips the `source <name>` header. Fall back to the synthetic id.
      const name = String(inp.params['name'] ?? inp.id);
      if (used.has(name)) continue;
      findings.push({
        severity: 'warning',
        message:
          `Source "${name}" is declared but never used in a log{} block — no messages from it will be routed.`,
        source: inp.source,
        code: 'V_SYSLOGNG_ORPHAN_SOURCE'
      });
    }
    return findings;
  }
};

export const syslogNgOrphanDestinationRule: ValidationRule = {
  ...COMMON,
  id: 'syslog-ng/orphan-destination',
  description: 'A syslog-ng destination is declared but never referenced by any log{} block',
  run(model): Diagnostic[] {
    const used = new Set<string>();
    for (const r of model.routes) for (const ref of r.outputRefs) used.add(ref);
    const findings: Diagnostic[] = [];
    for (const out of model.outputs) {
      if (used.has(out.name)) continue;
      findings.push({
        severity: 'warning',
        message:
          `Destination "${out.name}" is declared but never used in a log{} block — it's dead config.`,
        source: out.source,
        code: 'V_SYSLOGNG_ORPHAN_DESTINATION'
      });
    }
    return findings;
  }
};

export const syslogNgOrphanFilterRule: ValidationRule = {
  ...COMMON,
  id: 'syslog-ng/orphan-filter',
  // Info-level because intentionally-kept-for-docs filters are real.
  defaultSeverity: 'info',
  description: 'A syslog-ng filter is declared but never referenced by any log{} block',
  run(model): Diagnostic[] {
    const used = new Set<string>();
    for (const r of model.routes) for (const ref of r.filterRefs) used.add(ref);
    const findings: Diagnostic[] = [];
    for (const f of model.filters) {
      if (used.has(f.name)) continue;
      findings.push({
        severity: 'info',
        message: `Filter "${f.name}" is declared but never referenced.`,
        source: f.source,
        code: 'V_SYSLOGNG_ORPHAN_FILTER'
      });
    }
    return findings;
  }
};

export const syslogNgLogWithoutDestinationRule: ValidationRule = {
  ...COMMON,
  id: 'syslog-ng/log-without-destination',
  description:
    'A syslog-ng log{} block has sources/filters but no destination — messages reach the end of the pipeline without going anywhere',
  defaultSeverity: 'error',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const r of model.routes) {
      if (r.inputRefs.length === 0) continue; // nothing to drop yet
      if (r.outputRefs.length === 0) {
        findings.push({
          severity: 'error',
          message:
            `log{} block named "${r.name}" pulls from source(s) but lists no destination — ` +
            `messages routed here are silently discarded.`,
          source: r.source,
          code: 'V_SYSLOGNG_LOG_NO_DEST'
        });
      }
    }
    return findings;
  }
};
