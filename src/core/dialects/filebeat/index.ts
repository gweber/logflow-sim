/**
 * Filebeat (Elastic Beats) dialect.
 *
 * Filebeat ships a single YAML config (`filebeat.yml`) with three top-level
 * shapes that matter for routing analysis:
 *
 *   filebeat.inputs:           # list, each with `type` + collector params
 *     - type: log
 *       paths: [/var/log/*.log]
 *       fields: { sourcetype: linux:secure }
 *     - type: syslog
 *       protocol: udp
 *       host: 0.0.0.0:514
 *
 *   processors:                # list, optional
 *     - add_host_metadata: ~
 *     - drop_event:
 *         when.equals.severity: debug
 *
 *   output.elasticsearch:      # exactly one output block, named by the
 *     hosts: ["es:9200"]       # `output.<type>` key. Filebeat refuses to
 *                              # start if more than one is enabled.
 *
 * IR mapping:
 *   filebeat.inputs[i]         → IRInput (type from the YAML, port for
 *                                syslog/tcp/udp inputs, paths kept in params)
 *   processors[i]              → IRModule  (load = "processor:<key>")
 *   output.<type>              → IROutput (driver = <type>, params nested)
 *
 * We treat the whole config as one implicit route fanning every input
 * through every processor into the (single) output — that matches
 * Filebeat's runtime semantics exactly.
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

interface FilebeatTree {
  inputs: Record<string, unknown>[];
  processors: Record<string, unknown>[];
  outputs: { type: string; config: Record<string, unknown> }[];
  rest: Record<string, unknown>;
}

function parseFilebeatContent(content: string): FilebeatTree | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // `filebeat.inputs` is the canonical key; older configs spell it
  // `filebeat.prospectors` (deprecated). We accept both.
  const inputs =
    extractInputs(obj['filebeat.inputs']) ??
    extractInputs(obj['filebeat.prospectors']) ??
    extractInputs((obj.filebeat as Record<string, unknown> | undefined)?.inputs) ??
    [];

  const procs = Array.isArray(obj.processors)
    ? (obj.processors as Record<string, unknown>[])
    : [];

  // Filebeat's output is keyed `output.<type>` at the YAML root. YAML
  // doesn't have dotted keys natively — typical configs nest the output
  // under an `output:` map. We tolerate both shapes.
  const outputs: { type: string; config: Record<string, unknown> }[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('output.') && v && typeof v === 'object') {
      outputs.push({ type: k.slice('output.'.length), config: v as Record<string, unknown> });
    }
  }
  if (obj.output && typeof obj.output === 'object') {
    for (const [type, conf] of Object.entries(obj.output as Record<string, unknown>)) {
      if (conf && typeof conf === 'object') {
        outputs.push({ type, config: conf as Record<string, unknown> });
      }
    }
  }

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'filebeat.inputs' || k === 'filebeat.prospectors' || k === 'processors') continue;
    if (k.startsWith('output.') || k === 'output') continue;
    rest[k] = v;
  }
  return { inputs, processors: procs, outputs, rest };
}

function extractInputs(v: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

function classifyOutput(type: string): ActionKind {
  const t = type.toLowerCase();
  if (t === 'file' || t === 'console') return 'omfile';
  if (t === 'elasticsearch') return 'omelasticsearch';
  if (t === 'kafka') return 'omkafka';
  if (t === 'logstash' || t === 'redis') return 'omfwd';
  if (t === 'cloud') return 'omhttp';
  return 'unknown';
}

function portFromHost(host: unknown): number | undefined {
  if (typeof host !== 'string') return undefined;
  const tail = host.split(':').pop();
  const n = parseInt(tail ?? '', 10);
  return Number.isNaN(n) ? undefined : n;
}

export const filebeatDialect: Dialect = {
  id: 'filebeat',
  displayName: 'Filebeat (Elastic Beats)',
  fileExtensions: ['.yaml', '.yml'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^filebeat\.inputs:/m.test(c)) score += 0.5;
    if (/^filebeat\.prospectors:/m.test(c)) score += 0.4;
    if (/^output\.elasticsearch:/m.test(c)) score += 0.3;
    if (/^output\.logstash:/m.test(c)) score += 0.25;
    if (/^output\.kafka:/m.test(c)) score += 0.25;
    if (/^processors:/m.test(c) && /filebeat/.test(c)) score += 0.15;
    // Anti-signals: OTel and Vector configs use `receivers:`/`sources:`
    if (/^\s*receivers:\s*$/m.test(c) || /^\s*sources:\s*$/m.test(c)) score -= 0.5;
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
      const tree = parseFilebeatContent(f.content);
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
          code: 'W_FILEBEAT_PARSE'
        });
        continue;
      }

      tree.inputs.forEach((inp, i) => {
        const type = String(inp.type ?? 'log');
        const port = portFromHost(inp.host);
        inputs.push({
          kind: 'Input',
          id: `input:${f.path}:${i}`,
          source: baseLoc,
          type,
          port,
          ruleset: undefined,
          params: { name: `input_${i}`, ...flatten(inp) }
        });
      });

      tree.processors.forEach((p, i) => {
        const procType = Object.keys(p)[0] ?? `processor_${i}`;
        modules.push({
          kind: 'Module',
          id: `processor:${f.path}:${i}`,
          source: baseLoc,
          load: `processor:${procType}`,
          params: { name: procType, ...flatten(p[procType] as Record<string, unknown> ?? {}) }
        });
      });

      for (const out of tree.outputs) {
        outputs.push({
          kind: 'Output',
          id: `output:${f.path}:${out.type}`,
          source: baseLoc,
          name: out.type,
          driver: out.type,
          actionKind: classifyOutput(out.type),
          params: { name: out.type, ...flatten(out.config) }
        });
      }

      // Single implicit route: every input → every processor → THE output.
      // Filebeat refuses to enable >1 output, so the array is at most 1
      // element in practice — but we walk all of them so a multi-output
      // misconfig parses and the validator can flag it.
      for (const out of tree.outputs) {
        routes.push({
          kind: 'Route',
          id: `route:${f.path}:${out.type}`,
          source: baseLoc,
          name: out.type,
          inputRefs: inputs.map((i) => String(i.params['name'] ?? '')),
          filterRefs: [],
          transformRefs: modules.map((m) => String(m.params['name'] ?? '')),
          outputRefs: [out.type],
          flags: []
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
        dialect: 'filebeat'
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
      out[key] = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',');
    } else if (typeof v === 'object') {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    }
  }
  return out;
}
