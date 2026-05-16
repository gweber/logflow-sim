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
import * as toml from 'smol-toml';
import { emit } from './emit.js';
import * as yaml from 'js-yaml';

/**
 * Vector (Datadog/vector.dev) dialect.
 *
 * Vector configs are TOML, YAML, or JSON. All three encode the same model:
 *
 *   sources    NAME → { type: "...", ... }
 *   transforms NAME → { type: "...", inputs: ["..."], ... }
 *   sinks      NAME → { type: "...", inputs: ["..."], ... }
 *
 * The `inputs` field on transforms/sinks is what wires components together
 * into the routing DAG. We extract that graph; we do NOT parse the embedded
 * VRL code in `source = '''…'''` remap transforms — VRL is a Turing-complete
 * mini-language that would be a separate effort.
 *
 * Format detection by content + filename heuristic. TOML and YAML have
 * sufficiently different lead-in syntax that we can tell them apart by
 * peeking at the first non-comment line.
 */

interface VectorTree {
  sources: Record<string, Record<string, unknown>>;
  transforms: Record<string, Record<string, unknown>>;
  sinks: Record<string, Record<string, unknown>>;
  rest: Record<string, unknown>;
}

function parseVectorContent(content: string, filePath: string): VectorTree | null {
  // Pick parser by file extension first; fall back to a content heuristic.
  // A `.toml` config can perfectly well START with `[section]`, so we can't
  // just lead with a `{`/`[` JSON sniff — TOML wins by extension.
  const isYamlByExt = /\.ya?ml(\.[\w-]+)?$/i.test(filePath);
  const isTomlByExt = /\.toml(\.[\w-]+)?$/i.test(filePath);
  const isJsonByExt = /\.json(\.[\w-]+)?$/i.test(filePath);
  let parsed: unknown;
  try {
    if (isJsonByExt) {
      parsed = JSON.parse(content);
    } else if (isTomlByExt) {
      parsed = toml.parse(content);
    } else if (isYamlByExt) {
      parsed = yaml.load(content);
    } else {
      // No clear extension hint — TOML uses `[section.subsection]` headers
      // that YAML doesn't, so a leading `[ident.ident]` is a strong tell.
      const looksToml = /^\s*\[[A-Za-z_][\w.-]*(?:\s+[^\]]*)?\]/m.test(content);
      parsed = looksToml ? toml.parse(content) : yaml.load(content);
    }
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const sources =
    typeof obj.sources === 'object' && obj.sources !== null
      ? (obj.sources as Record<string, Record<string, unknown>>)
      : {};
  const transforms =
    typeof obj.transforms === 'object' && obj.transforms !== null
      ? (obj.transforms as Record<string, Record<string, unknown>>)
      : {};
  const sinks =
    typeof obj.sinks === 'object' && obj.sinks !== null
      ? (obj.sinks as Record<string, Record<string, unknown>>)
      : {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'sources' && k !== 'transforms' && k !== 'sinks') rest[k] = v;
  }
  return { sources, transforms, sinks, rest };
}

function classifySink(type: string): ActionKind {
  const t = type.toLowerCase();
  if (t === 'file' || t === 'console' || t === 'blackhole') return 'omfile';
  if (t === 'socket' || t === 'syslog') return 'omfwd';
  if (t === 'elasticsearch' || t === 'opensearch') return 'omelasticsearch';
  if (t === 'kafka') return 'omkafka';
  if (t === 'http' || t === 'loki' || t === 'datadog_logs' || t === 'splunk_hec_logs')
    return 'omhttp';
  return 'unknown';
}

export const vectorDialect: Dialect = {
  id: 'vector',
  displayName: 'Vector (vector.dev)',
  fileExtensions: ['.toml', '.yaml', '.yml'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^\s*\[sources\.\w+\]/m.test(c)) score += 0.4;
    if (/^\s*\[sinks\.\w+\]/m.test(c)) score += 0.4;
    if (/^\s*\[transforms\.\w+\]/m.test(c)) score += 0.3;
    if (/^\s*sources:\s*$/m.test(c) && /^\s*sinks:\s*$/m.test(c)) score += 0.5;
    if (/\binputs\s*=\s*\[/.test(c)) score += 0.2;
    if (/\bparse_syslog!\(/.test(c) || /vrl\.dev/.test(c)) score += 0.2;
    return Math.min(1, score);
  },

  parseFiles(files): { model: IRModel; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const inputs: IRInput[] = [];
    const outputs: IROutput[] = [];
    const modules: IRModule[] = [];
    const routes: IRRoute[] = [];
    const globals: IRGlobalSettings = { params: {}, legacy: [] };

    for (const f of files) {
      const tree = parseVectorContent(f.content, f.path);
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
          message: `Could not parse ${f.path} as TOML or YAML`,
          source: baseLoc,
          code: 'W_VECTOR_PARSE'
        });
        continue;
      }

      for (const [name, def] of Object.entries(tree.sources)) {
        const type = String(def.type ?? 'unknown');
        const port = typeof def.address === 'string'
          ? parseInt(String(def.address).split(':').pop() ?? '', 10) || undefined
          : undefined;
        inputs.push({
          kind: 'Input',
          id: `input:${f.path}:${name}`,
          source: baseLoc,
          type,
          port,
          ruleset: undefined,
          params: { name, ...flatten(def) }
        });
      }
      for (const [name, def] of Object.entries(tree.transforms)) {
        const type = String(def.type ?? 'unknown');
        modules.push({
          kind: 'Module',
          id: `transform:${f.path}:${name}`,
          source: baseLoc,
          load: `transform:${type}`,
          params: { name, ...flatten(def) }
        });
      }
      for (const [name, def] of Object.entries(tree.sinks)) {
        const type = String(def.type ?? 'unknown');
        outputs.push({
          kind: 'Output',
          id: `output:${f.path}:${name}`,
          source: baseLoc,
          name,
          driver: type,
          actionKind: classifySink(type),
          params: { name, ...flatten(def) }
        });
      }
      // Build routes: one IRRoute per sink, walking its `inputs` upstream
      // through transforms back to the original sources.
      for (const [sinkName, sinkDef] of Object.entries(tree.sinks)) {
        const directInputs = Array.isArray(sinkDef.inputs) ? (sinkDef.inputs as string[]) : [];
        const sourceRefs = resolveBackToSources(directInputs, tree);
        const transformRefs = collectTransforms(directInputs, tree);
        routes.push({
          kind: 'Route',
          id: `route:${f.path}:${sinkName}`,
          source: baseLoc,
          name: sinkName,
          inputRefs: sourceRefs,
          filterRefs: [],
          transformRefs,
          outputRefs: [sinkName],
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
        dialect: 'vector'
      },
      diagnostics
    };
  },
  emit
};

/**
 * Walk the inputs DAG backwards from `seeds` through any number of
 * transforms until we reach source-component names. Returns the unique set
 * of source names that feed any of `seeds`.
 */
function resolveBackToSources(seeds: string[], tree: VectorTree): string[] {
  const seen = new Set<string>();
  const sourceNames = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (tree.sources[cur]) {
      sourceNames.add(cur);
      continue;
    }
    const t = tree.transforms[cur];
    if (t && Array.isArray(t.inputs)) {
      for (const upstream of t.inputs as string[]) queue.push(upstream);
    }
  }
  return [...sourceNames];
}

function collectTransforms(seeds: string[], tree: VectorTree): string[] {
  const seen = new Set<string>();
  const transformNames = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (tree.transforms[cur]) {
      transformNames.add(cur);
      const t = tree.transforms[cur];
      if (Array.isArray(t.inputs)) for (const u of t.inputs as string[]) queue.push(u);
    }
  }
  return [...transformNames];
}

/**
 * Flatten a nested object into a single-level `key.subkey → string` map so
 * it fits the IRValue shape (no nested objects). Lists are joined with `,`.
 */
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
