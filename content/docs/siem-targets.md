---
title: SIEM targets (retag your destination vocabulary)
order: 4
---

# SIEM destination targets

logflow-sim's pipeline-tool dialect axis answers the question "what
syntax does this routing config use" — rsyslog vs. syslog-ng vs.
Vector vs. ten others. The **SIEM target axis** answers the
orthogonal question: "where do the events ultimately land and what
vocabulary does that destination expect?"

Today the pipeline-conversion (`convert`) and standalone retag
(`retag`) flows know both axes, so you can translate a config along
either dimension or both at once:

- Pipeline only: rsyslog → Vector (existing behaviour)
- Destination only: Splunk-style sourcetypes → ECS event.category (new)
- Both: rsyslog+Splunk → Vector+Datadog (the cross-product)

## Supported targets

| ID | Vendor | Wire format | Primary taxonomy |
|---|---|---|---|
| `generic` | — | passthrough | (none — passthrough) |
| `splunk` | Splunk | JSON (HEC) | `sourcetype` (`linux:secure`, `nginx:access`, …) |
| `elastic-ecs` | Elastic | JSON (ECS) | `ecs.event.category` (authentication, network, web, …) + `ecs.event.type` |
| `datadog` | Datadog | JSON (Intake API) | `ddsource` (ssh, nginx, kubernetes, …) |
| `loki` | Grafana Labs | JSON (Push API) | `loki.label` (low-cardinality job/service labels) |
| `graylog-gelf` | Graylog | GELF 1.1 | `gelf.facility` (auth, mail, kern, local0..7, …) |
| `microsoft-sentinel` | Microsoft | JSON (DCR) | `sentinel.table` (`SyslogAuth_CL`, `SecurityEvent`, …) |
| `sumo-logic` | Sumo Logic | JSON (HTTP source) | `sumo.sourceCategory` (`prod/linux/auth`, …) |
| `chronicle-udm` | Google | UDM JSON | `udm.event_type` (USER_LOGIN, NETWORK_DNS, …) |
| `qradar-leef` | IBM | LEEF 2.0 (pipe) | `leef.eventId` (LOGIN_SUCCESS, FW_DENY, …) |
| `arcsight-cef` | OpenText | CEF 0 (pipe) | `cef.eventClassID` (auth.login.success, firewall.deny, …) |

## Ingest × output coverage matrix

The 10 pipeline dialects (left axis) cross with the 11 SIEM destinations
(top axis) for 110 routing-and-vocabulary combinations. **Every cell
works** — the OCSF pivot makes the value rewriting dialect-agnostic and
the wire-format renderer is chosen by the target SIEM, not the source
dialect. The matrix below documents the **path** each combination takes:

| Dialect ↓ \ SIEM → | splunk | elastic-ecs | datadog | loki | graylog-gelf | microsoft-sentinel | sumo-logic | chronicle-udm | qradar-leef | arcsight-cef |
|---|---|---|---|---|---|---|---|---|---|---|
| **rsyslog**        | `omsplunkhec` | `omelasticsearch` | `omhttp`→ | `omhttp`→ | `omfwd`+GELF | `omhttp`→ | `omhttp`→ | `omhttp`→ | `omfwd`+LEEF | `omfwd`+CEF |
| **syslog-ng**      | `http()`→ | `elasticsearch-http()` | `http()`→ | `http()`→ | `gelf()` | `http()`→ | `http()`→ | `http()`→ | `syslog(LEEF)` | `syslog(CEF)` |
| **Fluent Bit**     | `splunk` | `es` / `elasticsearch` | `datadog` | `loki` | `gelf` | `azure_logs_ingestion` | `http`→ | `http`→ | `syslog`+LEEF | `syslog`+CEF |
| **NXLog**          | `om_http`→ | `om_elasticsearch` | `om_http`→ | `om_http`→ | `om_udp`+GELF | `om_http`→ | `om_http`→ | `om_http`→ | `om_udp`+LEEF | `om_udp`+CEF |
| **Logstash**       | `splunk` | `elasticsearch` | `datadog_logs` | `loki` | `gelf` | `microsoft-sentinel-logstash` | `sumologic` | `google_cloud_chronicle` | `syslog`+LEEF | `syslog`+CEF |
| **Vector**         | `splunk_hec_logs` | `elasticsearch` | `datadog_logs` | `loki` | `socket`+gelf | `azure_monitor_logs` | `sumo_logic` | `gcp_chronicle_logging` | `socket`+LEEF | `socket`+CEF |
| **OTel**           | `splunk_hec` | `elasticsearch` | `datadog` | `loki` | `file`→GELF | `azuremonitor` | `sumologic` | `googlecloud` | `file`→LEEF | `file`→CEF |
| **Filebeat**       | `output`→ | `elasticsearch` ★ | `output`→ | `output`→ | `output`→ | `azure_logs_ingestion` | `output`→ | `output`→ | `output`→ | `output`→ |
| **Promtail**       | — | — | — | `clients` ★ | — | — | — | — | — | — |
| **Fluentd**        | `splunk_hec` | `elasticsearch` | `datadog` | `loki` | `gelf` | `azure_logs_ingestion` | `sumologic` | `google_cloud_chronicle` | `syslog`+LEEF | `syslog`+CEF |

### Legend

- **Plain driver name** (`splunk_hec`, `elasticsearch`, `loki`, …):
  the dialect ships a first-class output for this SIEM; logflow-sim
  emits config with that driver directly.
- **`→`** (e.g. `omhttp`→ or `http()`→): the dialect has no
  SIEM-specific driver — the config goes through a generic HTTP or
  syslog forwarder. logflow-sim emits the right URL / headers and
  flags `SIEM_FIELD_UNMAPPED` info diagnostics for anything that
  doesn't fit the canonical payload.
- **`+GELF` / `+LEEF` / `+CEF`**: the transport is a generic socket
  but the *payload* is rendered by logflow-sim's dedicated renderer
  for that wire format.
- **★** (canonical pairing): Promtail is the Loki push agent;
  Filebeat is Elastic's beats forwarder. Using either with their
  paired SIEM is the design intent.
- **—**: the dialect doesn't ship a sensible output for this
  destination. Promtail is single-purpose by design — converting *to*
  Promtail only makes sense with `--target-siem=loki`. For any other
  destination, use one of the general-purpose dialects (Vector,
  Fluent Bit, OTel, rsyslog).

### What "every cell works" means

OCSF acts as the lingua franca between source and target vocabularies.
A retag from Splunk-style `sourcetype=linux:secure` to
GELF-style `facility=auth` traverses:

```
splunk plugin → toOCSF(sourcetype, "linux:secure")
              → { class_uid: AUTHENTICATION }
              → graylog-gelf plugin → fromOCSF(gelf.facility, …)
              → "auth"
```

The path doesn't care which dialect parsed the source config. A retag
from `rsyslog+Splunk` to `Vector+GELF` and a retag from `syslog-ng+Splunk`
to `Vector+GELF` produce the same destination-vocabulary output —
they just emit different pipeline syntax around it.

The cells where logflow-sim emits a generic HTTP forwarder (the `→`
marks) still carry the rewritten payload. They produce a working
config; they just don't take advantage of any dialect-native plugin
that the target SIEM's official agent might prefer. For dialects with
dedicated plugins, those plugins are used in preference.

## How translation works (the OCSF pivot)

Every plugin maps its native vocabulary **to and from** the [Open
Cybersecurity Schema Framework (OCSF)](https://schema.ocsf.io). The
pivot keeps mapping effort at O(N) instead of O(N²) — adding a new
target plugin only needs one mapping table, not one per existing
target.

A retag step takes the source value, maps it to OCSF (e.g. Splunk
`linux:secure` → OCSF `AUTHENTICATION` class), then maps OCSF to the
target's native vocabulary (`AUTHENTICATION` → Datadog `ssh`, ECS
`authentication`, GELF `auth`, Sentinel `SyslogAuth_CL`, …).

When a value can't be classified into a known OCSF class, it flows
through with a `SIEM_VALUE_LOSSY` info-level diagnostic and the
original value is preserved verbatim. No silent loss.

## Auto-detection

When a model contains outputs whose `driver` matches a SIEM target's
`outputDrivers` list (`splunk_hec` → splunk, `elasticsearch` →
elastic-ecs, `datadog_logs` → datadog, etc.), the kernel
auto-detects the source SIEM. If detection confidence is below
0.6, the kernel falls back to `generic` and emits a warning
(`SIEM_SOURCE_UNDETECTED`) — pass `sourceSiem` explicitly when
auto-detection isn't reliable.

## Taxonomy tagging on lookup tables

Lookup tables get a `taxonomy` annotation that drives value
rewriting. Auto-inferred at parse time when a structured-field
assignment makes the table's role obvious:

```rsyslog
# This assignment auto-tags the "sourcetypes" lookup with
# taxonomy="sourcetype" — the retag step will rewrite its values
# when translating across SIEMs.
set $!sourcetype = lookup("sourcetypes", $programname);
```

Recognized structured-field names (case-insensitive):
`sourcetype` → `sourcetype`,
`event_category` / `event.category` → `ecs.event.category`,
`event_type` / `event.type` → `ecs.event.type`,
`ddsource` → `ddsource`,
`category` / `log_class` → `generic`.

Lookup tables consumed only by uncovered field names stay untagged
and flow through retag verbatim.

## Using the CLI

```bash
# Pipeline + SIEM retag in one go
logflow-sim convert ./rsyslog \
  --target=vector --source-siem=splunk --target-siem=elastic-ecs \
  --out-dir=./out

# Standalone retag — keep the pipeline syntax, only rewrite vocabulary
logflow-sim retag ./rsyslog \
  --source-siem=splunk --target-siem=datadog \
  --out-dir=./out

# Auto-detect source SIEM (falls back to "generic" with a warning if
# nothing scores ≥ 0.6 confidence)
logflow-sim retag ./rsyslog --target-siem=loki --out-dir=./out
```

## Using the API

```bash
# List registered targets
curl -s localhost:3000/api/siem-targets | jq

# Convert with SIEM retag
curl -s -X POST localhost:3000/api/convert \
  -H 'content-type: application/json' \
  -d '{"target":"vector","sourceSiem":"splunk","targetSiem":"datadog"}' \
  | jq .targetSiem,.diagnostics
```

## Using MCP

Two tools exposed:

- `logflow_convert` — pipeline + optional SIEM retag (same as before
  with new optional `sourceSiem` / `targetSiem` args)
- `logflow_retag` — destination-only translation, keeps the source
  dialect

Both tools take inline file content; no filesystem access from the
MCP server.

## Adding a new SIEM target

PRs welcome. Recipe:

1. `mkdir src/core/siem-targets/<id>/`
2. Create `mappings.ts` declaring a `FieldMap` (OCSF → native paths)
   and at least one `ValueMap` (taxonomy ID, native value → OCSF
   class).
3. Create `index.ts` exporting a `SIEMTarget` object with the maps,
   recognized output drivers, and a `rendering` choice
   (`json | gelf | leef | cef | udm | passthrough`).
4. Register in `src/core/siem-targets/registry.ts`.
5. (Optional) Add validation rules in
   `src/core/validate/rules/siem-target-rules.ts` for misuse
   detection specific to that destination.
6. Document the upstream provenance in `vendor/mappings/README.md`.
7. Add tests under `test/siem-targets/<id>.test.ts`.

The full architectural design lives in
[`/root/.claude/plans/`](../../) and the contract is documented in
[`src/core/siem-targets/types.ts`](../../src/core/siem-targets/types.ts).

## Known limitations

- No live SIEM connectivity / credential handling — outputs
  requiring tokens emit placeholders like `${SPLUNK_HEC_TOKEN}` plus
  a diagnostic. You wire the real credential in your deployment.
- ECS has hundreds of fields; we cover the most-used ~30. The rest
  flow via `unmapped` passthrough with `SIEM_FIELD_UNMAPPED` info
  diagnostics.
- OCSF is used as a *pivot model* — we don't validate emitted
  events against the full OCSF schema at runtime.
- LEEF / CEF rendering covers the spec but not vendor-specific
  extensions (CEF custom fields beyond cs1..cs6, LEEF v1.0
  back-compat).
- Sentinel DCR authentication flow is documented but not modelled
  — the emitted config writes table-shape correctly, you wire the
  AAD token in your environment.
- Chronicle UDM coverage is structural; full field mapping is
  out of scope for v0.2.0 — anything we don't model flows through
  `additional.fields[]`.
