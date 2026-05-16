# Contributing to logflow-sim

Pure OSS, MIT, no commercial entity behind it. Contributions are how this
tool stays useful — pick one of the levers below.

## Where help moves the needle

1. **Run it against your real config and report what breaks.** Drop a
   redacted copy of your `rsyslog.conf` (or any other dialect) in an issue.
   False-positive validations, wrong simulation traces, parser crashes on
   real-world syntax are all in-scope bugs.
2. **Add a dialect.** 10 are wired today (rsyslog, syslog-ng, Fluent Bit,
   NXLog, Logstash, Vector, OTel Collector, Filebeat, Promtail, Fluentd).
   Graylog-pipelines, Cribl, custom in-house DSLs are all candidates.
3. **Add a validation rule** for a dialect that's under-served. Each rule
   is ~50 LOC; see the "How to add a validation rule" section below.
4. **Polish a translation.** All 13 locales (en, de, fr, es, pt, it, ja,
   zh, ko, ru, hi, tr, vi) ship full UI translations today. If something
   reads awkwardly in your locale, the catalogs live under
   `src/ui/i18n/locales/` and a one-file PR is the smallest meaningful
   contribution to the project.
5. **Extend test coverage.** Especially the corpus regression suite under
   `test/corpus/` — fetch real-world distro defaults and pin their parse
   summaries as baselines.

## Development

```bash
npm install
npm run dev      # API on :3000, UI on :5173 with HMR
npm test         # Vitest
npm run build    # Type-check + bundle
```

CLI (used by the GitHub Action and the live deployment scripts):

```bash
node dist/cli/main.js parse            conf-demo --format=human
node dist/cli/main.js test             conf-demo --format=github
node dist/cli/main.js replay           conf-demo --lines=corpus.log
node dist/cli/main.js diff             conf-demo --overlay-dir=pr-conf/ --lines=corpus.log
node dist/cli/main.js convert          conf-demo --target=otel --out-dir=./out
node dist/cli/main.js detection-impact conf-demo --sigma=rule.yml --lines=corpus.log
```

The repo's CI mirrors this — your PR runs the same checks locally if you
pre-commit `npm test && npm run build`.

## Code conventions

- **Pure TypeScript.** The `src/core/` tree has zero Node-specific imports
  — it runs in a browser worker unchanged. File access goes through the
  `VFS` interface (`src/core/vfs.ts`).
- **No emojis** in source files, comments, or generated output.
- **Comments explain *why*, not *what*.** Identifier names carry the *what*.
- **Errors are diagnostics**, never thrown except for genuinely invalid
  programmer input (the loader-vs-simulator boundary is the line).
- **Determinism matters.** Same config + same message → same trace. No
  clocks inside the simulator core (use the message's `simTime` field).
- **Recovery over crashes.** Malformed input emits a diagnostic with file +
  line + a clear message; the rest of the batch keeps processing.

## How to add a dialect

Each dialect is a self-contained directory under `src/core/dialects/<id>/`.
The plugin contract is `Dialect` in `src/core/dialects/types.ts` — 4 methods
total, two of them optional.

Worked example: **Filebeat** (`src/core/dialects/filebeat/`).

1. **`index.ts`** — exports the `Dialect` object: id, displayName, file
   extensions, a `detect()` heuristic that scores 0–1 against a config
   sample, and a `parseFiles()` that walks each file into the normalized
   `IRModel`. Mapping conventions:

   | Source concept | IR slot |
   |---|---|
   | Input source (syslog listener, file tail, otlp endpoint) | `IRInput` |
   | Processor / transform / filter | `IRModule` |
   | Output / sink / exporter | `IROutput` |
   | Named routing edge | `IRRoute` (`inputRefs`, `transformRefs`, `outputRefs`) |
   | Lookup / enrichment table | `IRLookupTable` |
   | Conditional routing rule body | `IRRuleset` with `IRStatement[]` (rsyslog only) |

2. **`emit.ts`** (optional) — the inverse: `IRModel → string`. Used by
   `/api/convert` and `logflow-sim convert`. Accepts an optional
   `lookupTables` map so emit can rewrite lookups into the target dialect's
   idiom (Vector enrichment_tables + CSV, OTel transform processor with
   OTTL, Filebeat JS script processor with inlined map). Return
   `EmitResult { output, files?, diagnostics }` — `files[]` for multi-file
   emit (main config + sidecars).

3. **Register** in `src/core/dialects/registry.ts`.

4. **Tests** in `test/<id>.test.ts`. At minimum: detect, parse,
   round-trip (emit re-parses through the same dialect with same input/
   output counts).

5. **One example config** under `conf-demo/` (or in a new `conf-<id>-demo/`
   if the structure differs significantly). Optional but lets demo-mode
   actually show the dialect doing something.

## How to add a validation rule

Two flavors:

**Cross-dialect rule** — operates on the normalized IR, applies to every
config regardless of source dialect. Examples: undefined-refs, dead-code,
silent-drop-paths.

```ts
// src/core/validate/rules/<id>.ts
export const myRule: ValidationRule = {
  id: 'undefined-template-ref',
  description: 'Action references a template name not declared anywhere',
  defaultSeverity: 'error',
  run(model): Diagnostic[] {
    // Walk model.rulesets, return Diagnostic[] with source locations.
    return [];
  }
};
```

**Dialect-specific rule** — only fires when the source dialect matches.
Examples: `rsyslog/module-load-required`, `syslog-ng/orphan-source`,
`otel/pipeline-component-undefined`.

```ts
export const myDialectRule: ValidationRule = {
  id: 'rsyslog/example-rule',
  description: '…',
  defaultSeverity: 'warning',
  dialects: ['rsyslog'],   // ← gate the rule to one dialect
  run(model): Diagnostic[] { /* … */ return []; }
};
```

Register in `src/core/validate/index.ts`. The rule loops live in the
order they're listed there.

Tests: drop a `test/validate-<rule-id>.test.ts` with at least one
positive and one negative case. Use the `parse + buildIR` helper pattern
from `test/validate-silent-drop.test.ts` as a template.

## How to add a translation

1. Pick a code from `src/ui/i18n/locales.ts`.
2. Copy `src/ui/i18n/locales/en.json` to `<code>.json`.
3. Translate the right-hand sides. Keep the `{name}` / `{count}` placeholder
   tokens intact — they're variable substitutions.
4. Register the catalog import in `src/ui/i18n/index.ts` (one line) and
   add the code to `LOCALES_WITH_CATALOG` in `src/ui/components/LocalePicker.tsx`.
5. Open the PR with a screenshot of the translated Home page.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is released under the MIT license
included in [LICENSE](LICENSE).
