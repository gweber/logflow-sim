import type { Dialect } from '../types.js';
import type { IRModel } from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import { parse } from './parser/parser.js';
import { buildIR } from './to-ir.js';
import { emit } from './emit.js';

export const syslogNgDialect: Dialect = {
  id: 'syslog-ng',
  displayName: 'syslog-ng',
  fileExtensions: ['.conf'],

  detect(sample): number {
    const { content } = sample;
    let score = 0;
    if (/^\s*@version\s*:/m.test(content)) score += 0.4;
    if (/^\s*@include\b/m.test(content)) score += 0.2;
    if (/^\s*source\s+\w+\s*\{/m.test(content)) score += 0.4;
    if (/^\s*destination\s+\w+\s*\{/m.test(content)) score += 0.3;
    if (/^\s*log\s*\{[^}]*source\(/m.test(content)) score += 0.3;
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

export { parse, buildIR };
export type { ConfigFile } from './parser/ast.js';
