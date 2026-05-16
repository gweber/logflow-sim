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
import { DiagnosticBag } from '../../diagnostics.js';
import { emit } from './emit.js';

/**
 * Logstash dialect.
 *
 * Logstash configs follow a fixed three-section structure:
 *
 *   input  { <plugin> { key => value … } … }
 *   filter { <plugin> { key => value … } … }   (optional)
 *   output { <plugin> { key => value … } … }
 *
 * - Plugin names: `file`, `beats`, `tcp`, `udp`, `syslog`, `kafka`, `elasticsearch`, …
 * - Values: strings ("..." or '...'), numbers, arrays [...], hashes { k => v }
 * - Field references: `[field]`, `[a][b]`
 * - String interpolation: `"%{field}"`
 * - Env interpolation: `${VAR:default}`
 * - Conditionals: `if [field] == "x" { … } else { … }` (inside filter/output)
 *
 * Our parser deliberately keeps the conditional logic OPAQUE — we extract
 * the plugins and their `=>`-parameters but don't model branches yet. The
 * normalized IR still gets a route per (input plugin)→(output plugin) pair
 * so the analyzer/flow visualization works.
 */

interface Plugin {
  name: string;
  params: Record<string, string>;
  source: SourceLoc;
}

interface ParsedConfig {
  inputs: Plugin[];
  filters: Plugin[];
  outputs: Plugin[];
  diagnostics: Diagnostic[];
}

function parseLogstash(file: { path: string; content: string }): ParsedConfig {
  const diags = new DiagnosticBag();
  const inputs: Plugin[] = [];
  const filters: Plugin[] = [];
  const outputs: Plugin[] = [];

  const content = file.content;
  let i = 0;

  function loc(offset: number, length: number): SourceLoc {
    let line = 1;
    let col = 1;
    for (let k = 0; k < offset && k < content.length; k++) {
      if (content.charCodeAt(k) === 0x0a) {
        line++;
        col = 1;
      } else col++;
    }
    return { file: file.path, line, col, offset, length };
  }

  // Skip whitespace + line comments.
  function skipWs(): void {
    while (i < content.length) {
      const c = content.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        i++;
        continue;
      }
      if (c === 0x23 /* # */) {
        while (i < content.length && content.charCodeAt(i) !== 0x0a) i++;
        continue;
      }
      return;
    }
  }

  // Walk a balanced `{ … }` block from the opening `{` to its match,
  // honoring strings and nested braces.
  function findBalancedClose(start: number): number {
    let depth = 1;
    let k = start + 1;
    while (k < content.length && depth > 0) {
      const c = content[k];
      if (c === '"' || c === "'") {
        k = skipString(k);
        continue;
      }
      if (c === '#') {
        while (k < content.length && content[k] !== '\n') k++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      k++;
    }
    return k;
  }
  function skipString(start: number): number {
    const quote = content[start];
    let k = start + 1;
    while (k < content.length) {
      if (content[k] === '\\' && k + 1 < content.length) {
        k += 2;
        continue;
      }
      if (content[k] === quote) return k + 1;
      k++;
    }
    return k;
  }

  // Match an identifier (plugin name) at i.
  function readIdent(): string | null {
    const start = i;
    while (i < content.length) {
      const c = content[i];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '-' ||
          (i > start && c >= '0' && c <= '9')) {
        i++;
      } else break;
    }
    return i > start ? content.slice(start, i) : null;
  }

  function readKVBody(end: number): Record<string, string> {
    // Inside `{ … }` for a plugin: a sequence of `key => value` pairs
    // separated by whitespace. We capture each pair as a string.
    const params: Record<string, string> = {};
    let j = i;
    while (j < end) {
      // skip ws/comments
      while (j < end) {
        const c = content.charCodeAt(j);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
          j++;
          continue;
        }
        if (c === 0x23) {
          while (j < end && content.charCodeAt(j) !== 0x0a) j++;
          continue;
        }
        break;
      }
      if (j >= end) break;

      // `if (...) { ... }` — skip the conditional and its body.
      if (
        (content[j] === 'i' &&
          content[j + 1] === 'f' &&
          /\s|\(/.test(content[j + 2] ?? '')) ||
        /\b(else)\b/.test(content.slice(j, j + 5))
      ) {
        while (j < end && content[j] !== '{') j++;
        if (j < end) j = findBalancedClose(j);
        continue;
      }

      // key
      const keyStart = j;
      while (j < end) {
        const c = content[j];
        if (
          (c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') ||
          c === '_' ||
          c === '-' ||
          c === '[' ||
          c === ']' ||
          (j > keyStart && c >= '0' && c <= '9')
        ) {
          j++;
        } else break;
      }
      if (j === keyStart) {
        j++;
        continue;
      }
      const key = content.slice(keyStart, j).toLowerCase().replace(/[\[\]]/g, '');
      // skip ws + arrow
      while (j < end && /\s/.test(content[j] ?? '')) j++;
      if (content[j] !== '=' || content[j + 1] !== '>') {
        // Not a kv — must be a nested plugin block like `if {}`; skip.
        while (j < end && content[j] !== '{' && content[j] !== '\n') j++;
        if (content[j] === '{') j = findBalancedClose(j);
        continue;
      }
      j += 2;
      while (j < end && /\s/.test(content[j] ?? '')) j++;
      // value: string, number, [...], {...}, bare ident
      let value = '';
      if (content[j] === '"' || content[j] === "'") {
        const close = skipString(j);
        value = content.slice(j + 1, close - 1);
        j = close;
      } else if (content[j] === '[') {
        let depth = 1;
        const vs = j;
        j++;
        while (j < end && depth > 0) {
          if (content[j] === '"' || content[j] === "'") {
            j = skipString(j);
            continue;
          }
          if (content[j] === '[') depth++;
          else if (content[j] === ']') depth--;
          j++;
        }
        value = content.slice(vs, j);
      } else if (content[j] === '{') {
        const close = findBalancedClose(j);
        value = content.slice(j, close);
        j = close;
      } else {
        const vs = j;
        while (
          j < end &&
          !/[\s,#]/.test(content[j] ?? '')
        ) j++;
        value = content.slice(vs, j);
      }
      params[key] = value;
    }
    i = end;
    return params;
  }

  function parseSection(section: 'input' | 'filter' | 'output'): void {
    // `i` points at '{' of the section. Walk content, finding plugin blocks.
    if (content[i] !== '{') return;
    const sectionEnd = findBalancedClose(i);
    i++;
    while (i < sectionEnd - 1) {
      skipWs();
      if (i >= sectionEnd - 1) break;
      // Skip an `if (...) { ... }` conditional in filter/output sections.
      if (
        section !== 'input' &&
        /^(if|else)\b/.test(content.slice(i, i + 5))
      ) {
        while (i < sectionEnd && content[i] !== '{') i++;
        if (content[i] === '{') i = findBalancedClose(i);
        continue;
      }
      const nameStart = i;
      const name = readIdent();
      if (!name) {
        i++;
        continue;
      }
      skipWs();
      if (content[i] !== '{') {
        // Not a plugin block — back up and skip one char to continue.
        i = nameStart + 1;
        continue;
      }
      const close = findBalancedClose(i);
      const plugin: Plugin = {
        name,
        params: {},
        source: loc(nameStart, name.length)
      };
      i++;
      plugin.params = readKVBody(close - 1);
      i = close;
      const target =
        section === 'input' ? inputs : section === 'filter' ? filters : outputs;
      target.push(plugin);
    }
    i = sectionEnd;
  }

  while (i < content.length) {
    skipWs();
    if (i >= content.length) break;
    const tagStart = i;
    const tag = readIdent();
    if (!tag) {
      i++;
      continue;
    }
    skipWs();
    if (content[i] !== '{') {
      // Not a section header — preserve as an unknown top-level token.
      diags.warning(
        `Unexpected top-level token "${tag}"`,
        loc(tagStart, tag.length),
        'W_UNKNOWN_STATEMENT'
      );
      continue;
    }
    if (tag === 'input' || tag === 'filter' || tag === 'output') {
      parseSection(tag);
    } else {
      // Unknown top-level block — skip its body.
      const close = findBalancedClose(i);
      i = close;
      diags.info(
        `Unrecognized top-level block "${tag}" — skipped`,
        loc(tagStart, tag.length),
        'I_LOGSTASH_UNKNOWN_BLOCK'
      );
    }
  }

  return { inputs, filters, outputs, diagnostics: diags.items };
}

function classifyOutput(name: string): ActionKind {
  const n = name.toLowerCase();
  if (n === 'file' || n === 'stdout') return 'omfile';
  if (n === 'tcp' || n === 'udp' || n === 'syslog') return 'omfwd';
  if (n === 'elasticsearch' || n === 'opensearch') return 'omelasticsearch';
  if (n === 'kafka') return 'omkafka';
  if (n === 'http' || n === 'webhdfs') return 'omhttp';
  return 'unknown';
}

export const logstashDialect: Dialect = {
  id: 'logstash',
  displayName: 'Logstash',
  fileExtensions: ['.conf'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/^\s*input\s*\{/m.test(c)) score += 0.4;
    if (/^\s*filter\s*\{/m.test(c)) score += 0.3;
    if (/^\s*output\s*\{/m.test(c)) score += 0.4;
    if (/=>\s*/.test(c)) score += 0.2;
    if (/^\s*(grok|mutate|date|kv|json)\s*\{/m.test(c)) score += 0.1;
    return Math.min(1, score);
  },

  parseFiles(files): { model: IRModel; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const inputs: IRInput[] = [];
    const outputs: IROutput[] = [];
    const modules: IRModule[] = [];
    const globals: IRGlobalSettings = { params: {}, legacy: [] };

    for (const f of files) {
      const parsed = parseLogstash(f);
      diagnostics.push(...parsed.diagnostics);
      for (const p of parsed.inputs) {
        const portStr = p.params['port'];
        inputs.push({
          kind: 'Input',
          id: `input:${p.source.file}:${p.source.line}`,
          source: p.source,
          type: p.name,
          port: portStr ? parseInt(portStr, 10) || undefined : undefined,
          ruleset: undefined,
          params: p.params
        });
      }
      for (const p of parsed.filters) {
        modules.push({
          kind: 'Module',
          id: `filter:${p.source.file}:${p.source.line}`,
          source: p.source,
          load: `filter:${p.name}`,
          params: p.params
        });
      }
      for (const p of parsed.outputs) {
        outputs.push({
          kind: 'Output',
          id: `output:${p.source.file}:${p.source.line}`,
          source: p.source,
          name: `${p.name}-${outputs.length}`,
          driver: p.name,
          actionKind: classifyOutput(p.name),
          params: p.params
        });
      }
    }

    // Logstash has a single implicit pipeline: every input feeds every
    // filter then every output. We synthesize one route per input listing
    // all outputs.
    const routes: IRRoute[] = inputs.map((inp) => ({
      kind: 'Route' as const,
      id: `route:${inp.id}`,
      source: inp.source,
      inputRefs: [inp.type],
      filterRefs: [],
      transformRefs: modules.map((m) => m.load),
      outputRefs: outputs.map((o) => o.name),
      flags: []
    }));

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
        dialect: 'logstash'
      },
      diagnostics
    };
  },
  emit
};
