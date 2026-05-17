# logflow-sim

[![CI](https://github.com/gweber/logflow-sim/actions/workflows/ci.yml/badge.svg)](https://github.com/gweber/logflow-sim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Live demo:** <https://netverdict.io/logflow/> · **Broken-config demo (validator showcase):** <https://netverdict.io/logflow-broken/>

**Explainable log-pipeline simulator.** Parses your routing configuration, builds a
normalized intermediate representation, and simulates a syslog message through it —
emitting a step-by-step trace of every input matched, ruleset entered, condition evaluated,
lookup performed, variable changed, and action fired, all with source locations.

No shelling out to the upstream daemon. No fixtures. No regex over the config text. The
parser and evaluator are implemented in-process in TypeScript.

An open-source project from [**netverdict.io**](https://netverdict.io). MIT licensed.
Third-party content + trademark notices in [NOTICE.md](NOTICE.md) — rsyslog,
syslog-ng, Fluent Bit, NXLog, Vector, OpenTelemetry, Logstash, Filebeat,
Promtail, Fluentd, Sigma, Wireshark, MCP, and Claude are trademarks of their
respective owners; logflow-sim is not affiliated with any of them.

## Use it as a GitHub Action

**Validate on every PR:**

```yaml
- uses: gweber/logflow-sim@v1
  with:
    conf-path: ./rsyslog
    command: test
    fail-on: errors
```

Diagnostics appear as inline PR annotations.

**Diff-mode — block PRs that reroute too much real traffic:**

```yaml
# .github/workflows/logflow-diff.yml
on: pull_request
jobs:
  diff:
    permissions:
      contents: read
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ github.base_ref }}, path: base }
      - uses: actions/checkout@v4
        with: { path: head }
      - uses: gweber/logflow-sim@v1
        with:
          command: diff
          conf-path: base/rsyslog
          overlay-dir: head/rsyslog
          lines: head/test/fixtures/replay-corpus.log
          max-route-change-pct: 5
          pr-comment: true
```

What the action posts on the PR:

> **logflow-sim diff verdict** — **127** of **25,567** messages change routing (**0.50%**)
> moved-to-delivered: **+0** · moved-to-unmatched: **−0**
>
> | kind | target | baseline | overlay | delta |
> |------|--------|---------:|--------:|------:|
> | omfile | `/var/log/secure` | 4,996 | 5,123 | **+127** |
> | omfile | `/var/log/messages` | 11,497 | 11,370 | **−127** |

Full examples in [`examples/github-workflows/`](examples/github-workflows/).

## Supported dialects

| Dialect | Parse | Emit (convert target) |
|---|---|---|
| rsyslog / RainerScript | ✓ full | ✓ |
| syslog-ng | ✓ full | ✓ |
| Fluent Bit | ✓ | ✓ |
| NXLog | ✓ | ✓ |
| Logstash | ✓ | ✓ |
| Vector | ✓ | ✓ |
| OpenTelemetry Collector | ✓ | ✓ |
| Filebeat | ✓ | ✓ |
| Promtail (Loki) | ✓ | ✓ |
| Fluentd (classic) | ✓ | ✓ |

Each dialect lives under `src/core/dialects/<id>/` and implements the `Dialect` interface
in [`src/core/dialects/types.ts`](src/core/dialects/types.ts). The simulator and UI consume
the normalized IR — they are dialect-agnostic.

## Supported SIEM destinations

logflow-sim knows the destination-side vocabulary of 10 major SIEM platforms
plus a passthrough `generic` target. Migration translates both the pipeline
syntax (dialect axis) and the destination's preferred field/value vocabulary
(SIEM axis) — or either one independently via `logflow-sim retag`.

| Target | Vendor | Wire format | Primary taxonomy |
|---|---|---|---|
| `generic` | — | passthrough | (none) |
| `splunk` | Splunk | JSON (HEC) | sourcetype |
| `elastic-ecs` | Elastic | JSON (ECS) | event.category / event.type |
| `datadog` | Datadog | JSON (Intake API) | ddsource |
| `loki` | Grafana Labs | JSON (Push API) | low-cardinality labels |
| `graylog-gelf` | Graylog | GELF 1.1 | facility |
| `microsoft-sentinel` | Microsoft | JSON (DCR) | custom log table (*_CL) |
| `sumo-logic` | Sumo Logic | JSON (HTTP) | _sourceCategory |
| `chronicle-udm` | Google | UDM JSON | metadata.event_type |
| `qradar-leef` | IBM | LEEF 2.0 (pipe) | LEEF EventID |
| `arcsight-cef` | OpenText | CEF 0 (pipe) | CEF EventClassID |

Translations route through the [OCSF](https://schema.ocsf.io) pivot — every
plugin maps to/from OCSF, never directly to other plugins, so adding a new
SIEM is O(1) in mapping effort. Lossy translations surface as
`SIEM_VALUE_LOSSY` diagnostics; original values are preserved verbatim.

Full reference: [`content/docs/siem-targets.md`](content/docs/siem-targets.md).

### Dialect × SIEM coverage matrix

Every combination is supported: the OCSF pivot makes the value rewriting
dialect-agnostic and the renderer is chosen by the target SIEM, not the
source dialect. The matrix below shows the **native output driver** each
dialect uses to drive each destination — for cells marked `→`, the dialect
emits via a generic HTTP / syslog forwarder rather than a dialect-specific
plugin.

| Dialect ↓ \ SIEM → | Splunk | Elastic | Datadog | Loki | Graylog | Sentinel | Sumo | Chronicle | QRadar | ArcSight |
|---|---|---|---|---|---|---|---|---|---|---|
| **rsyslog**        | `omsplunkhec` | `omelasticsearch` | `omhttp`→        | `omhttp`→        | `omfwd`+GELF      | `omhttp`→        | `omhttp`→ | `omhttp`→ | `omfwd`+LEEF | `omfwd`+CEF |
| **syslog-ng**      | `http()`→     | `elasticsearch-http()` | `http()`→   | `http()`→        | `gelf()`          | `http()`→        | `http()`→ | `http()`→ | `syslog(LEEF)` | `syslog(CEF)` |
| **Fluent Bit**     | `splunk`      | `es` / `elasticsearch` | `datadog`   | `loki`           | `gelf`            | `azure_logs_ingestion` | `http`→ | `http`→ | `syslog`+LEEF | `syslog`+CEF |
| **NXLog**          | `om_http`→    | `om_elasticsearch` | `om_http`→     | `om_http`→       | `om_udp`+GELF     | `om_http`→       | `om_http`→ | `om_http`→ | `om_udp`+LEEF | `om_udp`+CEF |
| **Logstash**       | `splunk`      | `elasticsearch`   | `datadog_logs`  | `loki`           | `gelf`            | `microsoft-sentinel-logstash` | `sumologic` | `google_cloud_chronicle` | `syslog`+LEEF | `syslog`+CEF |
| **Vector**         | `splunk_hec_logs` | `elasticsearch` | `datadog_logs` | `loki`         | `socket`+gelf     | `azure_monitor_logs` | `sumo_logic` | `gcp_chronicle_logging` | `socket`+LEEF | `socket`+CEF |
| **OTel**           | `splunk_hec`  | `elasticsearch`   | `datadog`       | `loki`           | `file`→GELF      | `azuremonitor`   | `sumologic` | `googlecloud`         | `file`→LEEF | `file`→CEF |
| **Filebeat**       | `output`→     | `elasticsearch` ★ | `output`→       | `output`→        | `output`→        | `azure_logs_ingestion` | `output`→ | `output`→ | `output`→ | `output`→ |
| **Promtail**       | —             | —                 | —               | `clients` ★      | —                 | —                | — | — | — | — |
| **Fluentd**        | `splunk_hec`  | `elasticsearch`   | `datadog`       | `loki`           | `gelf`            | `azure_logs_ingestion` | `sumologic` | `google_cloud_chronicle` | `syslog`+LEEF | `syslog`+CEF |

★ = canonical pairing (Promtail is the Loki agent; Filebeat is Elastic's
beats forwarder).
`→` = via generic HTTP / syslog forwarder, no dialect-native plugin.
`+GELF`/`+LEEF`/`+CEF` = the wire payload is rendered by logflow-sim's
dedicated renderer; the dialect only handles the transport.
`—` = the dialect doesn't ship a sensible output for this destination
(Promtail is single-purpose by design).

```bash
# Standalone retag (keep the pipeline syntax)
logflow-sim retag ./rsyslog \
  --source-siem=splunk --target-siem=elastic-ecs \
  --out-dir=./ecs/

# Pipeline + SIEM in one shot
logflow-sim convert ./rsyslog \
  --target=vector --source-siem=splunk --target-siem=datadog \
  --out-dir=./vector-dd/
```

## Migrate between dialects

Take your live rsyslog config and produce a working OpenTelemetry Collector
config (or any other supported target). The wizard at `/migrate` walks you
through it; the same flow is available headless:

```bash
curl -s -X POST localhost:3000/api/convert \
  -H 'content-type: application/json' \
  -d '{"target":"otel"}' | jq -r .output > otel-collector.yaml
```

Cross-dialect emit is best-effort — expression-language constructs (rsyslog
`lookup()`, Vector VRL, OTel OTTL) don't translate 1:1. The emitter surfaces
every translation caveat as a diagnostic and the migration UI lists them
prominently. To verify routing parity end-to-end:

1. Save the generated config into a folder mirroring your conf-tree
2. Use it as the overlay in Diff Mode (`/diff` or `logflow-sim diff`)
3. Replay a representative corpus through both — any non-zero output delta
   is a routing change you need to reconcile by hand

## CLI

The `logflow-sim` CLI is the engine behind the Action and works equally well
as a local pre-commit hook or in any CI runner.

```
logflow-sim parse    <conf-dir>                                  # parse + validator (silent drops, dead code, undef refs)
logflow-sim test     <conf-dir>                                  # parse + run conf/tests/*.json
logflow-sim simulate <conf-dir> --input=msg.json                 # one message, JSON trace
logflow-sim replay   <conf-dir> --lines=corpus.log               # batch, aggregate verdict
logflow-sim replay   <conf-dir> --pcap=capture.pcap              # accepts pcap classic and pcapng
logflow-sim convert  <conf-dir> --target=otel --out-dir=./out    # whole-tree migration + lookup sidecars
                                [--source-siem=splunk]           # also retag destination vocabulary
                                [--target-siem=elastic-ecs]
logflow-sim retag    <conf-dir> --target-siem=elastic-ecs        # destination retag only (keep pipeline dialect)
                                --out-dir=./out [--source-siem=…]
logflow-sim diff     <conf-dir> --overlay-dir=pr-conf/         \
                                --lines=corpus.log             \
                                --max-route-change-pct=5       # exit 1 if PCT exceeded
```

Output formats: `--format=human` (default), `--format=github` (annotations
for the Action), `--format=json` (machine-readable, pipe into jq).

## Static validator

`logflow-sim parse` (and `/api/config/parse`) runs a static analyzer over the
parsed IR. It catches the routing mistakes that don't show up in syntax
checks:

- **Silent-drop paths**: a ruleset whose last statement is an `if` without
  `else`, or ends with a `set/unset/reset` — messages on the fall-through
  path produce no output and are silently discarded.
- **Dead code**: rulesets, lookup tables, templates that are defined but
  never reached from any input.
- **Undefined references**: `call rulename`, `lookup("table", ...)`,
  `template="x"` to names that don't exist.
- **Conflicting outputs**: same target written by multiple unconditional
  actions.
- **Missing lookup files**: lookup_table(...) referencing a JSON that
  doesn't exist on disk.

Each finding includes the source location and a human-readable explanation,
e.g.:

> **WARNING** rsyslog.conf:5:3 `V_SILENT_DROP`
> Ruleset "catchall" can drop messages silently: the last statement is an
> `if` without an `else`, so messages for which the condition is false fall
> off the end and produce no output. Either add a catch-all action or end
> the ruleset with an explicit `stop` to make the intent of "do nothing"
> reviewable.

Trip a CI gate on these with `--fail-on=warnings`.

## Live config preview ("/config" + dialect picker)

The Config page's dialect picker is more than a parse-as override. When you
flip it to a non-source dialect, the file tree and viewer swap to an
on-the-fly converted preview — `rsyslog.conf` becomes `otel-collector.yaml`
with all referenced lookup tables emitted in OTel's transform/OTTL idiom
(or Vector's enrichment_tables + CSV sidecars, etc.). Flip the picker back
to `auto` to return to the on-disk source. This is the same engine that
powers `/api/convert` and `logflow-sim convert`.

## Replay & Diff

The simulator can run a real batch of messages through your config:

- **Replay** — accepts `/var/log/messages`-style line dumps **or** wire
  captures (libpcap classic + pcapng + LINUX_SLL, UDP + reassembled TCP for
  RFC 6587 octet-counted and non-transparent framing). Returns an aggregate
  report: per-ruleset, per-output-target, top programs/hostnames, plus
  drill-down samples for unmatched / silently-dropped / errored messages.
- **Diff** — replay the same batch through your live config and an overlay
  variant, get per-output and per-ruleset deltas plus side-by-side
  baseline-vs-overlay outputs for every message whose routing changes. Multi-
  file overlays are supported.

Try it against a real corpus:

```bash
# Fetch 25k real /var/log/messages lines from the Loghub research dataset
curl -sL https://zenodo.org/records/8196385/files/Linux.tar.gz | tar -xz

# Replay them through the bundled demo config
./scripts/replay-loghub.sh
```

## Detection-Impact

Run Sigma detection rules against a replay corpus through your live config —
optionally diffed against a proposed change — to see whether a routing
change cuts SOC visibility before you merge it:

```bash
curl -s -X POST localhost:3000/api/detection/impact \
  -H 'content-type: application/json' \
  -d '{ "rules": [...sigma rules...], "lines": "..." }' | jq .summary
```

Returns per-rule hit counts and (in the diff variant) which rules gain or
lose coverage under the overlay config. Full write-up:
[Will this routing change break your SIEM?](https://netverdict.io/logflow/blog/2026-05-17-detection-impact-before-you-merge).

## Projects & local mode

The [`/projects`](http://localhost:3000/projects) page lets you load
configs entirely client-side — clone the live server config, upload a
folder, drop individual files, or drop a `.zip` (drag-and-drop supported
anywhere on the page). Once loaded, the UI flips into **local mode** and
all parsing / simulation / search / validation runs in a Web Worker. No
project file leaves the browser. Saved projects persist in `localStorage`
and can be renamed, exported back to ZIP, or deleted at any time.

## MCP server (use logflow-sim from an LLM)

Ships with a [Model Context Protocol](https://modelcontextprotocol.io)
server (`logflow-sim-mcp`) that exposes the kernel as tools an LLM can
call: `logflow_parse`, `logflow_simulate`, `logflow_replay`,
`logflow_diff`, `logflow_convert`, `logflow_retag`, `logflow_detect`,
`logflow_validate`.
Stdio JSON-RPC 2.0 transport — register with Claude Desktop or any
MCP-aware client. Details in [`content/docs/mcp.md`](content/docs/mcp.md).

## i18n

UI ships in 13 languages: English, German, French, Spanish, Portuguese,
Italian, Japanese, Chinese, Korean, Russian, Hindi, Turkish, Vietnamese.
Picker in the top bar. Tool / dialect names stay in English so the UI
vocabulary matches the configs you're analyzing. Catalogs live in
[`src/ui/i18n/locales/`](src/ui/i18n/locales/) — single-file PRs welcome.

## Quick start

```bash
docker compose up --build
```

Open <http://localhost:3000>. Mount your own configs into `./conf/`, or run against the
bundled demo by pointing the compose volume at `./conf-demo/`.

### Without Docker

```bash
npm install
npm run dev
```

API on `:3000`, Vite UI dev server on `:5173` with HMR. In production
(`npm run build && npm start`) the server serves the built UI from `dist/ui`.

## Folder layout

```
src/
├── core/                         pure TS — no Node deps
│   ├── vfs.ts                    virtual filesystem interface
│   ├── source-map.ts             file/line/col tracking
│   ├── diagnostics.ts            severity-tagged error reporting
│   ├── ir/                       normalized intermediate representation (vendor-neutral)
│   ├── simulate/                 evaluator, expressions, templates
│   ├── lookups/                  parse-table + lookup query
│   └── dialects/
│       ├── types.ts              the Dialect plugin contract
│       └── rsyslog/              RainerScript parser + AST + IR mapping
├── vfs/node.ts                   NodeVFS — fs + fast-glob adapter
├── config/                       Node-side loaders (use VFS)
├── lookups/loader.ts             Node-side lookup loader (uses VFS + core)
├── api/                          Express routes
├── content/                      blog + docs markdown loader
├── server.ts                     Express bootstrap
└── ui/                           Preact SPA

conf-demo/                        bundled demo configuration (tracked in git)
conf/                             your own configs (gitignored — mount your dir here)
content/posts/, content/docs/     markdown for blog + docs pages
test/                             vitest suites
```

## API examples

```bash
# Liveness
curl -s localhost:3000/api/health

# Parse summary + diagnostics
curl -s localhost:3000/api/config/parse | jq .

# Simulate a firewall message hitting :6514/UDP
curl -s -XPOST localhost:3000/api/simulate \
  -H 'content-type: application/json' \
  -d '{
    "transport": "udp", "port": 6514,
    "fromhost": "fw01", "hostname": "fw01",
    "programname": "firewall",
    "msg": "TRAFFIC deny tcp 10.0.0.1 -> 8.8.8.8:53"
  }' | jq .

# Multi-file grep across the loaded configuration
curl -s 'localhost:3000/api/config/search?q=10.254.0.20'
curl -s -G --data-urlencode 'q=10\.252\.\d+\.\d+' --data 'regex=1' \
  'localhost:3000/api/config/search'

# Run all test cases under conf/tests
curl -s -XPOST localhost:3000/api/tests/run -d '{}' \
  -H 'content-type: application/json' | jq '.passed,.total'
```

## Known limitations

This is an **explainer**, not a re-implementation. See
[`content/docs/limitations.md`](content/docs/limitations.md) for the full list.

Short version:

- No queue runtime, no actual file/network I/O.
- Lookup tables: JSON only (plain object, array-of-objects, rsyslog native format).
- Templates: full `%property%` substitution with modifiers (lowercase, uppercase, substring,
  regex extract, date components) — but no obscure rsyslog property-replacer flags yet.
- Unknown statements are **never silently skipped** — they are preserved as `Unknown` IR
  nodes with a warning diagnostic.

## Tests

```bash
npm test
```

Covers the lexer, parser, include resolution, RFC 3164 / 5424 rawmsg decoding,
lookup-table loading (all three formats), and end-to-end simulator behavior
(input selection, `$DefaultRuleset` fallback, if/elif/else, set/reset/unset,
lookup hit/miss with `nomatch`, `stop`, DynaFile template resolution, omfwd
target/port/protocol, array-RHS `startswith_i`, `call` between rulesets, regex
extract, `exec_template`, `tolower`/`toupper`, `&` concatenation, numeric
comparisons, `continue`).

### Corpus regression suite

`test/corpus/` contains 20+ real-world rsyslog configurations fetched verbatim
from public sources (Debian / Fedora / Alpine / Gentoo distro defaults plus
configs from large open-source projects — see [`SOURCES.md`](test/corpus/SOURCES.md)).
The corpus test parses each one and asserts its diagnostic counts and IR
summary match the recorded baseline in `test/corpus/baseline.json`. Any drift
is a regression.

Refresh the corpus from upstream:

```bash
./scripts/fetch-corpus.sh
git diff test/corpus/    # what changed upstream
```

After an intentional parser change that shifts counts, regenerate the
baseline:

```bash
UPDATE_CORPUS_BASELINE=1 npm test -- corpus
```

## License

MIT.
