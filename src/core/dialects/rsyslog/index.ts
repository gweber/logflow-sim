import type { Dialect } from '../types.js';
import type { IRModel } from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import { parse } from './parser/parser.js';
import { buildIR } from './to-ir.js';
import { emit } from './emit.js';

/**
 * rsyslog / RainerScript dialect.
 *
 * Owns: the recursive-descent parser, the AST, and the
 * rsyslog-AST → normalized-IR mapping. The simulator and the rest of
 * the toolchain consume the normalized IR, not anything from this module.
 */
export const rsyslogDialect: Dialect = {
  id: 'rsyslog',
  displayName: 'rsyslog (RainerScript)',
  fileExtensions: ['.conf'],

  detect(sample): number {
    const { content } = sample;
    let score = 0;
    if (/^\s*module\s*\(\s*load\s*=/m.test(content)) score += 0.4;
    if (/^\s*ruleset\s*\(\s*name\s*=/m.test(content)) score += 0.3;
    if (/^\s*\$IncludeConfig|^\s*\$DefaultRuleset/m.test(content)) score += 0.3;
    if (/action\s*\(\s*type\s*=\s*"om[a-z]+"/m.test(content)) score += 0.2;
    if (/\$\!\w+|set\s+\$\.\w+/m.test(content)) score += 0.2;
    return Math.min(1, score);
  },

  parseFiles(files): { model: IRModel; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const asts = files.map((f) => {
      const r = parse({ path: f.path, content: f.content });
      diagnostics.push(...r.diagnostics.items);
      return r.ast;
    });
    const model = buildIR(asts, diagnostics);
    return { model, diagnostics: model.diagnostics };
  },
  emit
};

// Re-export the underlying primitives for callers that want them directly
// (the Node loader, tests, future REPL).
export { parse, buildIR };
export type { ConfigFile } from './parser/ast.js';
