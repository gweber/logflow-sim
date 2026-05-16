import type { IRModel, IRStatement } from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { EmitLookupData, EmitResult } from '../types.js';
import * as toml from 'smol-toml';

/**
 * Emit a normalized IR as a Vector `.toml` configuration.
 *
 * Vector models the pipeline as a DAG of named components:
 *   [sources.NAME]    type = "..."
 *   [transforms.NAME] type = "remap" inputs = ["..."]
 *   [sinks.NAME]      type = "..." inputs = ["..."]
 *
 * We map:
 *   IRInput  → [sources.NAME] type = "<vector_type>"
 *   IROutput → [sinks.NAME]   type = "<vector_type>" inputs = ["<source>"]
 *   IRModule (load starts with "transform:")
 *            → [transforms.NAME] type = "<type>"
 *   rsyslog rulesets → flattened into per-input sink wiring
 *
 * `inputs = [...]` arrays are the Vector wiring primitive; we connect
 * every sink to every source unless the source IR has more specific
 * routing information.
 */
export function emit(
  model: IRModel,
  opts?: { lookupTables?: Record<string, EmitLookupData> }
): EmitResult {
  const diagnostics: Diagnostic[] = [];
  const lookupData = opts?.lookupTables ?? {};

  const sources: Record<string, Record<string, unknown>> = {};
  const transforms: Record<string, Record<string, unknown>> = {};
  const sinks: Record<string, Record<string, unknown>> = {};

  const sourceNameById = new Map<string, string>();
  for (const inp of model.inputs) {
    const name = sanitize(inp.params['name'] as string) || `${sanitize(inp.type)}_${inp.port ?? sources.length}`;
    sourceNameById.set(inp.id, name);
    sources[name] = {
      type: mapInputType(inp.type),
      ...(inp.port !== undefined ? { address: `0.0.0.0:${inp.port}` } : {}),
      ...stringifyParams(inp.params, ['name', 'type', 'port', '_tag'])
    };
  }

  // Module entries flagged as transforms
  for (const m of model.modules) {
    if (!m.load.startsWith('transform:')) continue;
    const typeName = m.load.replace(/^transform:/, '');
    const name = sanitize((m.params['name'] as string) ?? typeName);
    transforms[name] = {
      type: typeName,
      inputs: Object.keys(sources),
      ...stringifyParams(m.params, ['name', 'type', 'inputs'])
    };
  }

  // Native IROutputs
  for (const out of model.outputs) {
    const name = sanitize(out.name);
    sinks[name] = {
      type: mapSinkType(out.driver),
      inputs:
        Object.keys(transforms).length > 0 ? Object.keys(transforms) : Object.keys(sources),
      ...stringifyParams(out.params, ['name', 'type', 'inputs'])
    };
  }

  // Synthesize sinks from rsyslog actions
  const synthCounter = { n: 0 };
  function visit(stmts: IRStatement[]): void {
    for (const s of stmts) {
      if (s.kind === 'If') {
        visit(s.then);
        if (s.else) visit(s.else);
        continue;
      }
      if (s.kind !== 'Action') continue;
      const key = `${s.actionKind}:${JSON.stringify(s.params)}`;
      if (key in sinks) continue;
      const name = `sink_${s.actionKind}_${synthCounter.n++}`;
      sinks[name] = {
        type: mapSinkType(s.actionType || s.actionKind),
        inputs:
          Object.keys(transforms).length > 0 ? Object.keys(transforms) : Object.keys(sources),
        ...stringifyParams(s.params as Record<string, unknown>, ['type', 'inputs'])
      };
    }
  }
  for (const rs of model.rulesets) visit(rs.statements);

  // Lookup tables → Vector `enrichment_tables`.
  //
  // Vector reads enrichment tables from disk (CSV/MMDB). We emit a CSV
  // sidecar per lookup so the converted config can use `get_enrichment_table_record`
  // in a remap transform. Vector itself doesn't have an inline-map idiom
  // for enrichment that survives reloads, so sidecars are the canonical form.
  const sidecarFiles: { path: string; content: string }[] = [];
  const enrichmentTables: Record<string, Record<string, unknown>> = {};
  for (const lt of model.lookupTables) {
    const data = lookupData[lt.name];
    const entries = data?.entries ?? {};
    const safeName = sanitize(lt.name);
    const sidecarPath = `lookups/${safeName}.csv`;
    if (Object.keys(entries).length === 0) {
      diagnostics.push({
        severity: 'warning',
        message: `Vector emit: lookup "${lt.name}" had no loaded data; emitted an empty CSV stub.`,
        source: { file: '<emit>', line: 0, col: 0, offset: 0, length: 0 },
        code: 'W_VECTOR_LOOKUP_EMPTY'
      });
    }
    sidecarFiles.push({
      path: sidecarPath,
      content:
        'key,value\n' +
        Object.entries(entries)
          .map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`)
          .join('\n') +
        '\n'
    });
    enrichmentTables[safeName] = {
      type: 'file',
      file: { path: sidecarPath, encoding: { type: 'csv' } },
      schema: { key: 'string', value: 'string' }
    };
  }

  const root: Record<string, unknown> = {};
  if (Object.keys(enrichmentTables).length > 0) root.enrichment_tables = enrichmentTables;
  if (Object.keys(sources).length > 0) root.sources = sources;
  if (Object.keys(transforms).length > 0) root.transforms = transforms;
  if (Object.keys(sinks).length > 0) root.sinks = sinks;

  let output: string;
  try {
    output = toml.stringify(root);
  } catch (e) {
    diagnostics.push({
      severity: 'error',
      message: `Failed to serialize TOML: ${(e as Error).message}`,
      source: { file: '<convert>', line: 0, col: 0, offset: 0, length: 0 },
      code: 'E_CONVERT_TOML'
    });
    output = '# Failed to serialize\n';
  }

  const finalOutput = `# Generated by logflow-sim convert\n# Source dialect: ${model.dialect}\n\n${output}`;
  return {
    output: finalOutput,
    files: [{ path: 'vector.toml', content: finalOutput }, ...sidecarFiles],
    diagnostics
  };
}

function csvEscape(s: string): string {
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function mapInputType(t: string): string {
  const m: Record<string, string> = {
    imudp: 'syslog',
    imtcp: 'syslog',
    imptcp: 'syslog',
    udp: 'syslog',
    tcp: 'syslog',
    imfile: 'file',
    imjournal: 'journald',
    syslog: 'syslog'
  };
  return m[t.toLowerCase()] ?? t.toLowerCase();
}

function mapSinkType(d: string): string {
  const m: Record<string, string> = {
    omfile: 'file',
    omfwd: 'socket',
    omkafka: 'kafka',
    omhttp: 'http',
    omelasticsearch: 'elasticsearch',
    file: 'file',
    udp: 'socket',
    tcp: 'socket',
    syslog: 'socket'
  };
  return m[d.toLowerCase()] ?? d.toLowerCase();
}

function stringifyParams(
  params: Record<string, unknown>,
  exclude: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (exclude.includes(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => String(x));
    }
  }
  return out;
}

function sanitize(s: string): string {
  if (!s) return 'unnamed';
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}
