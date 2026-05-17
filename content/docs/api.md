---
title: API reference
order: 3
---

# API reference

All endpoints are mounted under `/api`. JSON in, JSON out. Errors are returned as
`{ "error": { "code": "...", "message": "...", "context": {...} } }` with the
HTTP status reflecting the kind (400 BadRequest, 404 NotFound, 422 Unsupported,
500 InternalError).

The active dialect (rsyslog, otel, vector, …) is determined per-request:
- Default: auto-detected from the entrypoint file.
- Override: append `?dialect=<id>` to any endpoint, or persist the choice in
  the UI dialect picker (which sets a localStorage key the lib auto-honors).

## Health & introspection

### `GET /api/health`
Liveness check. `{ "ok": true, "version": "0.2.0" }`.

### `GET /api/dialects`
Returns the list of registered dialects with `id`, `displayName`,
`fileExtensions`. Currently 10: `rsyslog`, `syslog-ng`, `fluent-bit`, `nxlog`,
`logstash`, `vector`, `otel`, `filebeat`, `promtail`, `fluentd`.

### `GET /api/siem-targets`
Returns the list of registered SIEM destinations with `id`, `displayName`,
`vendor`, `rendering` (`json | gelf | leef | cef | udm | passthrough`),
`outputDrivers` (the driver fingerprints used for auto-detection), and
`taxonomies` (the value-taxonomies this plugin knows about — e.g.
`sourcetype` for Splunk, `ecs.event.category` for Elastic).

Currently 11: `generic`, `splunk`, `elastic-ecs`, `datadog`, `loki`,
`graylog-gelf`, `microsoft-sentinel`, `sumo-logic`, `chronicle-udm`,
`qradar-leef`, `arcsight-cef`. See
[`/docs/siem-targets`](/docs/siem-targets) for the full reference.

## Configuration

### `GET /api/config/tree`
Every file under `conf/` with `path`, `size`, and `referenced` (true if the
parser reached it via include resolution). Independent of dialect — it's a
pure directory listing.

### `GET /api/config/file?path=<rel>`
Raw text of one file under `conf/`. Path traversal rejected. Used by the
Config page and any external tooling that wants to read the on-disk source.

### `GET /api/config/parse`
Parser diagnostics, IR summary, validator findings:
```json
{
  "dialect": "rsyslog",
  "diagnostics": [...],
  "summary": { "files": 4, "inputs": 4, "rulesets": 3, ... },
  "validation": { "errors": 0, "warnings": 0, "info": 22 },
  "analysis": { "deadRulesets": 0, "unusedLookupTables": 0, ... },
  "defaultRuleset": "catchall"
}
```

### `GET /api/config/search?q=...&cs=0&regex=0&limit=500`
Multi-file grep across all loaded conf files. Returns per-match `{file, line,
col, snippet, matchStart, matchLen}`. Used by the Config page search bar.

### `GET /api/config/bundle`
Returns every file's content in one shot (`{path → content}`). Used by the
worker-mode bootstrap so the browser can re-parse offline.

### `GET /api/model`
The full normalized IR: inputs, rulesets (with statements as discriminated
union), templates, lookup tables (with `loaded`/`size`/`format`), modules,
globals, diagnostics. The Home page uses this for the "Your config" panel.

### `POST /api/invalidate`
Forces the next request to re-parse from disk. Useful in dev when editor
mtimes lag.

## Simulate

### `POST /api/simulate`
Run a single synthetic message through the live config. Body must contain at
least one of `rawmsg`, `msg`, `programname`, `hostname`, `fromhost`,
`syslogtag`, `transport`, `port` — an empty object returns 400.

```json
{
  "transport": "udp", "port": 514,
  "fromhost": "fw01", "fromhostIp": "10.1.2.3",
  "hostname": "fw01", "programname": "firewall",
  "rawmsg": "<134>May 15 12:00:00 fw01 firewall: TRAFFIC deny ..."
}
```

Response: `selectedInput`, `selectedRuleset`, `finalState.outputs[]`,
step-by-step `trace[]` (each with source location + details), `diagnostics`.

### `POST /api/parse-rawmsg`
Pure parser for an RFC3164 or RFC5424 wire-format string. Useful as a UI
helper before invoking `/simulate`. No model lookup — just decode.

## Replay & Diff (batch routing analysis)

### `POST /api/replay/lines`
Run a batch of syslog text lines through the live config, return an
aggregate. Accepts any of:
- `text`: newline-separated raw syslog
- `lines`: pre-split string array
- `ndjson`: each line a JSON object matching SyslogMessage shape

Plus `maxMessages` (cap, default 50k) and `samplesPerBucket`.

Response shape:
```json
{ "source": "lines", "dialect": "rsyslog", "report": {
    "total": 25567, "processed": 25567, "delivered": 25567,
    "noInputMatch": 0, "noOutput": 0, "errors": 0, "durationMs": 1516,
    "topPrograms": [{ "key": "kernel", "count": 13670, "pct": 53.5 }, ...],
    "perRuleset": [...], "perOutput": [...],
    "unmatchedSamples": [...], "noOutputSamples": [...], "errorSamples": [...]
} }
```

### `POST /api/replay/pcap`
Same engine, pcap input via base64. Supports **classic libpcap** and **pcapng**
(Wireshark default since v3), link-types Ethernet / LINUX_SLL / Raw IPv4, UDP
and reassembled TCP (RFC 6587 octet-counted and non-transparent framing).
Body: `{ "pcapBase64": "...", "maxMessages": 50000 }`.

Response adds a `pcap` block with `packetsTotal`, `packetsOnSyslogPorts`, and
any parser diagnostics.

### `POST /api/replay/diff`
Run the same batch through baseline and overlay variants, return the routing
delta. Body: `{ overlay: { "path/to/file": "content", ... }, text|lines|ndjson|pcapBase64, maxMessages? }`.

```json
{ "dialect": "rsyslog", "overlayFiles": ["etc/rsyslog.d/10-catchall.conf"],
  "diff": {
    "baseline": {...}, "overlay": {...},
    "routeChanges": 127, "movedToDelivered": 0, "movedToUnmatched": 0,
    "outputDeltas": [{ "kind": "omfile", "target": "/var/log/secure",
                       "baseline": 4996, "overlay": 5123, "delta": 127 }, ...],
    "rulesetDeltas": [...],
    "routeChangeSamples": [{ "index": 17, "programname": "sshd",
                              "baselineOutputs": [...], "overlayOutputs": [...] }, ...]
} }
```

## Convert (cross-dialect + SIEM retag)

### `POST /api/convert`
Emit the live IR in another dialect. Lookup-table content is rewritten into
the target dialect's native form (OTel transform/OTTL, Vector enrichment_tables
+ CSV, etc.) and returned as sidecar files.

**Optional `sourceSiem` / `targetSiem`** trigger destination-vocabulary
rewriting through an OCSF pivot — Splunk sourcetypes get translated into
ECS event.category, Datadog ddsource, GELF facility, etc. When `sourceSiem`
is omitted, the kernel auto-detects from output drivers; if confidence is
below 60% it falls back to `generic` and emits a `SIEM_SOURCE_UNDETECTED`
warning.

Body:
```json
{
  "target": "vector",
  "sourceSiem": "splunk",     // optional, default: auto-detect
  "targetSiem": "elastic-ecs" // optional, omit to skip vocabulary rewriting
}
```

Response:
```json
{ "sourceDialect": "rsyslog", "targetDialect": "vector",
  "sourceSiem": "splunk", "targetSiem": "elastic-ecs",
  "output": "# Generated by logflow-sim convert\n...",
  "files": [
    { "path": "vector.toml", "content": "..." },
    { "path": "lookups/sourcetypes.csv", "content": "..." }
  ],
  "diagnostics": [
    { "severity": "info", "code": "SIEM_VALUE_LOSSY",
      "message": "Lookup table \"sourcetypes\" (taxonomy: sourcetype): 2 of 14 value(s) had no exact mapping from splunk to elastic-ecs and were preserved verbatim." }
  ]
}
```

`output` is `files[0].content` for backwards compatibility. The full file set
is what the Config page consumes when the dialect picker is set to a non-source
target — it renders the converted output live, including lookup sidecars.

### Retag (destination-only)
There is no separate endpoint — `POST /api/convert` with `target` equal to
the source dialect performs a destination-only retag. The CLI exposes this
as `logflow-sim retag`; the MCP server exposes it as `logflow_retag`.

## Detection-Impact

### `POST /api/detection/impact`
Run a Sigma rule set against a replay corpus through the live config.

Body: `{ "rules": [...], "lines": "...", "limit": 5000 }`. `rules` is an array
of Sigma rule objects (or YAML strings); `lines` is the syslog corpus, one
message per line.

Returns `{ summary: { total, hit, missed }, perRule: [{ id, title, hits }],
  samples: [...] }`.

### `POST /api/detection/diff`
Same as above, but additionally replays the corpus through an overlay config
and returns the **detection delta** — which rules gain coverage, lose
coverage, or are unaffected. Use this to gate routing changes that affect
SOC visibility.

Body adds `overlayFiles: ["etc/rsyslog.d/10-catchall.conf", ...]`.

## Tests

### `GET /api/tests`
Lists every test case in `conf/tests/*.json` without running them.

### `POST /api/tests/run`
Runs all (or a filtered subset) through the simulator and compares against
each case's `expect` block. Returns `{ total, passed, failed, results: [...] }`
with per-check detail (`{name, want, got, passed}`).

## Blog & docs

- `GET /api/blog/posts` / `GET /api/blog/posts/:slug`
- `GET /api/docs` / `GET /api/docs/:slug`

Both render Markdown server-side with frontmatter, reading-time estimation,
and DOMPurify sanitization.
