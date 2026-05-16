/**
 * Emit an IRModel as an OpenTelemetry Collector config (YAML).
 *
 * Strategy:
 *   IRInput  → receivers.<name>
 *   IRModule (load "processor:*" or "transform:*") → processors.<name>
 *   IROutput → exporters.<name>
 *   IRRoute  → service.pipelines.<route-name> {receivers, processors, exporters}
 *
 * Cross-dialect translation (e.g. rsyslog → otel) generally has no explicit
 * IRRoute set; for that case we fan every input to every exporter through a
 * single `logs` pipeline. This is a sensible default that boots, but the
 * user will want to refine receiver-to-exporter wiring by hand — we surface
 * that with a diagnostic.
 *
 * As with the Vector emitter, expression-language bodies (OTTL inside
 * transform/filter processors, lookups, conditionals) are NOT regenerated
 * from the IR; we emit a placeholder processor and flag it.
 */

import type { IRModel, IRStatement } from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { EmitLookupData, EmitResult } from '../types.js';
import * as yaml from 'js-yaml';

export function emit(
  model: IRModel,
  opts?: { lookupTables?: Record<string, EmitLookupData> }
): EmitResult {
  const diagnostics: Diagnostic[] = [];
  const lookupTables = opts?.lookupTables ?? {};

  const receivers: Record<string, unknown> = {};
  const processors: Record<string, unknown> = {};
  const exporters: Record<string, unknown> = {};
  const receiverNames: string[] = [];
  const exporterNames: string[] = [];
  const processorNames: string[] = [];

  for (const inp of model.inputs) {
    // OTel receiver names are `<type>/<variant>` — the type prefix carries
    // semantics, so we keep it. Defaults: rsyslog imudp/imtcp → syslog.
    const otelType = mapReceiverType(inp.type);
    const variant = inp.port ? String(inp.port) : sanitize(String(inp.params['name'] ?? 'default'));
    const name = `${otelType}/${variant}`;
    receiverNames.push(name);
    receivers[name] = receiverConfig(otelType, inp);
  }

  for (const mod of model.modules) {
    if (!mod.load.startsWith('processor:') && !mod.load.startsWith('transform:')) continue;
    const type = mod.load.split(':', 2)[1];
    const baseName = String(mod.params['name'] ?? type);
    const name = `${type}/${sanitize(baseName)}`;
    processorNames.push(name);
    processors[name] = stripInternal(mod.params);
  }
  // OTel pipelines almost always include `batch` — add it if the IR has no
  // processors at all, otherwise downstream collectors hammer their backends.
  if (Object.keys(processors).length === 0) {
    processors['batch'] = {};
    processorNames.push('batch');
  }

  for (const out of model.outputs) {
    const otelType = mapExporterType(out.driver ?? out.actionKind);
    const variant = sanitize(out.name);
    const name = `${otelType}/${variant}`;
    exporterNames.push(name);
    exporters[name] = exporterConfig(otelType, out);
  }

  // rsyslog (and other action-centric dialects) hold output destinations
  // inside ruleset action statements rather than as top-level named
  // components. Walk every ruleset and synthesize an exporter per unique
  // (kind, params) pair so the resulting OTel config has real exporters
  // wired into the pipeline.
  const synthCounter = { n: 0 };
  const seen = new Set<string>();
  function visit(stmts: IRStatement[]): void {
    for (const s of stmts) {
      if (s.kind === 'If') {
        visit(s.then);
        if (s.else) visit(s.else);
        continue;
      }
      if (s.kind !== 'Action') continue;
      const key = `${s.actionKind}:${JSON.stringify(s.params)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const otelType = mapExporterType(s.actionType || s.actionKind);
      const name = `${otelType}/${otelType}_${synthCounter.n++}`;
      exporterNames.push(name);
      exporters[name] = exporterConfig(otelType, { params: s.params as Record<string, unknown> });
    }
  }
  for (const rs of model.rulesets) visit(rs.statements);

  // Pipelines: prefer the explicit IRRoute set; fall back to a single
  // catch-all "logs" pipeline if the source dialect (e.g. rsyslog) doesn't
  // model routes as named graph edges.
  const pipelines: Record<string, unknown> = {};
  if (model.routes.length > 0) {
    for (const r of model.routes) {
      const recv = r.inputRefs.length
        ? r.inputRefs.map(matchReceiverName(receiverNames))
        : receiverNames;
      const proc = r.transformRefs.length
        ? r.transformRefs.map(matchProcessorName(processorNames))
        : processorNames;
      const exp = r.outputRefs.length
        ? r.outputRefs.map(matchExporterName(exporterNames))
        : exporterNames;
      // Pipeline names must be prefixed with the signal type. Use the route
      // flag if available, otherwise default to "logs/<route-name>".
      const signal = r.flags.find((f) => f === 'traces' || f === 'metrics' || f === 'logs') ?? 'logs';
      const pipelineName = `${signal}/${sanitize(r.name ?? 'default')}`;
      pipelines[pipelineName] = {
        receivers: dedupe(recv),
        processors: dedupe(proc),
        exporters: dedupe(exp)
      };
    }
  } else {
    pipelines['logs'] = {
      receivers: dedupe(receiverNames),
      processors: dedupe(processorNames),
      exporters: dedupe(exporterNames)
    };
    if (model.dialect && model.dialect !== 'otel') {
      diagnostics.push({
        severity: 'info',
        message: `OTel emit: ${model.dialect} doesn't expose named routes; fanned every receiver to every exporter through a single \`logs\` pipeline.`,
        source: { file: '<emit>', line: 0, col: 0, offset: 0, length: 0 },
        code: 'I_OTEL_FAN_OUT'
      });
    }
  }

  // Lookup tables → OTel "transform" processor.
  //
  // The canonical OTel idiom for a key→value lookup is the transform
  // processor with OTTL: `set(attributes["sourcetype"], Map(...)[attributes["programname"]])`.
  // For small tables we inline the entries; for large ones (>200 entries)
  // we emit a sidecar JSON file and a comment pointing at it, since OTTL
  // map literals balloon the config beyond practical readability.
  const lookupNames = model.lookupTables.map((lt) => lt.name);
  const sidecarFiles: { path: string; content: string }[] = [];
  // Map from lookup-table name to the actual processor name we ended up
  // emitting, so the pipeline-wiring step below knows the real keys (after
  // collision resolution) instead of recomputing them.
  const lookupProcessorByTable = new Map<string, string>();
  if (lookupNames.length > 0) {
    const usedNames = new Set<string>(processorNames);
    for (const lt of model.lookupTables) {
      const data = lookupTables[lt.name];
      const entries = data?.entries ?? {};
      const nomatch = data?.nomatch ?? '';
      // Two lookup tables whose sanitized names collide ("foo-bar" and
      // "foo_bar" both become "foo_bar") must not overwrite each other's
      // processor entries. Append a numeric suffix until we find a free key.
      let procName = `transform/lookup_${sanitize(lt.name)}`;
      let suffix = 2;
      while (usedNames.has(procName)) {
        procName = `transform/lookup_${sanitize(lt.name)}_${suffix++}`;
      }
      usedNames.add(procName);
      lookupProcessorByTable.set(lt.name, procName);
      processorNames.push(procName);
      if (Object.keys(entries).length === 0) {
        processors[procName] = {
          // No data loaded: leave a stub the operator can fill in.
          log_statements: [
            {
              context: 'log',
              statements: [
                `# logflow-sim: lookup table "${lt.name}" had no loaded data — fill the map below.`,
                `set(attributes["${lt.name}"], "${nomatch}") where attributes["${lt.name}"] == nil`
              ]
            }
          ]
        };
        diagnostics.push({
          severity: 'warning',
          message: `OTel emit: lookup table "${lt.name}" had no loaded data; emitted a stub transform processor.`,
          source: { file: '<emit>', line: 0, col: 0, offset: 0, length: 0 },
          code: 'W_OTEL_LOOKUP_EMPTY'
        });
        continue;
      }
      if (Object.keys(entries).length > 200) {
        // Sidecar JSON + comment pointer.
        const sidecarPath = `lookups/${sanitize(lt.name)}.json`;
        sidecarFiles.push({
          path: sidecarPath,
          content: JSON.stringify({ nomatch, entries }, null, 2) + '\n'
        });
        processors[procName] = {
          log_statements: [
            {
              context: 'log',
              statements: [
                `# logflow-sim: ${Object.keys(entries).length} entries too many to inline; see ${sidecarPath}`,
                `set(attributes["${lt.name}"], "${nomatch}") where attributes["${lt.name}"] == nil`
              ]
            }
          ]
        };
        diagnostics.push({
          severity: 'info',
          message: `OTel emit: lookup "${lt.name}" emitted as sidecar ${sidecarPath} (${Object.keys(entries).length} entries).`,
          source: { file: '<emit>', line: 0, col: 0, offset: 0, length: 0 },
          code: 'I_OTEL_LOOKUP_SIDECAR'
        });
        continue;
      }
      // Inline the table as an OTTL conditional-set chain. Less elegant
      // than a Map literal but more universally supported across collector
      // versions — Map() in OTTL is relatively recent.
      const statements: string[] = [];
      for (const [k, v] of Object.entries(entries)) {
        statements.push(
          `set(attributes["${lt.name}"], "${escapeOttl(v)}") where attributes["lookup_key"] == "${escapeOttl(k)}"`
        );
      }
      if (nomatch) {
        statements.push(
          `set(attributes["${lt.name}"], "${escapeOttl(nomatch)}") where attributes["${lt.name}"] == nil`
        );
      }
      processors[procName] = {
        log_statements: [{ context: 'log', statements }]
      };
    }
    // Wire the new lookup processors into the existing `logs` pipeline so
    // they actually run. Other pipelines (traces/metrics) are left alone.
    for (const [name, def] of Object.entries(pipelines)) {
      if (!name.startsWith('logs')) continue;
      const d = def as Record<string, unknown>;
      const existing = Array.isArray(d.processors) ? (d.processors as string[]) : [];
      d.processors = dedupe([
        ...existing,
        ...lookupNames
          .map((n) => lookupProcessorByTable.get(n))
          .filter((n): n is string => typeof n === 'string')
      ]);
    }
  }

  const doc = {
    receivers,
    processors,
    exporters,
    service: { pipelines }
  };

  const body = yaml.dump(doc, { noRefs: true, lineWidth: 120, sortKeys: false });
  const header = `# Generated by logflow-sim convert\n# Source dialect: ${model.dialect ?? 'unknown'}\n\n`;
  const output = header + body;
  const files = [
    { path: 'otel-collector.yaml', content: output },
    ...sidecarFiles
  ];
  return { output, files, diagnostics };
}

function escapeOttl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapReceiverType(t: string): string {
  const x = t.toLowerCase();
  if (x === 'imudp' || x === 'imtcp' || x === 'imrelp' || x === 'syslog') return 'syslog';
  if (x === 'imjournal') return 'journald';
  if (x === 'imfile' || x === 'file') return 'filelog';
  if (x === 'imkafka' || x === 'kafka') return 'kafka';
  if (x === 'imhttp' || x === 'http') return 'httpcheck';
  if (x === 'otlp') return 'otlp';
  return 'syslog'; // sensible default for syslog-shaped sources
}

function mapExporterType(t: string): string {
  const x = t.toLowerCase();
  if (x === 'omfile' || x === 'file') return 'file';
  if (x === 'omfwd' || x === 'syslog' || x === 'tcp' || x === 'udp') return 'syslog';
  if (x === 'omelasticsearch' || x === 'elasticsearch') return 'elasticsearch';
  if (x === 'omkafka' || x === 'kafka') return 'kafka';
  if (x === 'omhttp' || x === 'http' || x === 'loki' || x === 'splunk_hec_logs') return 'otlphttp';
  if (x === 'datadog_logs' || x === 'datadog') return 'datadog';
  return 'debug'; // visible default, doesn't crash the collector
}

function receiverConfig(otelType: string, inp: { port?: number; type: string; params: Record<string, unknown> }): Record<string, unknown> {
  if (otelType === 'syslog') {
    const protocol = inp.type === 'imtcp' ? 'tcp' : 'udp';
    return {
      tcp: protocol === 'tcp' ? { listen_address: `0.0.0.0:${inp.port ?? 514}` } : undefined,
      udp: protocol === 'udp' ? { listen_address: `0.0.0.0:${inp.port ?? 514}` } : undefined,
      protocol: inp.params['version'] === '1' ? 'rfc5424' : 'rfc3164'
    };
  }
  if (otelType === 'filelog') {
    return { include: filenamesFrom(inp.params) };
  }
  return Object.fromEntries(Object.entries(inp.params).filter(([k]) => k !== 'name' && k !== 'type'));
}

function exporterConfig(otelType: string, out: { params: Record<string, unknown> }): Record<string, unknown> {
  if (otelType === 'syslog') {
    return {
      endpoint: out.params['target'] ?? out.params['address'] ?? 'localhost:514',
      protocol: (out.params['protocol'] as string | undefined) ?? 'tcp',
      port: out.params['port']
    };
  }
  if (otelType === 'file') {
    return {
      path: out.params['path'] ?? out.params['file'] ?? out.params['dynafile'] ?? '/var/log/otel.log'
    };
  }
  if (otelType === 'otlphttp') {
    return { endpoint: out.params['endpoint'] ?? out.params['target'] };
  }
  return stripInternal(out.params);
}

function filenamesFrom(params: Record<string, unknown>): string[] {
  const f = params['file'] ?? params['files'] ?? params['path'];
  if (typeof f === 'string') return [f];
  if (Array.isArray(f)) return f.map(String);
  return ['/var/log/*.log'];
}

function stripInternal(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'name' || k === '_tag') continue;
    out[k] = v;
  }
  return out;
}

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function matchReceiverName(declared: string[]): (ref: string) => string {
  return (ref) => {
    const exact = declared.find((d) => d === ref);
    if (exact) return exact;
    const sane = sanitize(ref);
    const fuzzy = declared.find((d) => d.endsWith(`/${sane}`) || d.startsWith(`${sane}/`));
    return fuzzy ?? `syslog/${sane}`;
  };
}
function matchProcessorName(declared: string[]): (ref: string) => string {
  return (ref) => declared.find((d) => d === ref || d.endsWith(`/${sanitize(ref)}`)) ?? ref;
}
function matchExporterName(declared: string[]): (ref: string) => string {
  return (ref) => {
    const exact = declared.find((d) => d === ref);
    if (exact) return exact;
    const sane = sanitize(ref);
    return declared.find((d) => d.endsWith(`/${sane}`)) ?? `debug/${sane}`;
  };
}
