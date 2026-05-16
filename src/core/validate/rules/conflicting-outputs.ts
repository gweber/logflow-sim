import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { IRStatement } from '../../ir/model.js';

/**
 * Detect the same destination written to by multiple distinct actions across
 * the configuration. Not necessarily a bug — sometimes two rulesets
 * legitimately share a file — but worth surfacing because:
 *   - Interleaved writes from concurrent rulesets can produce mixed lines.
 *   - It's often a copy-paste leftover.
 *
 * Reports each conflicting target with the source locations of every action
 * pointing at it.
 */
export const conflictingOutputsRule: ValidationRule = {
  id: 'conflicting-outputs',
  description: 'Same destination path/target written to by multiple distinct actions',
  defaultSeverity: 'info',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const byTarget = new Map<string, IRStatement[]>();

    function walk(stmts: IRStatement[]): void {
      for (const s of stmts) {
        switch (s.kind) {
          case 'If':
            walk(s.then);
            if (s.else) walk(s.else);
            break;
          case 'Action': {
            const key = describeTarget(s);
            if (!key) break;
            if (!byTarget.has(key)) byTarget.set(key, []);
            byTarget.get(key)!.push(s);
            break;
          }
        }
      }
    }
    for (const rs of model.rulesets) walk(rs.statements);

    for (const [key, actions] of byTarget) {
      if (actions.length < 2) continue;
      // Surface one finding per duplicate target; mention all locations.
      const locs = actions.map((a) => `${a.source.file}:${a.source.line}`).join(', ');
      findings.push({
        severity: 'info',
        message: `Target "${key}" is written to by ${actions.length} actions (${locs})`,
        source: actions[0].source,
        code: 'V_CONFLICTING_OUTPUT'
      });
    }
    return findings;
  }
};

function describeTarget(a: import('../../ir/model.js').IRAction): string | null {
  if (a.actionKind === 'omfile') {
    const dyna = a.params['dynafile'];
    const file = a.params['file'];
    if (typeof dyna === 'string') return `omfile:dyna(${dyna})`;
    if (typeof file === 'string') return `omfile:${file}`;
    return null;
  }
  if (a.actionKind === 'omfwd') {
    const target = a.params['target'];
    const port = a.params['port'];
    if (typeof target !== 'string') return null;
    return `omfwd:${target}:${port ?? ''}`;
  }
  return null;
}
