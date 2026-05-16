import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';

/**
 * `global(DefaultRuleset="...")` or the legacy `$DefaultRuleset name`
 * names a ruleset that doesn't exist. At runtime rsyslog falls through
 * to the synthetic RSYSLOG_DefaultRuleset — meaning every input that
 * didn't bind to a named ruleset writes to whatever that catch-all
 * looks like (often "log everything to /var/log/messages").
 *
 * This is one of those rules that almost never trips on a fresh write
 * but trips ALL THE TIME during refactors: rename `catchall` → `catch_all`
 * and forget to update the `$DefaultRuleset`. Inputs without an explicit
 * `ruleset="..."` start hitting the synthetic default.
 */
export const rsyslogDefaultRulesetUndefinedRule: ValidationRule = {
  id: 'rsyslog/default-ruleset-undefined',
  description:
    'The configured default ruleset (`$DefaultRuleset` / `global(DefaultRuleset=...)`) names a ruleset that does not exist',
  defaultSeverity: 'error',
  dialects: ['rsyslog'],

  run(model): Diagnostic[] {
    const defaultName = model.globals.defaultRuleset;
    if (!defaultName) return [];
    if (model.rulesetByName[defaultName]) return [];
    return [
      {
        severity: 'error',
        message:
          `Default ruleset "${defaultName}" is set globally but no ruleset(name="${defaultName}") ` +
          `is declared. Inputs without an explicit ruleset="..." will fall through to the ` +
          `built-in RSYSLOG_DefaultRuleset at startup, which usually isn't what you want.`,
        // No precise source location for `$DefaultRuleset` once it lands
        // in globals — the legacy parser flattens it. Anchor on the first
        // file in the model so the finding has a usable file context.
        source: {
          file: model.files[0] ?? '<global>',
          line: 0,
          col: 0,
          offset: 0,
          length: 0
        },
        code: 'V_RSYSLOG_DEFAULT_RULESET_UNDEFINED'
      }
    ];
  }
};
