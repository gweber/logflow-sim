/**
 * Fluentd-classic dialect (td-agent.conf shape).
 *
 * Fluentd has its own block-tagged DSL that predates the modern
 * configuration-as-YAML wave:
 *
 *   <source>
 *     @type forward
 *     port 24224
 *   </source>
 *
 *   <filter app.**>
 *     @type record_transformer
 *     <record>
 *       hostname "#{Socket.gethostname}"
 *     </record>
 *   </filter>
 *
 *   <match app.**>
 *     @type kafka2
 *     brokers kafka:9092
 *     topic logs
 *   </match>
 *
 * Block-tag grammar:
 *   <name [attr]>              opens block
 *     key value                key-value (single line)
 *     <nested>...</nested>     recursive subblock
 *   </name>
 *
 * IR mapping:
 *   <source>   → IRInput  (type = @type value)
 *   <filter>   → IRModule (load = "filter:<@type>", with `pattern` from attr)
 *   <match>    → IROutput (driver = @type, pattern = match attr)
 *   one route per match block, fanning every matching source through every
 *   filter into the match's output
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
import { emit } from './emit.js';

interface Block {
  tag: string;
  attr?: string;
  body: Record<string, string>;
  children: Block[];
  /** Line where the opening tag started, 1-based. */
  startLine: number;
}

/**
 * Tiny recursive-descent tokenizer for the block grammar. Comments
 * (`#`-to-EOL) and blank lines are skipped. Quoted values are stripped
 * of surrounding quotes — `key "value with spaces"` becomes
 * `{ key: 'value with spaces' }`.
 */
function tokenizeBlocks(content: string): { blocks: Block[]; diagnostics: string[] } {
  const lines = content.split(/\r?\n/);
  const diagnostics: string[] = [];

  function parseBlocks(start: number, end: number, indentDepth = 0): { children: Block[]; nextLine: number } {
    const children: Block[] = [];
    let i = start;
    while (i < end) {
      const raw = lines[i];
      const line = raw.replace(/\s*#.*$/, '').trim();
      if (!line) {
        i++;
        continue;
      }
      const open = /^<([A-Za-z_][\w.-]*)(?:\s+(.+))?>$/.exec(line);
      if (open) {
        const tag = open[1];
        const attr = open[2]?.trim();
        // Walk forward to the matching </tag>. We track depth so nested
        // same-tag blocks (`<record>` inside `<filter>...</filter>`)
        // don't terminate the outer block too early.
        let depth = 1;
        let j = i + 1;
        while (j < end && depth > 0) {
          const inner = lines[j].replace(/\s*#.*$/, '').trim();
          if (new RegExp(`^<${tag}(\\s|>)`).test(inner)) depth++;
          else if (inner === `</${tag}>`) depth--;
          if (depth === 0) break;
          j++;
        }
        if (depth !== 0) {
          diagnostics.push(`unterminated <${tag}> block at line ${i + 1}`);
          break;
        }
        const sub = parseBlocks(i + 1, j, indentDepth + 1);
        const body: Record<string, string> = {};
        let k = i + 1;
        // Capture top-level key/value pairs that aren't nested blocks.
        while (k < j) {
          const inner = lines[k].replace(/\s*#.*$/, '').trim();
          if (!inner) {
            k++;
            continue;
          }
          if (/^<[A-Za-z_]/.test(inner)) {
            // Skip the nested block — recursion handled it.
            const inTag = /^<([A-Za-z_][\w.-]*)/.exec(inner)?.[1];
            if (inTag) {
              let d = 1;
              let m = k + 1;
              while (m < j && d > 0) {
                const inn = lines[m].replace(/\s*#.*$/, '').trim();
                if (new RegExp(`^<${inTag}(\\s|>)`).test(inn)) d++;
                else if (inn === `</${inTag}>`) d--;
                if (d === 0) break;
                m++;
              }
              k = m + 1;
              continue;
            }
          }
          const kv = /^(@?[A-Za-z_][\w-]*)\s+(.+)$/.exec(inner);
          if (kv) {
            const key = kv[1];
            let value = kv[2].trim();
            // Strip wrapping quotes (single or double); Fluentd lets you
            // mix both. We don't try to parse Ruby expressions like
            // `"#{Socket.gethostname}"` — they stay verbatim.
            if (
              (value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))
            ) {
              value = value.slice(1, -1);
            }
            body[key] = value;
          }
          k++;
        }
        children.push({ tag, attr, body, children: sub.children, startLine: i + 1 });
        i = j + 1;
      } else {
        // Top-level key/value (rare but legal).
        i++;
      }
    }
    return { children, nextLine: i };
  }

  const { children } = parseBlocks(0, lines.length);
  return { blocks: children, diagnostics };
}

function classifyMatch(type: string): ActionKind {
  const t = type.toLowerCase();
  if (t === 'file' || t === 'stdout' || t === 'null') return 'omfile';
  if (t === 'forward' || t === 'syslog' || t === 'tcp' || t === 'udp') return 'omfwd';
  if (t === 'elasticsearch' || t === 'opensearch') return 'omelasticsearch';
  if (t === 'kafka' || t === 'kafka2') return 'omkafka';
  if (t === 'http' || t === 'webhdfs' || t === 's3') return 'omhttp';
  return 'unknown';
}

function portFromAttrs(body: Record<string, string>): number | undefined {
  const v = body['port'] ?? body['listen_port'];
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

export const fluentdDialect: Dialect = {
  id: 'fluentd',
  displayName: 'Fluentd (td-agent)',
  fileExtensions: ['.conf'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^\s*<source>/m.test(c)) score += 0.4;
    if (/^\s*<match\s/m.test(c)) score += 0.4;
    if (/^\s*<filter/m.test(c)) score += 0.2;
    if (/^\s*@type\s+\w+/m.test(c)) score += 0.3;
    if (/^\s*@include\s+/m.test(c)) score += 0.1;
    // Anti-signal: rsyslog also uses `*.* /var/log/foo` lines, and its
    // module(load=...) syntax is distinctive.
    if (/^module\(load=/m.test(c)) score -= 0.4;
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
      const { blocks, diagnostics: tokenDiags } = tokenizeBlocks(f.content);
      for (const td of tokenDiags) {
        diagnostics.push({
          severity: 'warning',
          message: td,
          source: { file: f.path, line: 1, col: 1, offset: 0, length: f.content.length },
          code: 'W_FLUENTD_PARSE'
        });
      }

      const localSources: { name: string; type: string }[] = [];
      const localFilters: { name: string; pattern: string }[] = [];

      for (const b of blocks) {
        const loc: SourceLoc = {
          file: f.path,
          line: b.startLine,
          col: 1,
          offset: 0,
          length: 0
        };
        const type = b.body['@type'] ?? 'unknown';
        if (b.tag === 'source') {
          const name = String(b.body['tag'] ?? `source_${inputs.length}`);
          inputs.push({
            kind: 'Input',
            id: `input:${f.path}:${b.startLine}`,
            source: loc,
            type,
            port: portFromAttrs(b.body),
            ruleset: undefined,
            params: { name, ...b.body }
          });
          localSources.push({ name, type });
        } else if (b.tag === 'filter') {
          const pattern = b.attr ?? '**';
          const name = `filter_${type}_${b.startLine}`;
          modules.push({
            kind: 'Module',
            id: `filter:${f.path}:${b.startLine}`,
            source: loc,
            load: `filter:${type}`,
            params: { name, pattern, ...b.body }
          });
          localFilters.push({ name, pattern });
        } else if (b.tag === 'match') {
          const pattern = b.attr ?? '**';
          const name = `match_${type}_${b.startLine}`;
          outputs.push({
            kind: 'Output',
            id: `output:${f.path}:${b.startLine}`,
            source: loc,
            name,
            driver: type,
            actionKind: classifyMatch(type),
            params: { name, pattern, ...b.body }
          });

          // Wire a route: every source whose tag matches `pattern`
          // (literal-equality first; glob `**` fan-out as last resort)
          // → every filter whose pattern also matches → this match.
          const matchingSources = localSources
            .filter((s) => tagsMatch(s.name, pattern))
            .map((s) => s.name);
          const matchingFilters = localFilters
            .filter((flt) => patternsOverlap(flt.pattern, pattern))
            .map((flt) => flt.name);
          routes.push({
            kind: 'Route',
            id: `route:${f.path}:${b.startLine}`,
            source: loc,
            name,
            inputRefs: matchingSources.length > 0 ? matchingSources : localSources.map((s) => s.name),
            filterRefs: [],
            transformRefs: matchingFilters,
            outputRefs: [name],
            flags: []
          });
        } else if (b.tag === 'system' || b.tag === 'label') {
          // Globals / label scopes — keep raw for now.
          for (const [k, v] of Object.entries(b.body)) globals.params[`${b.tag}.${k}`] = v;
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
        dialect: 'fluentd'
      },
      diagnostics
    };
  },
  emit
};

/** Cheap glob match: `app.**` matches `app.error`, `**` matches everything. */
function tagsMatch(tag: string, pattern: string): boolean {
  if (pattern === '**' || pattern === '*') return true;
  if (pattern === tag) return true;
  if (pattern.endsWith('.**')) {
    const prefix = pattern.slice(0, -3);
    return tag === prefix || tag.startsWith(prefix + '.');
  }
  return false;
}

function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '**' || b === '**') return true;
  // If either is a prefix of the other (with `.**`), they overlap.
  if (a.endsWith('.**') && b.startsWith(a.slice(0, -3))) return true;
  if (b.endsWith('.**') && a.startsWith(b.slice(0, -3))) return true;
  return false;
}
