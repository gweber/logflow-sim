---
title: Migrate your SIEM, not just your pipeline
date: 2026-05-17
excerpt: "Switching from rsyslog to Vector is a five-line config change. Switching from Splunk to Elastic is a six-month project that nobody warned you about. We just added the half of the migration story that everyone forgets."
tags: [siem, migration, ocsf, splunk, elastic, datadog, loki]
---

# Migrate your SIEM, not just your pipeline

When a team says "we're moving from rsyslog to Vector," they almost
always mean two things at once.

One: they're moving the pipeline software — the daemon that listens
on :514, evaluates filters, and ships events somewhere. That's a
syntactic translation. logflow-sim has handled it since v0.1.0 —
parse rsyslog's RainerScript, emit equivalent Vector TOML, surface
every translation caveat as a diagnostic. We wrote about it in the
[migration post](/blog/2026-05-17-migration-without-rewriting).

Two: they're moving where the events ultimately land. Maybe Splunk
to Elastic. Maybe an on-prem ELK stack to Datadog. Maybe the SRE
team picked Loki for its dev environments and now the security
team's Splunk dashboards need to keep working until the cutover.
That's a **vocabulary** translation — the destination has its own
field names, value taxonomies, classification conventions, and
the events you're emitting have to speak that vocabulary or they
land in the destination's catch-all bucket.

The pipeline migration is what tools talk about. The SIEM-
destination migration is what makes the project take six months.

## The vocabulary problem

Take a single routing decision: classify incoming auth-related logs
so the SIEM can pre-process them.

In a Splunk-flavored rsyslog config it looks like this:

```rsyslog
set $!sourcetype = lookup("sourcetypes", $programname);
# table contains: "sshd" → "linux:secure", "sudo" → "linux:secure", …
```

In an ECS-flavored Vector config it looks like this:

```toml
[transforms.classify]
type = "remap"
source = '''
.event.category = ["authentication"]
.event.dataset = "system.auth"
'''
```

In a Datadog-flavored config it's:

```yaml
processors:
  - rename:
      target: ddsource
      source: programname
# with a mapping table: "sshd" → "ssh", "sudo" → "sudo"
```

In Graylog GELF it's `facility=auth`. In Loki it's a label
`{service="auth"}`. In Sentinel it's a custom-log table named
`SyslogAuth_CL`. Same routing decision, six different vocabularies.

Most teams discover this *after* they've translated the pipeline
syntax. The Vector config compiles, the daemon starts, traffic
flows — and the SIEM dashboards stop firing because nothing knows
about `linux:secure` over there.

## What we shipped

logflow-sim v0.2.0 introduces a **SIEM target plugin axis**
orthogonal to the existing pipeline-dialect axis. The migration
flow now translates both at once, or either one independently:

```bash
# Both axes at once
logflow-sim convert ./rsyslog \
  --target=vector --source-siem=splunk --target-siem=elastic-ecs \
  --out-dir=./out

# Destination-only (keep the pipeline syntax, just rewrite vocabulary)
logflow-sim retag ./rsyslog \
  --source-siem=splunk --target-siem=datadog \
  --out-dir=./out
```

Behind the scenes, every SIEM target plugin maps to and from the
[Open Cybersecurity Schema Framework](https://schema.ocsf.io) —
the vendor-agnostic taxonomy backed by Splunk, AWS, IBM, and 15+
others. OCSF acts as a pivot: each plugin only needs to translate
to/from one canonical schema, not to every other plugin
individually. Adding a new SIEM target is one mapping table, not
N tables for N existing targets.

When a value can't be classified into a known OCSF class, it flows
through with a `SIEM_VALUE_LOSSY` info-level diagnostic and the
original value is preserved verbatim. No silent loss. The operator
sees exactly which values need a human review.

## The 11 destinations shipping in v0.2.0

| Target | Vendor | Typical wire format |
|---|---|---|
| `generic` | — | passthrough |
| `splunk` | Splunk | JSON over HEC |
| `elastic-ecs` | Elastic | JSON (ECS field paths) |
| `datadog` | Datadog | JSON (Intake API) |
| `loki` | Grafana Labs | JSON (push API) + low-card labels |
| `graylog-gelf` | Graylog | GELF 1.1 |
| `microsoft-sentinel` | Microsoft | JSON over DCR |
| `sumo-logic` | Sumo Logic | JSON over HTTP source |
| `chronicle-udm` | Google | UDM JSON |
| `qradar-leef` | IBM | LEEF 2.0 (pipe-delimited) |
| `arcsight-cef` | OpenText | CEF 0 (pipe-delimited) |

Across these, the kernel covers JSON, GELF, LEEF, CEF, and UDM
wire formats with dedicated renderers — so a retag isn't limited
to "rewrite some strings" but actually produces a payload in the
destination's preferred shape.

## Auto-detection + escape hatch

When a config contains outputs whose drivers obviously target one
SIEM (`splunk_hec`, `elasticsearch`, `datadog_logs`,
`azuremonitor`, …), the kernel infers the source SIEM
automatically. When inference doesn't reach 60% confidence, we
fall back to `generic` and emit a warning — that's the explicit
"don't guess" signal.

The `generic` target is a passthrough: every value flows through
unchanged. It's there for the cases where you genuinely don't
want any value rewriting, and as the safe default when detection
fails.

## Per-destination validation

Each SIEM target ships its own validation rules — the kind of
misconfigurations that compile fine but break at the destination:

- `splunk/missing-sourcetype` — HEC output with no `sourcetype`
  param and no upstream `set $!sourcetype = …`. Events land in
  `_unknown` and bypass field extractions.
- `elastic-ecs/missing-event-dataset` — Elastic output without
  `event.dataset`. Index-routing falls back to the catch-all.
- `loki/high-cardinality-label` — a label sourced from `user`,
  `trace_id`, or another high-cardinality field. Explodes the
  index.
- `graylog-gelf/custom-field-prefix` — a non-reserved custom
  field without the `_` prefix. Graylog drops it silently.
- `microsoft-sentinel/invalid-table-name` — custom-log table name
  doesn't match the `*_CL` regex Azure requires.
- `arcsight-cef/severity-range` — severity outside the 0..10
  CEF range.
- … and several more.

These rules run automatically when an output is tagged with a
specific SIEM, so the diagnostics only appear when they matter.

## What this doesn't do

**It doesn't talk to your SIEM at runtime.** No bearer tokens get
loaded, no test events get pushed. The output is a *config* that,
when deployed, will produce the right shape on the wire — but
deployment + credentials remain your environment's problem.

**It doesn't claim full ECS / UDM / OCSF coverage.** ECS has
hundreds of fields; we cover the most-used ~30. UDM has its own
hundreds; the renderer routes mapped fields into the right groups
and ships everything else under `additional.fields[]`. The
diagnostics surface exactly what got mapped and what didn't.

**It doesn't make the migration painless.** It makes the
mechanical 80% mechanical, so the team can spend its time on the
20% that genuinely requires judgment — the rules that don't
translate cleanly, the SIEM-specific dashboards that need to be
rebuilt, the alerting that needs to be reconnected. We're
removing the "we ran out of time on the easy stuff" failure mode,
not the "this is real engineering work" reality.

## Try it

The [/migrate](/migrate) page now has a progressive-disclosure
"Also retag SIEM destination →" section below the existing
dialect picker. Click it open, pick a target SIEM, run the
conversion — the result panel shows you both the pipeline-side
translation and any destination-vocabulary diagnostics.

Or use the CLI:

```bash
git clone https://github.com/gweber/logflow-sim
cd logflow-sim && npm install && npm run build:server

node dist/cli/main.js retag conf-demo \
  --source-siem=splunk --target-siem=elastic-ecs \
  --out-dir=/tmp/ecs --force
```

The bundled `conf-demo` now ships three parallel lookup tables —
Splunk sourcetypes, generic categories, ECS event.category — so
you can see the multi-axis translation working out of the box.

## What's next

Direct user-feedback paths:

- A SIEM target you need that we don't ship?
  [File an issue](https://github.com/gweber/logflow-sim/issues).
  Adding a new target is one mapping file, one plugin file, and
  (optionally) one validation-rule file. The recipe is in
  [`vendor/mappings/README.md`](https://github.com/gweber/logflow-sim/tree/main/vendor/mappings).
- An OCSF class mapping that looks wrong?
  Same — PRs against the `mappings.ts` files are how the
  vocabulary gets refined.

The orthogonal axis was always there. We just made it
addressable.
