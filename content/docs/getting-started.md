---
title: Getting started
order: 1
---

# Getting started

## Run with Docker

```bash
docker compose up --build
```

Open `http://localhost:3000`. The container mounts `./conf` and `./content`
read-only. Drop your own config (rsyslog, syslog-ng, Fluent Bit, NXLog,
Logstash, Vector, OpenTelemetry Collector, Filebeat, Promtail, or Fluentd)
into `./conf/` and reload — or point the compose volume at `./conf-demo/` to
play with the bundled multi-vendor demo.

## What's in the UI

| Page | Purpose |
|---|---|
| **Home** | At-a-glance stats: inputs, rulesets, lookups, plus the most-used outputs and rulesets in your config |
| **Simulator** | Send one synthetic message; get a step-by-step trace with source locations |
| **Replay** | Drop a batch of real syslog (text or pcap) and see the aggregate verdict — per-ruleset, per-output, top programs, drill-down samples |
| **Diff** | Replay through both your live config and an overlaid variant, see routing deltas before you merge |
| **Detection** | Run Sigma detection rules against a replay corpus; optionally diff against an overlay to see whether a routing change cuts SOC visibility |
| **Migrate** | Convert your config to another dialect (rsyslog → OTel, Vector → syslog-ng, etc.) with all lookup tables in the target's native form |
| **Projects** | Clone the live server config or upload your own (folder, files, or ZIP — drag-and-drop supported) into a browser-local project; switches the UI into local mode where parsing and simulation run in a Web Worker without anything leaving the browser |
| **Config** | Browse the parsed tree; switch the dialect picker to get an on-the-fly converted preview of every file |
| **Tests** | Run `conf/tests/*.json` expectation files |
| **Blog** | Project notes, design write-ups, feature announcements |
| **Docs** | This page and friends |

### Local mode

The mode toggle in the top bar flips between **server mode** (operates on
the host-mounted `./conf`) and **local mode** (operates on a browser-local
project bundle). In local mode the bundle never leaves your browser — useful
for inspecting configs you don't want to upload to a server.

### Language

The locale picker in the top bar offers 13 languages (English, German,
French, Spanish, Portuguese, Italian, Japanese, Chinese, Korean, Russian,
Hindi, Turkish, Vietnamese). Tool / dialect names stay in English on
purpose so the UI vocabulary matches the configs you're analyzing.

## Folder layout

```
conf/
├── rsyslog.conf            # entrypoint (override with RSYSLOG_CONF_ENTRYPOINT)
├── etc/rsyslog.d/*.conf    # included files (absolute /etc/rsyslog.d/ paths map here)
├── lookups/*.json          # lookup table files referenced by lookup_table(...)
└── tests/*.json            # expectation files for /api/tests/run

content/
├── posts/*.md              # blog posts
└── docs/*.md               # documentation pages (this directory)
```

## Configuration entrypoint

By default the simulator loads `conf/rsyslog.conf`. To use a different entrypoint:

```bash
RSYSLOG_CONF_ENTRYPOINT=conf/alternate.conf docker compose up
```

For non-rsyslog dialects, point the picker at the right ID — auto-detect runs
against the entrypoint's content too, so a `service:` block at the top of a
YAML config is enough to identify it as OTel Collector.

## CLI

The same engine that drives the UI ships as a CLI suitable for pre-commit
hooks, ad-hoc shell pipelines, or CI runners.

```bash
# Static checks: parse + dialect plugin + validator
logflow-sim parse   ./rsyslog --fail-on=warnings

# Replay a real log batch
logflow-sim replay  ./rsyslog --lines=/var/log/messages.txt

# Replay a pcap (classic libpcap or pcapng, UDP + reassembled TCP)
logflow-sim replay  ./rsyslog --pcap=capture.pcap

# Diff routing across a proposed change (CI gate)
logflow-sim diff    ./rsyslog --overlay-dir=./rsyslog-pr \
                              --lines=corpus.log \
                              --max-route-change-pct=5 --format=github

# Migrate the whole config tree to another dialect
logflow-sim convert ./rsyslog --target=otel --out-dir=./otel-out
```

Exit codes: `0` success · `1` diagnostics or routing threshold breached ·
`2` test cases failed · `3` bad invocation. Output formats: `human`,
`github` (annotations), `json` (machine).

## Run without Docker

```bash
npm install
npm run dev
```

API on port 3000, Vite UI dev server on 5173 with HMR. In production
(`npm run build && npm start`) the server serves the built UI from `dist/ui`.

## Quick sanity check

```bash
curl -s localhost:3000/api/health
curl -s localhost:3000/api/config/parse | jq .summary
```
