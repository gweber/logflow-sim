/**
 * Promtail (Grafana Loki shipper) dialect.
 *
 * Promtail YAML is shaped like Prometheus scrape configs:
 *
 *   clients:
 *     - url: http://loki:3100/loki/api/v1/push
 *
 *   scrape_configs:
 *     - job_name: syslog
 *       syslog:
 *         listen_address: 0.0.0.0:1514
 *         labels: { job: syslog }
 *     - job_name: varlog
 *       static_configs:
 *         - targets: [localhost]
 *           labels: { __path__: /var/log/*.log }
 *       pipeline_stages:
 *         - regex:
 *             expression: '...'
 *         - labels:
 *             severity:
 *
 * IR mapping:
 *   each scrape_configs entry → IRInput (type derived from the nested
 *                                key: `syslog`, `static_configs`, `kafka`)
 *   pipeline_stages[*]        → IRModule (load = "stage:<type>")
 *   clients[*]                → IROutput (driver = "loki")
 *   one synthesized route per (job, client) wires them
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

interface PromtailTree {
  clients: Record<string, unknown>[];
  scrapeConfigs: Record<string, unknown>[];
  serverConfig: Record<string, unknown>;
  positionsConfig: Record<string, unknown>;
  rest: Record<string, unknown>;
}

function parsePromtailContent(content: string): PromtailTree | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const clients = Array.isArray(obj.clients) ? (obj.clients as Record<string, unknown>[]) : [];
  const scrapeConfigs = Array.isArray(obj.scrape_configs)
    ? (obj.scrape_configs as Record<string, unknown>[])
    : [];
  const serverConfig =
    obj.server && typeof obj.server === 'object' ? (obj.server as Record<string, unknown>) : {};
  const positionsConfig =
    obj.positions && typeof obj.positions === 'object'
      ? (obj.positions as Record<string, unknown>)
      : {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (['clients', 'scrape_configs', 'server', 'positions'].includes(k)) continue;
    rest[k] = v;
  }
  return { clients, scrapeConfigs, serverConfig, positionsConfig, rest };
}

/** Derive the canonical "input type" from a scrape_config block. */
function deriveInputType(entry: Record<string, unknown>): { type: string; port?: number } {
  if (entry.syslog && typeof entry.syslog === 'object') {
    const sub = entry.syslog as Record<string, unknown>;
    const addr = typeof sub.listen_address === 'string' ? sub.listen_address : '';
    const port = parseInt(addr.split(':').pop() ?? '', 10);
    return { type: 'syslog', port: Number.isNaN(port) ? undefined : port };
  }
  if (entry.static_configs) return { type: 'file' };
  if (entry.journal) return { type: 'journald' };
  if (entry.kafka) return { type: 'kafka' };
  if (entry.gelf) return { type: 'gelf' };
  if (entry.windows_events) return { type: 'windows_events' };
  if (entry.cloudflare) return { type: 'cloudflare' };
  if (entry.kubernetes_sd_configs) return { type: 'kubernetes' };
  return { type: 'unknown' };
}

function classifyClient(_url: string): ActionKind {
  return 'omhttp'; // Loki ingest is HTTP push; treated as the http-shaped sink
}

export const promtailDialect: Dialect = {
  id: 'promtail',
  displayName: 'Promtail (Grafana Loki)',
  fileExtensions: ['.yaml', '.yml'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^scrape_configs:/m.test(c)) score += 0.4;
    if (/^clients:/m.test(c) && /loki/.test(c)) score += 0.4;
    if (/^positions:/m.test(c)) score += 0.2;
    if (/pipeline_stages:/m.test(c)) score += 0.15;
    if (/job_name:/m.test(c)) score += 0.15;
    // Anti-signal: prometheus.yml also has scrape_configs but no clients-with-loki
    if (/^global:\s*$/m.test(c) && /scrape_interval:/m.test(c) && !/clients:/m.test(c)) score -= 0.3;
    if (/^\s*receivers:\s*$/m.test(c) || /^\s*sources:\s*$/m.test(c)) score -= 0.5;
    if (/^filebeat\./m.test(c)) score -= 0.5;
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
      const tree = parsePromtailContent(f.content);
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
          code: 'W_PROMTAIL_PARSE'
        });
        continue;
      }

      // Each scrape_config becomes an input + zero-or-more pipeline-stage
      // modules. The job_name keeps the input identifiable; static_configs
      // get flattened so the loki-side labels are visible in the IR.
      tree.scrapeConfigs.forEach((entry, idx) => {
        const jobName = String(entry.job_name ?? `job_${idx}`);
        const { type, port } = deriveInputType(entry);
        inputs.push({
          kind: 'Input',
          id: `input:${f.path}:${jobName}`,
          source: baseLoc,
          type,
          port,
          ruleset: undefined,
          params: { name: jobName, ...flatten(entry) }
        });

        const stages = Array.isArray(entry.pipeline_stages)
          ? (entry.pipeline_stages as Record<string, unknown>[])
          : [];
        stages.forEach((stage, si) => {
          const stageType = Object.keys(stage)[0] ?? `stage_${si}`;
          modules.push({
            kind: 'Module',
            id: `stage:${f.path}:${jobName}:${si}`,
            source: baseLoc,
            load: `stage:${stageType}`,
            params: {
              name: `${jobName}_${stageType}`,
              job: jobName,
              ...flatten((stage[stageType] as Record<string, unknown>) ?? {})
            }
          });
        });
      });

      tree.clients.forEach((client, idx) => {
        const url = String(client.url ?? '');
        const name = `client_${idx}`;
        outputs.push({
          kind: 'Output',
          id: `output:${f.path}:${idx}`,
          source: baseLoc,
          name,
          driver: 'loki',
          actionKind: classifyClient(url),
          params: { name, url, ...flatten(client) }
        });
      });

      // Routing: Promtail is fundamentally fan-in — every scrape_config
      // feeds every client. We emit one IRRoute per (job, client) so the
      // diff / detection engines can reason per-edge.
      for (const inp of inputs) {
        for (const out of outputs) {
          routes.push({
            kind: 'Route',
            id: `route:${f.path}:${inp.params['name']}:${out.name}`,
            source: baseLoc,
            name: `${String(inp.params['name'])}->${out.name}`,
            inputRefs: [String(inp.params['name'] ?? '')],
            filterRefs: [],
            transformRefs: modules
              .filter((m) => m.params['job'] === inp.params['name'])
              .map((m) => String(m.params['name'] ?? '')),
            outputRefs: [out.name],
            flags: []
          });
        }
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
        dialect: 'promtail'
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
