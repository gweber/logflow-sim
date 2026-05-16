import type { Dialect } from '../types.js';
import type {
  IRModel,
  IRInput,
  IROutput,
  IRRoute,
  IRFilterDef,
  IRTemplate,
  IRLookupTable,
  IRModule,
  IRGlobalSettings,
  ActionKind
} from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import { parse, type Section } from './parser/parser.js';
import { emit } from './emit.js';

/**
 * Fluent Bit dialect.
 *
 * Section types we recognize:
 *   [SERVICE]           → globals
 *   [INPUT]             → IRInput
 *   [FILTER]            → recorded as IRModule (no IRTransform yet)
 *   [OUTPUT]            → IROutput
 *   [PARSER]            → IRModule (parser registry entry)
 *   [MULTILINE_PARSER]  → IRModule
 *   [CUSTOM]            → IRModule
 *
 * Routing in Fluent Bit is tag-based: each INPUT emits records tagged
 * `Tag`, and each FILTER/OUTPUT picks up records matching its `Match`
 * pattern. We synthesize a single IRRoute per INPUT that lists every
 * OUTPUT whose `Match` would consume the input's tag.
 */
function tagMatches(tag: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  // Fluent Bit supports `*` as a wildcard suffix and `Match_Regex`-style
  // explicit patterns. We support the common `prefix.*` and exact match.
  if (pattern.endsWith('.*')) return tag.startsWith(pattern.slice(0, -2) + '.');
  if (pattern.endsWith('*')) return tag.startsWith(pattern.slice(0, -1));
  return tag === pattern;
}

function classifyOutput(name: string): ActionKind {
  const n = name.toLowerCase();
  if (n === 'file' || n === 'stdout' || n === 'null') return 'omfile';
  if (n === 'forward' || n === 'syslog' || n === 'tcp') return 'omfwd';
  if (n === 'es' || n === 'opensearch' || n === 'elasticsearch') return 'omelasticsearch';
  if (n === 'kafka' || n === 'kafka-rest') return 'omkafka';
  if (n === 'http' || n === 'loki' || n === 'splunk' || n === 'datadog') return 'omhttp';
  return 'unknown';
}

export const fluentBitDialect: Dialect = {
  id: 'fluent-bit',
  displayName: 'Fluent Bit',
  fileExtensions: ['.conf'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^\s*\[SERVICE\]/m.test(c)) score += 0.4;
    if (/^\s*\[INPUT\]/m.test(c)) score += 0.3;
    if (/^\s*\[OUTPUT\]/m.test(c)) score += 0.3;
    if (/^\s*Name\s+\w/m.test(c)) score += 0.1;
    if (/^\s*Match\s+/m.test(c)) score += 0.2;
    if (/^\s*Tag\s+/m.test(c)) score += 0.1;
    if (/^\s*@include/m.test(c)) score += 0.1;
    return Math.min(1, score);
  },

  parseFiles(files): { model: IRModel; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const sections: Section[] = [];
    const paths: string[] = [];
    for (const f of files) {
      const r = parse(f);
      diagnostics.push(...r.diagnostics.items);
      for (const s of r.ast.statements) {
        if (s.kind === 'Section') sections.push(s);
      }
      paths.push(f.path);
    }

    const inputs: IRInput[] = [];
    const outputs: IROutput[] = [];
    const modules: IRModule[] = [];
    const globals: IRGlobalSettings = { params: {}, legacy: [] };

    for (const sec of sections) {
      const id = `${sec.name.toLowerCase()}:${sec.source.file}:${sec.source.line}`;
      const params = sec.params as Record<string, string>;
      switch (sec.name) {
        case 'SERVICE':
          for (const [k, v] of Object.entries(params)) globals.params[k] = v;
          break;
        case 'INPUT': {
          const name = params['name'] ?? 'unknown';
          const tag = params['tag'] ?? '*';
          const portStr = params['port'];
          inputs.push({
            kind: 'Input',
            id,
            source: sec.source,
            type: name,
            port: portStr ? parseInt(portStr, 10) || undefined : undefined,
            ruleset: undefined,
            params: { ...params, _tag: tag }
          });
          break;
        }
        case 'OUTPUT': {
          const name = params['name'] ?? 'unknown';
          outputs.push({
            kind: 'Output',
            id,
            source: sec.source,
            name: params['alias'] ?? `${name}-${outputs.length}`,
            driver: name,
            actionKind: classifyOutput(name),
            params
          });
          break;
        }
        case 'FILTER':
        case 'PARSER':
        case 'MULTILINE_PARSER':
        case 'CUSTOM':
          modules.push({
            kind: 'Module',
            id,
            source: sec.source,
            load: `${sec.name.toLowerCase()}:${params['name'] ?? '?'}`,
            params
          });
          break;
        default:
          // Unknown section — surface as module so it's visible.
          modules.push({
            kind: 'Module',
            id,
            source: sec.source,
            load: sec.name.toLowerCase(),
            params
          });
      }
    }

    // Build routes by matching INPUT tags against OUTPUT Match patterns.
    const routes: IRRoute[] = [];
    for (const inp of inputs) {
      const tag = (inp.params['_tag'] as string) ?? '*';
      const outRefs: string[] = [];
      for (const out of outputs) {
        const match = (out.params['match'] as string) ?? '*';
        if (tagMatches(tag, match)) outRefs.push(out.name);
      }
      routes.push({
        kind: 'Route',
        id: `route:${inp.id}`,
        source: inp.source,
        inputRefs: [String(inp.type)],
        filterRefs: [],
        transformRefs: [],
        outputRefs: outRefs,
        flags: []
      });
    }

    const filters: IRFilterDef[] = [];
    const templates: IRTemplate[] = [];
    const lookupTables: IRLookupTable[] = [];

    return {
      model: {
        inputs,
        rulesets: [],
        templates,
        lookupTables,
        modules,
        globals,
        diagnostics,
        rulesetByName: {},
        templateByName: {},
        lookupTableByName: {},
        files: paths,
        outputs,
        outputByName: Object.fromEntries(outputs.map((o) => [o.name, o])),
        filters,
        filterByName: {},
        routes,
        dialect: 'fluent-bit'
      },
      diagnostics
    };
  },
  emit
};
