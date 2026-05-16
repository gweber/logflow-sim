import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { IRStatement } from '../../ir/model.js';

/**
 * Catch the classic rsyslog footgun:
 *
 *   input(type="imtcp" port="514" ...)        # ← declared
 *   # module(load="imtcp")                    # ← commented out
 *
 * The config still parses, rsyslogd still starts, the OTHER inputs still
 * work — but the imtcp listener silently doesn't bind to :514. No traffic
 * arrives. Operator finds out hours later via SIEM-side absence-alerts.
 *
 * This rule:
 *   • walks every IRInput and IRAction in the model
 *   • derives the module-load name that the type expects
 *     (e.g. `imtcp` input → `imtcp` module; `omkafka` action → `omkafka`)
 *   • errors out when that module is not in `model.modules`
 *   • exempts the rsyslog built-ins (`omfile`, `omfwd`, `omdiscard`) which
 *     don't need an explicit `module(load=...)`
 *
 * Severity is `error` — silent traffic loss is the worst-case outcome and
 * CI gates with `--fail-on=errors` should trip on it. Use the disable list
 * if you have a non-standard rsyslog build that compiles modules in
 * statically.
 */
export const moduleLoadRequiredRule: ValidationRule = {
  id: 'rsyslog/module-load-required',
  description:
    'Input or action references a type whose `module(load="...")` is missing — at runtime the component will silently not bind',
  defaultSeverity: 'error',
  dialects: ['rsyslog'],

  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const loaded = new Set(model.modules.map((m) => m.load.toLowerCase()));

    // Inputs — every type maps 1:1 onto a module name in rsyslog.
    for (const inp of model.inputs) {
      const required = moduleForInput(inp.type);
      if (!required) continue;
      if (loaded.has(required)) continue;
      findings.push({
        severity: 'error',
        message:
          `Input \`type="${inp.type}"\` declared without \`module(load="${required}")\` ` +
          `— rsyslog will silently fail to bind this listener at startup.`,
        source: inp.source,
        code: 'V_MODULE_MISSING'
      });
    }

    // Actions — only the ones that actually need an external module. omfile
    // / omfwd / omdiscard are linked into rsyslogd itself and never need a
    // module load.
    const seen = new Set<string>();
    function visit(stmts: IRStatement[]): void {
      for (const s of stmts) {
        if (s.kind === 'If') {
          visit(s.then);
          if (s.else) visit(s.else);
          continue;
        }
        if (s.kind !== 'Action') continue;
        const driver = (s.actionType || s.actionKind).toLowerCase();
        if (isBuiltInOutput(driver)) continue;
        const required = moduleForOutput(driver);
        if (!required) continue;
        // Dedupe per (driver, source-line) so a 50-rule config with the
        // same omkafka in every rule doesn't drown the report.
        const key = `${required}@${s.source.file}:${s.source.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (loaded.has(required)) continue;
        findings.push({
          severity: 'error',
          message:
            `Action \`type="${driver}"\` used without \`module(load="${required}")\` ` +
            `— rsyslog will refuse this action at startup and the messages routed here will drop.`,
          source: s.source,
          code: 'V_MODULE_MISSING'
        });
      }
    }
    for (const rs of model.rulesets) visit(rs.statements);

    return findings;
  }
};

/** Map an input type (the value used in `type="..."`) to the module-load name. */
function moduleForInput(type: string): string | null {
  const t = type.toLowerCase();
  // rsyslog 8+ input modules — these are the ones operators commonly drop
  // into a config. Unknown types fall through to null so the rule stays
  // quiet on third-party plugins rather than producing false positives.
  const KNOWN = [
    'imudp',
    'imtcp',
    'imptcp',
    'imrelp',
    'imuxsock',
    'imjournal',
    'imklog',
    'imfile',
    'imkafka',
    'imhttp',
    'imhiredis',
    'immark',
    'imsolaris',
    'imrabbitmq',
    'imgssapi',
    'imdiag'
  ];
  return KNOWN.includes(t) ? t : null;
}

/** Built-in outputs that ship with rsyslogd — no module load required. */
function isBuiltInOutput(driver: string): boolean {
  return driver === 'omfile' || driver === 'omfwd' || driver === 'omdiscard';
}

/** Map an action type to its rsyslog module-load name. */
function moduleForOutput(driver: string): string | null {
  const KNOWN = [
    'omkafka',
    'omelasticsearch',
    'omhttp',
    'omhttpfs',
    'ommongodb',
    'ommysql',
    'ompostgresql',
    'omrelp',
    'omudpspoof',
    'omprog',
    'omsnmp',
    'omhiredis',
    'omclickhouse',
    'omazureeventhubs',
    'omamqp1',
    'omrabbitmq',
    'mmjsonparse',
    'mmnormalize',
    'mmpstrucdata',
    'mmgrok'
  ];
  return KNOWN.includes(driver) ? driver : null;
}
