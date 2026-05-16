# Third-Party Notices

This file lists third-party content, trademarks, and prior art that
logflow-sim references, depends on, or visibly bundles. Each entry
documents what we use, where it lives, and under which license.

---

## Trademarks

The following are trademarks of their respective owners. logflow-sim
**parses, simulates, and converts between** their configuration
languages — it is **not affiliated with, endorsed by, or maintained
by** any of these projects:

| Trademark | Owner |
|---|---|
| **rsyslog**, **RainerScript** | Adiscon GmbH and the rsyslog community |
| **syslog-ng** | Axoflow / One Identity LLC |
| **Fluent Bit**, **Fluentd** | The Fluentd / Fluent Bit projects (Cloud Native Computing Foundation) |
| **NXLog** | NXLog Ltd. |
| **Logstash**, **Elasticsearch**, **Filebeat** | Elastic NV |
| **Vector** | Datadog, Inc. |
| **OpenTelemetry**, **OpenTelemetry Collector**, **OTel** | The OpenTelemetry project (Cloud Native Computing Foundation) |
| **Promtail**, **Loki**, **Grafana** | Grafana Labs |
| **Sigma**, **SigmaHQ** | The SigmaHQ community |
| **Splunk** | Splunk Inc. |
| **Wireshark**, **tcpdump**, **libpcap** | The Wireshark Foundation / The Tcpdump Group |
| **GitHub**, **GitHub Actions** | GitHub, Inc. (a Microsoft subsidiary) |
| **MCP**, **Model Context Protocol** | Anthropic PBC |
| **Claude**, **Claude Desktop** | Anthropic PBC |
| **netverdict.io** | The netverdict.io project (the maintainer's own brand) |

Trademark holders did not review logflow-sim's translation of their
configuration languages. Cross-dialect emit is best-effort and may
produce configurations that don't reflect the upstream project's
preferred idioms.

---

## Bundled third-party content

### Sigma rule catalog (`src/ui/lib/sigma-catalog.ts`)

Hand-crafted detection rules **patterned after** SigmaHQ community
rules but written from scratch for the in-browser demo. Each entry
carries a synthetic UUID (not a SigmaHQ-issued one) to prevent
confusion with upstream IDs. If we ever import verbatim SigmaHQ rules,
they ship under the [Detection Rule License (DRL) 1.1](https://github.com/SigmaHQ/Detection-Rule-License)
and must be attributed accordingly.

### Test fixtures — pcap files (`test/fixtures/pcap/`)

Two captures sourced from the public Wireshark sample-capture pool
linked from [Wireshark Issue 15607](https://gitlab.com/wireshark/wireshark/-/issues/15607)
(syslog dissector RFC 3164 / 5424 test material). Used here solely
to exercise the pcap-parser test path. Wireshark sample captures are
contributed by their respective authors under the licenses listed on
the [SampleCaptures wiki](https://wiki.wireshark.org/SampleCaptures).

### Test corpus — real-world configs (`test/corpus/`)

A regression suite of ~30 real-world rsyslog, syslog-ng, Fluent Bit,
Logstash, NXLog, and Vector configurations fetched verbatim from
public sources (distro defaults, large open-source projects). Each
file's provenance is recorded in
[`test/corpus/SOURCES.md`](test/corpus/SOURCES.md). The configs are
covered by their original project's license; logflow-sim's tests use
them only as parser input — we don't redistribute as artifacts.

### Loghub Linux dataset (referenced by `scripts/replay-loghub.sh`)

The script fetches ~25,000 real `/var/log/messages` lines from the
Loghub research dataset at
[Zenodo 8196385](https://zenodo.org/records/8196385) on first run.
Loghub is published by Tsinghua University and HKUST under terms
stated on the Zenodo record. The dataset is **not committed** to this
repository.

### Fonts

The hosted UI loads **Inter** and **JetBrains Mono** from Google
Fonts. Inter is by Rasmus Andersson (SIL Open Font License 1.1);
JetBrains Mono is by JetBrains s.r.o. (also SIL OFL 1.1). Both can be
self-hosted to avoid the third-party request.

---

## Runtime dependencies

Production npm dependencies (and their licenses, all permissive):

- `express` — MIT
- `fast-glob` — MIT
- `gray-matter` — MIT
- `isomorphic-dompurify` — Apache-2.0 / MPL-2.0 (DOMPurify upstream)
- `js-yaml` — MIT
- `marked` — MIT
- `smol-toml` — MIT

The transitive dependency graph is what `npm install --omit=dev` pulls
in. Run `npm ls --omit=dev --all` for the full tree, or
`npm audit --omit=dev` for known vulnerabilities. As of the initial
commit, prod-deps reported `found 0 vulnerabilities`.

Devtime dependencies (build/test only, not shipped at runtime) live
in `package.json` under `devDependencies` — all MIT or Apache-2.0.

---

## Contribution licensing

By submitting a pull request you agree your contribution is released
under this repository's [LICENSE](LICENSE) (MIT). We don't operate a
separate CLA — the MIT license terms apply automatically to every
patch that lands.

Translations contributed for `src/ui/i18n/locales/*.json` are
considered creative work and fall under the same license. The
contributor is credited in the git history; the project does not
claim moral-rights waivers beyond what MIT requires.

---

## Reporting trademark / licensing concerns

If you represent a project listed above and want a change in how we
reference or describe it, please open an issue or email
<security@netverdict.io>. We aim to address legitimate concerns
within 14 days and will work in good faith to find a fix that
respects your project's identity without breaking the simulator's
explanatory function for end users.
