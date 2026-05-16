import type { SourceLoc } from '../../../source-map.js';
import { offsetToLineCol } from '../../../source-map.js';
import { DiagnosticBag } from '../../../diagnostics.js';

/**
 * Fluent Bit configuration parser.
 *
 * The classic .conf format is a sectioned INI variant:
 *
 *   [SERVICE]
 *       flush        1
 *       daemon       off
 *
 *   [INPUT]
 *       Name         tail
 *       Path         /var/log/*.log
 *       Tag          myapp.*
 *
 *   [OUTPUT]
 *       Name         es
 *       Match        myapp.*
 *       Host         elastic.example
 *
 *   @include extra.conf
 *
 * Section names are uppercased by convention (SERVICE, INPUT, FILTER,
 * OUTPUT, PARSER, MULTILINE_PARSER, STREAM_TASK, CUSTOM). Keys are
 * case-insensitive, values are whitespace-trimmed and untyped (treated as
 * strings — the runtime coerces).
 *
 * We deliberately keep the AST minimal: a flat list of sections, each with
 * a key→value map (later keys override earlier ones, matching Fluent Bit's
 * own behavior).
 */
export interface Section {
  kind: 'Section';
  name: string;
  /** Lowercased key → string value, last-write-wins for duplicates. */
  params: Record<string, string>;
  source: SourceLoc;
}

export interface IncludeDirective {
  kind: 'Include';
  spec: string;
  source: SourceLoc;
}

export type TopStmt = Section | IncludeDirective;

export interface ConfigFile {
  kind: 'ConfigFile';
  path: string;
  statements: TopStmt[];
  source: SourceLoc;
}

export interface ParseResult {
  ast: ConfigFile;
  diagnostics: DiagnosticBag;
}

export function parse(file: { path: string; content: string }): ParseResult {
  const diags = new DiagnosticBag();
  const statements: TopStmt[] = [];
  const lines = file.content.split(/\r?\n/);
  let i = 0;
  let offset = 0;

  // Track cumulative offsets so source locations are accurate.
  const lineOffsets: number[] = [];
  {
    let o = 0;
    for (const ln of lines) {
      lineOffsets.push(o);
      o += ln.length + 1;
    }
  }
  void offset;

  function locOf(lineNum: number, col = 1, length = 0): SourceLoc {
    return {
      file: file.path,
      line: lineNum + 1,
      col,
      offset: lineOffsets[lineNum] + (col - 1),
      length
    };
  }

  let cur: Section | null = null;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.replace(/^﻿/, '').trimStart();

    // Blank / comment
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      i++;
      continue;
    }

    // @include directive
    if (trimmed.startsWith('@')) {
      const m = /^@(\w+)(?:\s+(.*))?$/.exec(trimmed);
      if (m) {
        if (m[1].toLowerCase() === 'include' && m[2]) {
          statements.push({
            kind: 'Include',
            spec: m[2].trim().replace(/^"(.*)"$/, '$1'),
            source: locOf(i)
          });
        } else {
          diags.info(
            `Unrecognized @${m[1]} directive (skipped)`,
            locOf(i),
            'I_FB_UNKNOWN_PRAGMA'
          );
        }
      }
      i++;
      continue;
    }

    // Section header [NAME]
    const secMatch = /^\[\s*([A-Za-z0-9_]+)\s*\]/.exec(trimmed);
    if (secMatch) {
      cur = {
        kind: 'Section',
        name: secMatch[1].toUpperCase(),
        params: {},
        source: locOf(i)
      };
      statements.push(cur);
      i++;
      continue;
    }

    // key value pair
    const kv = /^([A-Za-z][\w.-]*)\s+(.*?)\s*(?:#.*)?$/.exec(trimmed);
    if (kv) {
      if (!cur) {
        diags.warning(
          `Key/value outside any section: "${trimmed.slice(0, 60)}"`,
          locOf(i),
          'W_FB_ORPHAN_KV'
        );
        i++;
        continue;
      }
      cur.params[kv[1].toLowerCase()] = kv[2];
      i++;
      continue;
    }

    diags.warning(
      `Unrecognized line preserved: "${trimmed.slice(0, 60)}"`,
      locOf(i, 1, raw.length),
      'W_UNKNOWN_STATEMENT'
    );
    i++;
  }

  return {
    ast: {
      kind: 'ConfigFile',
      path: file.path,
      statements,
      source: { file: file.path, line: 1, col: 1, offset: 0, length: file.content.length }
    },
    diagnostics: diags
  };
}

function _unused(_v: unknown): void {
  void offsetToLineCol;
}
void _unused;
