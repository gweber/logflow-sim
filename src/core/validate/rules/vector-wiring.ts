import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';

/**
 * Vector wiring integrity. Every transform/sink in Vector has an
 * `inputs = [...]` array pointing at the upstream sources or transforms
 * it consumes. Names that don't resolve cause Vector to refuse the
 * config at boot. Empty `inputs = []` on a sink is configurable-but-
 * almost-never-intentional — the sink stays idle.
 */

const COMMON: Pick<ValidationRule, 'dialects'> = { dialects: ['vector'] };

export const vectorInputRefUndefinedRule: ValidationRule = {
  ...COMMON,
  id: 'vector/input-ref-undefined',
  description:
    'A Vector transform or sink `inputs` array references a component name not declared anywhere',
  defaultSeverity: 'error',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const sourceNames = new Set(model.inputs.map((i) => String(i.params['name'] ?? '')));
    const transformNames = new Set(model.modules.map((m) => String(m.params['name'] ?? '')));
    const knownUpstream = new Set([...sourceNames, ...transformNames]);

    // We check the LITERAL `inputs = [...]` arrays from each sink and
    // transform — `r.inputRefs` is the already-resolved DAG-walked list,
    // which silently drops typos. The literal refs live in the params
    // (Vector's flatten joins arrays with `,`).
    function checkRefs(name: string, raw: unknown, source: typeof model.outputs[0]['source']): void {
      if (typeof raw !== 'string' || raw.length === 0) return;
      for (const ref of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (knownUpstream.has(ref)) continue;
        findings.push({
          severity: 'error',
          message:
            `Component "${name}" has \`inputs = [..., "${ref}", ...]\` but no source or transform ` +
            `with that name is declared. Vector will refuse this config at startup.`,
          source,
          code: 'V_VECTOR_INPUT_REF_UNDEFINED'
        });
      }
    }
    for (const out of model.outputs) checkRefs(out.name, out.params['inputs'], out.source);
    for (const mod of model.modules) {
      const n = String(mod.params['name'] ?? mod.id);
      checkRefs(n, mod.params['inputs'], mod.source);
    }
    return findings;
  }
};

export const vectorSinkWithoutInputsRule: ValidationRule = {
  ...COMMON,
  id: 'vector/sink-without-inputs',
  description: 'A Vector sink has no `inputs = [...]` — nothing will flow to it',
  defaultSeverity: 'warning',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const r of model.routes) {
      if (r.outputRefs.length === 0) continue;
      if (r.inputRefs.length === 0) {
        findings.push({
          severity: 'warning',
          message:
            `Sink "${r.name}" has an empty \`inputs = []\` — Vector accepts this but no telemetry ` +
            `will ever reach the sink. Did you forget to wire it to a source or transform?`,
          source: r.source,
          code: 'V_VECTOR_SINK_NO_INPUTS'
        });
      }
    }
    return findings;
  }
};
