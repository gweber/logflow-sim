import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';

/**
 * OTel Collector pipeline integrity. The collector ships under-the-hood
 * runtime validation that fails startup when a `service.pipelines.*`
 * references a receiver/processor/exporter that isn't declared at the
 * top level. We surface the same checks pre-deploy so a CI gate trips
 * before the collector container goes into crash-loop.
 *
 * The collector ALSO refuses to start when a pipeline lists no exporters.
 * That gets its own rule because the fix is different: "you forgot to
 * wire your data anywhere" vs "you spelled the exporter name wrong".
 */

const COMMON: Pick<ValidationRule, 'defaultSeverity' | 'dialects'> = {
  defaultSeverity: 'error',
  dialects: ['otel']
};

export const otelPipelineComponentUndefinedRule: ValidationRule = {
  ...COMMON,
  id: 'otel/pipeline-component-undefined',
  description:
    'service.pipelines references a receiver/processor/exporter not declared at the top level',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const receivers = new Set(model.inputs.map((i) => String(i.params['name'] ?? '')).filter(Boolean));
    const processors = new Set(model.modules.map((m) => String(m.params['name'] ?? '')).filter(Boolean));
    const exporters = new Set(model.outputs.map((o) => o.name));

    for (const r of model.routes) {
      const pipelineName = r.name ?? '<unnamed>';
      for (const ref of r.inputRefs) {
        if (!receivers.has(ref)) {
          findings.push(mkFinding(r.source, 'receiver', ref, pipelineName));
        }
      }
      for (const ref of r.transformRefs) {
        if (!processors.has(ref)) {
          findings.push(mkFinding(r.source, 'processor', ref, pipelineName));
        }
      }
      for (const ref of r.outputRefs) {
        if (!exporters.has(ref)) {
          findings.push(mkFinding(r.source, 'exporter', ref, pipelineName));
        }
      }
    }
    return findings;
  }
};

function mkFinding(
  source: { file: string; line: number; col: number; offset: number; length: number },
  kind: 'receiver' | 'processor' | 'exporter',
  name: string,
  pipelineName: string
): Diagnostic {
  return {
    severity: 'error',
    message:
      `Pipeline "${pipelineName}" references ${kind} "${name}", but no \`${kind}s.${name}:\` ` +
      `block is declared. The OTel collector will refuse to start with this config.`,
    source,
    code: 'V_OTEL_COMPONENT_UNDEFINED'
  };
}

export const otelPipelineNoExportersRule: ValidationRule = {
  ...COMMON,
  id: 'otel/pipeline-no-exporters',
  description:
    'service.pipelines entry has no exporters — telemetry coming in has nowhere to go',
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const r of model.routes) {
      if (r.inputRefs.length === 0) continue;
      if (r.outputRefs.length === 0) {
        findings.push({
          severity: 'error',
          message:
            `Pipeline "${r.name}" has receivers but no exporters — telemetry will be ingested ` +
            `and immediately dropped. The OTel collector refuses to start with this shape.`,
          source: r.source,
          code: 'V_OTEL_PIPELINE_NO_EXPORTERS'
        });
      }
    }
    return findings;
  }
};
