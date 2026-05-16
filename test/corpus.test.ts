import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsyslogDialect } from '../src/core/dialects/rsyslog/index.js';
import { syslogNgDialect } from '../src/core/dialects/syslog-ng/index.js';
import { fluentBitDialect } from '../src/core/dialects/fluent-bit/index.js';
import { nxlogDialect } from '../src/core/dialects/nxlog/index.js';
import { logstashDialect } from '../src/core/dialects/logstash/index.js';
import { vectorDialect } from '../src/core/dialects/vector/index.js';
import type { Dialect } from '../src/core/dialects/types.js';

/**
 * Corpus regression test (multi-dialect).
 *
 * Each `test/corpus/<dialect>/**` subtree is parsed with the matching
 * dialect plugin. The dialect registry below maps directory names to their
 * Dialect implementation. Optional dialects (those we haven't built yet)
 * simply skip — adding their directory under `test/corpus/` is enough to
 * pull them into the test run once their plugin is wired in.
 *
 * Counts are baselined per-dialect in `test/corpus/<dialect>/baseline.json`.
 * Drift between a fresh parse and the baseline is a regression. Refresh the
 * baselines deliberately with:
 *
 *     UPDATE_CORPUS_BASELINE=1 npm test -- corpus
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CORPUS_ROOT = path.resolve(__dirname, 'corpus');

const DIALECTS: Record<string, Dialect | null> = {
  rsyslog: rsyslogDialect,
  'syslog-ng': syslogNgDialect,
  // The remaining plugins land as we build them.
  'fluent-bit': fluentBitDialect,
  nxlog: nxlogDialect,
  logstash: logstashDialect,
  vector: vectorDialect
};

interface BaselineEntry {
  errors: number;
  warnings: number;
  info: number;
  inputs: number;
  rulesets: number;
  templates: number;
  lookupTables: number;
  modules: number;
  unknownStatements: number;
  outputs?: number;
  filters?: number;
  routes?: number;
}

type Baseline = Record<string, BaselineEntry>;

function collectConfigFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && /\.(conf|cfg|toml|yaml|yml|xml)(\.[\w-]+)?$/.test(entry.name)) {
        out.push(p);
      }
    }
  }
  walk(dir);
  return out.sort();
}

function relName(abs: string, root: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

function parseFile(abs: string, root: string, dialect: Dialect): BaselineEntry {
  const content = fs.readFileSync(abs, 'utf8');
  const result = dialect.parseFiles([{ path: relName(abs, root), content }]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of result.diagnostics) counts[d.severity]++;
  let unknownStatements = 0;
  function visit(stmts: typeof result.model.rulesets[0]['statements']): void {
    for (const s of stmts) {
      if (s.kind === 'Unknown') unknownStatements++;
      else if (s.kind === 'If') {
        visit(s.then);
        if (s.else) visit(s.else);
      }
    }
  }
  for (const rs of result.model.rulesets) visit(rs.statements);

  return {
    errors: counts.error,
    warnings: counts.warning,
    info: counts.info,
    inputs: result.model.inputs.length,
    rulesets: result.model.rulesets.length,
    templates: result.model.templates.length,
    lookupTables: result.model.lookupTables.length,
    modules: result.model.modules.length,
    unknownStatements,
    outputs: result.model.outputs.length,
    filters: result.model.filters.length,
    routes: result.model.routes.length
  };
}

if (process.env.UPDATE_CORPUS_BASELINE === '1') {
  describe('corpus baseline regeneration', () => {
    for (const [id, dialect] of Object.entries(DIALECTS)) {
      if (!dialect) continue;
      const root = path.join(CORPUS_ROOT, id);
      if (!fs.existsSync(root)) continue;
      it(`writes ${id} baseline`, () => {
        const files = collectConfigFiles(root);
        const baseline: Baseline = {};
        for (const f of files) baseline[relName(f, root)] = parseFile(f, root, dialect);
        const baselinePath = path.join(root, 'baseline.json');
        fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
        expect(Object.keys(baseline).length).toBe(files.length);
      });
    }
  });
} else {
  describe('corpus regression', () => {
    for (const [id, dialect] of Object.entries(DIALECTS)) {
      if (!dialect) continue;
      const root = path.join(CORPUS_ROOT, id);
      if (!fs.existsSync(root)) continue;

      const files = collectConfigFiles(root);
      const baselinePath = path.join(root, 'baseline.json');
      const baseline: Baseline = fs.existsSync(baselinePath)
        ? (JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Baseline)
        : {};

      describe(`dialect: ${id}`, () => {
        it(`finds at least one config file in ${path.relative(process.cwd(), root)}`, () => {
          expect(files.length).toBeGreaterThan(0);
        });

        for (const f of files) {
          const name = relName(f, root);
          it(`parses ${name} and matches baseline`, () => {
            const got = parseFile(f, root, dialect);
            const want = baseline[name];
            if (!want) {
              throw new Error(
                `No baseline entry for ${id}/${name}. Run UPDATE_CORPUS_BASELINE=1 npm test -- corpus`
              );
            }
            // Newly-added optional counts default to 0 in older baselines.
            expect(got).toEqual({
              outputs: 0,
              filters: 0,
              routes: 0,
              ...want
            });
          });
        }
      });
    }
  });
}
