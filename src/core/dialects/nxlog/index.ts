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
 * NXLog dialect.
 *
 * NXLog's configuration is XML-tag-like (but not actually XML — no
 * attributes, no nested elements with content):
 *
 *   LogFile %LOGDIR%\nxlog.log               (top-level directive)
 *   define VAR value                         (macro)
 *   include path/*.conf                      (include)
 *   <Extension name>                         (block start)
 *       Module xm_syslog                     (key-value inside)
 *   </Extension>                             (block end)
 *
 * Block types: <Extension>, <Input>, <Output>, <Route>, <Processor>, <Match>.
 *
 * Routes connect blocks via a `Path` directive: `Path in => filter => out`.
 *
 * We parse line-by-line for simplicity — NXLog has no multi-line statements
 * that span blocks.
 */

interface Block {
  type: string;
  name: string;
  params: Record<string, string>;
  source: SourceLoc;
}

function parseNxlog(file: { path: string; content: string }): {
  blocks: Block[];
  topLevel: Record<string, string>;
  includes: string[];
  diagnostics: Diagnostic[];
} {
  const diags = new DiagnosticBag();
  const lines = file.content.split(/\r?\n/);
  const blocks: Block[] = [];
  const topLevel: Record<string, string> = {};
  const includes: string[] = [];
  let cur: Block | null = null;

  // Track line offsets for accurate source locations.
  const lineOffsets: number[] = [];
  {
    let o = 0;
    for (const ln of lines) {
      lineOffsets.push(o);
      o += ln.length + 1;
    }
  }
  function loc(lineIdx: number, length = 0): SourceLoc {
    return {
      file: file.path,
      line: lineIdx + 1,
      col: 1,
      offset: lineOffsets[lineIdx],
      length
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/^﻿/, '').replace(/^\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;

    const startMatch = /^<\s*(\w+)(?:\s+(\S+))?\s*>$/.exec(trimmed);
    if (startMatch) {
      if (cur) {
        diags.warning(
          `Nested NXLog block "<${startMatch[1]}>" inside "<${cur.type}>" — flattening`,
          loc(i, raw.length),
          'W_NX_NESTED_BLOCK'
        );
      }
      cur = {
        type: startMatch[1],
        name: startMatch[2] ?? '',
        params: {},
        source: loc(i, raw.length)
      };
      blocks.push(cur);
      continue;
    }
    const endMatch = /^<\/\s*(\w+)\s*>$/.exec(trimmed);
    if (endMatch) {
      cur = null;
      continue;
    }

    if (/^include\s+/i.test(trimmed)) {
      includes.push(trimmed.replace(/^include\s+/i, '').trim());
      continue;
    }
    if (/^define\s+/i.test(trimmed)) {
      const m = /^define\s+(\S+)\s+(.+)$/i.exec(trimmed);
      if (m) topLevel[`define_${m[1]}`] = m[2];
      continue;
    }

    // Generic `Key value` — NXLog uses whitespace as separator.
    const kv = /^(\w+(?:\.\w+)*)\s+(.+?)\s*$/.exec(trimmed);
    if (kv) {
      const target = cur ? cur.params : topLevel;
      const key = kv[1].toLowerCase();
      // Multi-line `Exec` directives end with `;` — concatenate continuations.
      if (target[key]) target[key] += ' ' + kv[2];
      else target[key] = kv[2];
      continue;
    }

    diags.warning(
      `Unrecognized NXLog line preserved: "${trimmed.slice(0, 60)}"`,
      loc(i, raw.length),
      'W_UNKNOWN_STATEMENT'
    );
  }

  return { blocks, topLevel, includes, diagnostics: diags.items };
}

function classifyOutputModule(mod: string): ActionKind {
  const m = mod.toLowerCase();
  if (m === 'om_file' || m === 'om_null') return 'omfile';
  if (m === 'om_tcp' || m === 'om_udp' || m === 'om_ssl') return 'omfwd';
  if (m === 'om_elasticsearch') return 'omelasticsearch';
  if (m === 'om_kafka') return 'omkafka';
  if (m === 'om_http' || m === 'om_webhdfs') return 'omhttp';
  return 'unknown';
}

export const nxlogDialect: Dialect = {
  id: 'nxlog',
  displayName: 'NXLog',
  fileExtensions: ['.conf'],

  detect(sample): number {
    const c = sample.content;
    let score = 0;
    if (/<Input\b/i.test(c)) score += 0.4;
    if (/<Output\b/i.test(c)) score += 0.3;
    if (/<Route\b/i.test(c)) score += 0.3;
    if (/Module\s+(im_|om_|xm_|pm_)/i.test(c)) score += 0.4;
    if (/^Moduledir\b/im.test(c)) score += 0.2;
    return Math.min(1, score);
  },

  parseFiles(files): { model: IRModel; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const inputs: IRInput[] = [];
    const outputs: IROutput[] = [];
    const modules: IRModule[] = [];
    const globals: IRGlobalSettings = { params: {}, legacy: [] };
    const routes: IRRoute[] = [];

    for (const f of files) {
      const { blocks, topLevel, includes, diagnostics: ds } = parseNxlog(f);
      diagnostics.push(...ds);
      for (const [k, v] of Object.entries(topLevel)) globals.params[k] = v;
      for (const inc of includes) {
        globals.legacy.push({ name: 'include', value: inc, source: blocks[0]?.source ?? {
          file: f.path, line: 1, col: 1, offset: 0, length: 0
        } });
      }
      for (const b of blocks) {
        const id = `${b.type.toLowerCase()}:${b.source.file}:${b.source.line}`;
        const mod = b.params['module'] ?? '';
        switch (b.type.toLowerCase()) {
          case 'input':
            inputs.push({
              kind: 'Input',
              id,
              source: b.source,
              type: mod || 'unknown',
              port: b.params['port'] ? parseInt(b.params['port'], 10) || undefined : undefined,
              ruleset: undefined,
              params: b.params
            });
            break;
          case 'output':
            outputs.push({
              kind: 'Output',
              id,
              source: b.source,
              name: b.name || `out-${outputs.length}`,
              driver: mod || b.type,
              actionKind: classifyOutputModule(mod),
              params: b.params
            });
            break;
          case 'route': {
            const pathStr = b.params['path'] ?? '';
            const stages = pathStr.split(/=>/).map((s) => s.trim()).filter(Boolean);
            const inputRefs = stages.length > 0 ? stages[0].split(',').map((s) => s.trim()) : [];
            const outputRefs =
              stages.length > 1
                ? stages[stages.length - 1].split(',').map((s) => s.trim())
                : [];
            const transformRefs =
              stages.length > 2 ? stages.slice(1, -1).flatMap((s) => s.split(',').map((p) => p.trim())) : [];
            routes.push({
              kind: 'Route',
              id,
              source: b.source,
              name: b.name,
              inputRefs,
              filterRefs: [],
              transformRefs,
              outputRefs,
              flags: []
            });
            break;
          }
          default:
            modules.push({
              kind: 'Module',
              id,
              source: b.source,
              load: `${b.type.toLowerCase()}:${b.name || mod || '?'}`,
              params: b.params
            });
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
        dialect: 'nxlog'
      },
      diagnostics
    };
  },
  emit
};
