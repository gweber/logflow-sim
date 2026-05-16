# Good first issues — seeded contributions

This file lists concrete starter contributions for new collaborators.
Each entry is sized as a single PR with a clear acceptance criterion.
Pick one, open an issue with the bullet's title, then a PR referencing
that issue.

If you're new to TypeScript or the codebase: items marked `[easy]` are
the gentlest entry points. `[medium]` requires reading one or two
existing files first. `[hard]` is real design work — but the patch is
still bounded.

## Dialects

- **[medium] Add a Promtail dialect.** Promtail (Grafana Loki shipper)
  uses YAML with `scrape_configs:` shaped like Prometheus. Model: 
  `scrape_configs[]` → `IRInput[]`, `pipeline_stages[]` → `IRModule[]`,
  `clients[]` → `IROutput[]`. Reference implementation pattern:
  `src/core/dialects/filebeat/`. Acceptance: parser test passes against
  a stock Loki Promtail example config, detect score > 0.5.

- **[medium] Add a Fluentd-classic dialect.** Fluentd uses a
  Ruby-flavored DSL with `<source>`, `<filter>`, `<match>` blocks.
  Acceptance: parses the bundled td-agent.conf example.

- **[hard] Add a Graylog pipeline-rules dialect.** Graylog's
  pipelines DSL is a small language with `when` clauses and side-
  effecting functions. Acceptance: parses 5 representative pipelines
  from the Graylog docs, validation flags `when (...)` clauses with
  undefined inputs.

## Validation rules

- **[easy] Add `rsyslog/empty-ruleset` rule.** Flag rulesets with zero
  statements as `info` — they're either typos or in-progress code.
  Reference: `src/core/validate/rules/silent-drop-paths.ts`.

- **[easy] Add `syslog-ng/log-flags-final-after-more-logs` rule.**
  When a `log{}` block has `flags(final)` but more log blocks follow
  it, the later blocks never see those messages. Reference: the
  orphans rules in `src/core/validate/rules/syslog-ng-orphans.ts`.

- **[medium] Add `vector/cycle-detection` rule.** Build a DAG from
  transforms' `inputs:` arrays. Flag any cycle as an error. Vector
  refuses to start on a cyclic config; we should catch it pre-deploy.

- **[easy] Add `otel/missing-batch-processor` rule.** Pipelines for
  the `logs` and `traces` signals without a batch processor commonly
  hammer their backends. Emit `info` ("performance").

- **[medium] Add `fluent-bit/tag-routing-mismatch` rule.** Cross-
  reference each [INPUT]'s Tag against each [OUTPUT]'s Match pattern.
  Inputs whose tags never match any output → silent drop.

## Translations

- **[easy] Translate `ja.json`, `fr.json`, `es.json`, `pt.json`,
  `it.json`, `ko.json`, `ru.json`, `vi.json`, `tr.json`, `zh.json`,
  `hi.json`.** Each is one PR. The English source lives in
  `src/ui/i18n/locales/en.json`. See `CONTRIBUTING.md` → "How to add
  a translation" for the 5-step workflow.

## Sigma / detection

- **[medium] Add `condition: <name> | count() by <field> > N`
  aggregation support to the Sigma matcher.** Today we treat
  aggregations as never-matching. Reference:
  `src/core/detection/sigma-matcher.ts:evalCondition`.

- **[medium] Add Windows-field aliasing to the Sigma matcher.**
  Sigma rules tagged `product: windows` use `Image`, `EventID`,
  `CommandLine`. We treat them as no-value today. If the message
  has matching fields in `extra` (RFC5424 structured-data), they
  should compare.

- **[easy] Add SigmaHQ community test fixtures.** Fetch 10
  representative rules from sigmahq/sigma into `test/fixtures/sigma/`
  and assert each parses without errors. SigmaHQ is MIT-licensed.

## Replay / pcap

- **[medium] Add pcap streaming from stdin.** Today `logflow-sim
  replay --pcap=FILE` reads the file into memory. For large captures,
  `--pcap=-` (stdin streaming) would let an operator pipe `tcpdump -w
  - 'port 514'` directly into the engine. Pcap-classic-format only
  for the first cut.

- **[medium] Add HTTP source for replay.** A `POST /api/replay/one`
  endpoint that takes a single line and returns the simulator trace
  inline — useful for chat-bot / SOAR-playbook integration.

- **[hard] Add TCP segment reordering for the pcap reassembler.**
  Today we assume in-order segments per flow. Real-world WAN captures
  have reordering. Reference: `src/core/replay/parse-pcap.ts:TcpFlow`.

## UI / DX

- **[easy] Add a /detection page mirroring /diff.** The Sigma engine
  is wired up at `POST /api/detection/impact` and `/detection/diff`
  but has no dedicated UI yet. Reference: `src/ui/pages/Diff.tsx`
  for the side-by-side layout pattern.

- **[easy] Add a "Run diff" CLI quick-reference card on the Home
  page.** Today the Home page has an "API at a glance" card; add a
  parallel "CLI at a glance" card with the 6 main subcommands.

- **[medium] Add a "Test from clipboard" button on the Simulator
  page.** Reads the clipboard, expects a raw syslog line, pre-fills
  the form and runs the simulation. Reference: the existing presets
  dropdown.

## How to claim one

Open an issue with the bullet's title (copy-paste fine). I or another
maintainer will tag it `good first issue` so duplicate work is
unlikely. Then open a PR referencing the issue. Small PRs ship faster.
