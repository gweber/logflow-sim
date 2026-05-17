# Vendor mapping provenance

This directory tracks the **upstream sources** the SIEM-target plugin
mappings derive from. Each `mappings.ts` under `src/core/siem-targets/<id>/`
encodes a curated subset of its upstream reference — the snapshot lives
here so reviewers can verify what changed and from where.

The mappings themselves are TypeScript constants compiled into the
runtime; the files in this directory are reference material only and
are not loaded at runtime.

## Source inventory

| Plugin (`<id>`) | Upstream source | Snapshot location | Version pinned |
|---|---|---|---|
| **(pivot) OCSF** | <https://schema.ocsf.io/1.5.0/> | (browser-only schema viewer; no fetchable JSON dump used by this project) | 1.5.0 |
| `splunk` | <https://docs.splunk.com/Documentation/CIM/latest/User/Overview> + <https://github.com/splunk/ocsf-content> | (curated by hand in `mappings.ts`) | CIM latest as of 2026-05 |
| `elastic-ecs` | <https://www.elastic.co/guide/en/ecs/8.17/> | (curated by hand) | ECS 8.17 |
| `elastic-ecs` (crosswalk) | <https://docs.aws.amazon.com/security-lake/latest/userguide/open-cybersecurity-schema-framework.html> | (referenced in commit log) | AWS Security Lake 2026-04 |
| `datadog` | <https://docs.datadoghq.com/logs/log_collection/> + <https://docs.datadoghq.com/api/latest/logs/> | (inline in `mappings.ts`) | docs as of 2026-05 |
| `loki` | <https://grafana.com/docs/loki/latest/get-started/labels/> | (inline) | Loki 2.x guidance |
| `graylog-gelf` | <https://go2docs.graylog.org/current/getting_in_log_data/gelf_format.html> | (inline) | GELF 1.1 |
| `microsoft-sentinel` | <https://learn.microsoft.com/azure/azure-monitor/logs/custom-logs-overview> + <https://learn.microsoft.com/azure/sentinel/data-connectors-reference> | (inline) | Azure docs 2026-05 |
| `sumo-logic` | <https://help.sumologic.com/docs/send-data/hosted-collectors/http-source/> + <https://help.sumologic.com/docs/manage/fields/> | (inline) | Sumo docs 2026-05 |
| `chronicle-udm` | <https://cloud.google.com/chronicle/docs/reference/udm-field-list> | (inline) | UDM reference 2026-05 |
| `qradar-leef` | <https://www.ibm.com/docs/en/dsm?topic=overview-leef-event-components> | (inline) | LEEF 2.0 |
| `arcsight-cef` | ArcSight CEF Implementation Standard (OpenText) | (inline) | CEF 0 |

## How to refresh a mapping

When upstream documentation changes:

1. Re-read the upstream reference (URL in the table above).
2. Edit `src/core/siem-targets/<id>/mappings.ts`. Keep the comment
   header pointing at the URL + the date the snapshot was taken.
3. Run `npm test` — the per-plugin tests verify round-trip integrity.
4. Submit a PR describing what changed in the upstream vocabulary
   (added classes, renamed fields, deprecated values).
5. Bump the version reference in this README's table.

There is intentionally **no automated scraper** that pulls upstream
JSON into a TypeScript constant — most of the schemas above are
human-curated documentation pages that don't expose machine-readable
exports we can blindly track. The `mappings.ts` file is small enough
(a few dozen entries per plugin) that hand-curation is the right
trade-off; a scraper would let bad upstream changes propagate silently.

## Adding a new SIEM target

See `content/docs/siem-targets.md` for the architectural overview.
Brief recipe:

1. `mkdir src/core/siem-targets/<new-id>/`
2. Create `mappings.ts` — declare `FIELD_MAP` and at least one `ValueMap`.
3. Create `index.ts` — export a `SIEMTarget` object literal referencing
   the maps + a `rendering` choice from `'json' | 'gelf' | 'leef' | 'cef' | 'udm' | 'passthrough'`.
4. Register it in `src/core/siem-targets/registry.ts`.
5. (Optional) Add validation rules in `src/core/validate/rules/siem-target-rules.ts`.
6. Add the upstream provenance row to the table above.
7. Write tests under `test/siem-targets/<new-id>.test.ts`.

## License of derived content

The OCSF schema is Apache-2.0. Elastic ECS is Apache-2.0. Datadog
docs are copyrighted but the field names themselves aren't (functional
identifiers). Splunk CIM is documented in Splunk's docs (copyright Splunk).
GELF spec is documented by Graylog. The other vendors' field names
are similarly facts-about-products.

logflow-sim's mapping tables encode **factual correspondences**
(Splunk sourcetype `linux:secure` corresponds to OCSF
AUTHENTICATION class) which are not subject to copyright. The
*description text* in `mappings.ts` is our own, MIT-licensed under
the project license.
