/**
 * OpenTelemetry Collector dialect.
 *
 * Configs are YAML with the standard four top-level sections plus a
 * `service` block that wires components into named pipelines:
 *
 *   receivers:  NAME → { type-specific config }
 *   processors: NAME → { ... }
 *   exporters:  NAME → { ... }
 *   extensions: NAME → { ... }       # auxiliary services (health-check, pprof…)
 *   service:
 *     extensions: [list of extension names]
 *     pipelines:
 *       traces: { receivers: [...], processors: [...], exporters: [...] }
 *       metrics: { ... }
 *       logs:   { ... }
 *
 * The component names in `service.pipelines.*` are typed by their prefix
 * before the first slash — e.g. `otlp/grpc`, `otlp/http`, `batch/logs`.
 * The prefix is the component type, the suffix is a user-chosen variant.
 *
 * We model receivers as IRInputs, exporters as IROutputs, processors as
 * IRModules, and each named pipeline in `service.pipelines` as an IRRoute.
 * The "logs" pipeline is the one of immediate interest for our routing
 * analysis; we still ingest "traces" and "metrics" so the converter can
 * round-trip a full collector config.
 *
 * Out of scope (deliberately): OTTL transform statements inside processor
 * configs. They are a sub-language and behave like VRL inside Vector — a
 * future sprint can parse them; today we keep the raw text in `params`.
 */

import type { Dialect } from '../types.js';
import type {
  IRModel,
  IRInput,
  IROutput,
  IRRoute,
  IRModule,
  IRGlobalSettings,
  ActionKind
} from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { SourceLoc } from '../../source-map.js';
import * as yaml from 'js-yaml';
import { emit } from './emit.js';

interface OtelTree {
  receivers: Record<string, Record<string, unknown>>;
  processors: Record<string, Record<string, unknown>>;
  exporters: Record<string, Record<string, unknown>>;
  extensions: Record<string, Record<string, unknown>>;
  service: {
    extensions?: string[];
    pipelines: Record<
      string,
      { receivers?: string[]; processors?: string[]; exporters?: string[] }
    >;
    telemetry?: Record<string, unknown>;
  };
  rest: Record<string, unknown>;
}

function parseOtelContent(content: string, filePath: string): OtelTree | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  function asMap(v: unknown): Record<string, Record<string, unknown>> {
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = (val && typeof val === 'object' ? (val as Record<string, unknown>) : {}) ?? {};
    }
    return out;
  }

  const receivers = asMap(obj.receivers);
  const processors = asMap(obj.processors);
  const exporters = asMap(obj.exporters);
  const extensions = asMap(obj.extensions);
  const serviceRaw = (obj.service ?? {}) as Record<string, unknown>;
  const pipelinesRaw = (serviceRaw.pipelines ?? {}) as Record<string, unknown>;
  const pipelines: OtelTree['service']['pipelines'] = {};
  for (const [name, def] of Object.entries(pipelinesRaw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    pipelines[name] = {
      receivers: Array.isArray(d.receivers) ? (d.receivers as string[]) : undefined,
      processors: Array.isArray(d.processors) ? (d.processors as string[]) : undefined,
      exporters: Array.isArray(d.exporters) ? (d.exporters as string[]) : undefined
    };
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!['receivers', 'processors', 'exporters', 'extensions', 'service'].includes(k)) {
      rest[k] = v;
    }
  }

  // Path is only consulted for soft sanity checks; the YAML structure does
  // the real classification. We accept arbitrary file extensions because
  // real-world OTel collector configs are everywhere — /etc/otelcol/config.yaml,
  // helm-chart-templated names, etc.
  void filePath;

  return {
    receivers,
    processors,
    exporters,
    extensions,
    service: {
      extensions: Array.isArray(serviceRaw.extensions)
        ? (serviceRaw.extensions as string[])
        : undefined,
      pipelines,
      telemetry:
        serviceRaw.telemetry && typeof serviceRaw.telemetry === 'object'
          ? (serviceRaw.telemetry as Record<string, unknown>)
          : undefined
    },
    rest
  };
}

/**
 * Map an OTel exporter type to the IR's vendor-neutral action kinds. Aimed
 * at the routing-analysis UX: we only need a rough bucket, not a faithful
 * driver model.
 */
function classifyExporter(type: string): ActionKind {
  const t = type.toLowerCase();
  if (t === 'file' || t === 'debug' || t === 'logging' || t === 'nop') return 'omfile';
  if (t === 'otlp' || t === 'otlphttp' || t === 'syslog') return 'omfwd';
  if (t === 'elasticsearch' || t === 'opensearch') return 'omelasticsearch';
  if (t === 'kafka') return 'omkafka';
  if (
    t === 'loki' ||
    t === 'splunk_hec' ||
    t === 'datadog' ||
    t === 'awscloudwatchlogs' ||
    t === 'awss3'
  )
    return 'omhttp';
  return 'unknown';
}

/** Extract the typed prefix from an OTel component name (`otlp/grpc` → `otlp`). */
function componentType(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(0, slash);
}

/** Best-effort port extraction across the receiver-config shapes OTel uses. */
function extractPort(def: Record<string, unknown>): number | undefined {
  // Common shapes:
  //   endpoint: host:port                              (otlphttp, simple)
  //   protocols: { grpc: { endpoint: ... } }           (otlp)
  //   tcp: { listen_address: host:port } / udp: {...}  (syslog)
  //   listen_address: host:port                        (statsd, etc.)
  const tryEndpoint = (v: unknown): number | undefined => {
    if (typeof v !== 'string') return undefined;
    const p = parseInt(v.split(':').pop() ?? '', 10);
    return Number.isNaN(p) ? undefined : p;
  };
  for (const field of ['endpoint', 'listen_address', 'address']) {
    const p = tryEndpoint(def[field]);
    if (p !== undefined) return p;
  }
  for (const wrapper of ['tcp', 'udp', 'http']) {
    const w = def[wrapper];
    if (w && typeof w === 'object') {
      const inner = w as Record<string, unknown>;
      for (const field of ['endpoint', 'listen_address', 'address']) {
        const p = tryEndpoint(inner[field]);
        if (p !== undefined) return p;
      }
    }
  }
  const protocols = def.protocols as Record<string, unknown> | undefined;
  if (protocols && typeof protocols === 'object') {
    for (const proto of Object.values(protocols)) {
      if (proto && typeof proto === 'object') {
        const ep = (proto as Record<string, unknown>).endpoint;
        const p = tryEndpoint(ep);
        if (p !== undefined) return p;
      }
    }
  }
  return undefined;
}

export const otelDialect: Dialect = {
  id: 'otel',
  displayName: 'OpenTelemetry Collector',
  fileExtensions: ['.yaml', '.yml'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^\s*receivers:\s*$/m.test(c)) score += 0.3;
    if (/^\s*exporters:\s*$/m.test(c)) score += 0.3;
    if (/^\s*processors:\s*$/m.test(c)) score += 0.2;
    if (/^\s*service:\s*$/m.test(c)) score += 0.3;
    if (/^\s+pipelines:/m.test(c)) score += 0.3;
    // Distinguish from Vector YAML: Vector uses `sources:` not `receivers:`.
    if (/^\s*sources:\s*$/m.test(c) || /^\s*sinks:\s*$/m.test(c)) score -= 0.5;
    return Math.max(0, Math.min(1, score));
  },

  parseFiles(files): { model: IRModel; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const inputs: IRInput[] = [];
    const outputs: IROutput[] = [];
    const modules: IRModule[] = [];
    const routes: IRRoute[] = [];
    const globals: IRGlobalSettings = { params: {}, legacy: [] };

    for (const f of files) {
      const tree = parseOtelContent(f.content, f.path);
      const baseLoc: SourceLoc = {
        file: f.path,
        line: 1,
        col: 1,
        offset: 0,
        length: f.content.length
      };
      if (!tree) {
        diagnostics.push({
          severity: 'warning',
          message: `Could not parse ${f.path} as YAML`,
          source: baseLoc,
          code: 'W_OTEL_PARSE'
        });
        continue;
      }

      for (const [name, def] of Object.entries(tree.receivers)) {
        const type = componentType(name);
        inputs.push({
          kind: 'Input',
          id: `input:${f.path}:${name}`,
          source: baseLoc,
          type,
          port: extractPort(def),
          ruleset: undefined,
          params: { name, ...flatten(def) }
        });
      }
      for (const [name, def] of Object.entries(tree.processors)) {
        const type = componentType(name);
        modules.push({
          kind: 'Module',
          id: `processor:${f.path}:${name}`,
          source: baseLoc,
          load: `processor:${type}`,
          params: { name, ...flatten(def) }
        });
      }
      for (const [name, def] of Object.entries(tree.exporters)) {
        const type = componentType(name);
        outputs.push({
          kind: 'Output',
          id: `output:${f.path}:${name}`,
          source: baseLoc,
          name,
          driver: type,
          actionKind: classifyExporter(type),
          params: { name, ...flatten(def) }
        });
      }

      // Each named pipeline becomes one IRRoute. OTel's wiring is explicit
      // — no DAG-walking like Vector — so the route's inputs/transforms/
      // outputs are literally the arrays from the pipeline definition.
      for (const [pipelineName, def] of Object.entries(tree.service.pipelines)) {
        routes.push({
          kind: 'Route',
          id: `route:${f.path}:${pipelineName}`,
          source: baseLoc,
          name: pipelineName,
          inputRefs: def.receivers ?? [],
          filterRefs: [],
          transformRefs: def.processors ?? [],
          outputRefs: def.exporters ?? [],
          flags: pipelineName.startsWith('logs')
            ? ['logs']
            : pipelineName.startsWith('traces')
              ? ['traces']
              : pipelineName.startsWith('metrics')
                ? ['metrics']
                : []
        });
      }

      for (const [k, v] of Object.entries(tree.rest)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          globals.params[k] = String(v);
        }
      }
    }

    return {
      model: {
        inputs,
        rulesets: [],
        templates: [],
        lookupTables: [],
        modules,
        globals,
        diagnostics,
        rulesetByName: {},
        templateByName: {},
        lookupTableByName: {},
        files: files.map((f) => f.path),
        outputs,
        outputByName: Object.fromEntries(outputs.map((o) => [o.name, o])),
        filters: [],
        filterByName: {},
        routes,
        dialect: 'otel'
      },
      diagnostics
    };
  },
  emit
};

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[key] = String(v);
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => String(x)).join(',');
    } else if (typeof v === 'object') {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    }
  }
  return out;
}
