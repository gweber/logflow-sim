import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';

/**
 * Surface lookup-table-file loading failures as validation findings.
 *
 * The loader already emits a parse-time warning (`W_LOOKUP_MISSING` /
 * `W_LOOKUP_READ`) for each lookup_table(...) reference whose JSON file
 * isn't readable. We mirror those into the validation report so the CI
 * gate (`--fail-on=warnings`) trips on missing data files the same way it
 * trips on dead code or silent drops.
 *
 * The original implementation tried to type-pun an `IRLookupTable` into
 * something with a `loaded` field — that field lives on the runtime
 * `LookupTableData` shape that the validator doesn't have access to. The
 * cast hid the bug: the rule never fired. We now consume the loader
 * diagnostics that already exist on the model and republish them with a
 * stable validation code.
 */
export const missingFilesRule: ValidationRule = {
  id: 'missing-files',
  description:
    'Lookup-table file referenced by lookup_table(...) does not exist or is unreadable',
  defaultSeverity: 'warning',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const d of model.diagnostics) {
      if (d.code === 'W_LOOKUP_MISSING' || d.code === 'W_LOOKUP_READ') {
        findings.push({
          severity: 'warning',
          message: d.message,
          source: d.source,
          code: 'V_LOOKUP_NOT_LOADED'
        });
      }
    }
    return findings;
  }
};
