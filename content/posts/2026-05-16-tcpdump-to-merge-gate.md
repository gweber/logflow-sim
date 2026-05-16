---
title: From `tcpdump` to merge-gate in five minutes
date: 2026-05-16
excerpt: How to turn 15 minutes of real production syslog into a CI gate that blocks rsyslog PRs which would silently re-route your traffic.
tags:
  - workflow
  - github-actions
  - rsyslog
  - replay
  - diff
---

# From `tcpdump` to merge-gate in five minutes

The pitch: every rsyslog (or syslog-ng, or Vector, …) routing change
should be replayed against real production traffic **before** it merges,
and the PR comment should tell you exactly how the routing differs.
Below is the five-step walkthrough — start to finish on a sample
config you can copy.

## Step 1 — Capture 15 minutes of real traffic

Run this on the host that receives your syslog stream. It writes a
pcap (any tcpdump-compatible format works — classic libpcap or pcapng).

```bash
# 15 minutes, all syslog ports, write to disk
sudo tcpdump -i any -w syslog-15min.pcap \
  -G 900 -W 1 \
  '(udp or tcp) and (port 514 or port 6514 or port 601)'
```

Inspect what you caught:

```bash
sudo tcpdump -r syslog-15min.pcap | head
```

If the pcap is sensitive (real source IPs, hostnames in the payload),
anonymize it with `tcprewrite` or strip payload entropy before
committing. For internal-only repos the raw capture is usually fine.

## Step 2 — Commit it as a test fixture

```bash
cp syslog-15min.pcap test/fixtures/replay-corpus.pcap
git add test/fixtures/replay-corpus.pcap
git commit -m "test: add 15-min replay corpus from prod collector"
```

About 10 MB for 15 minutes of medium-volume traffic is typical.
Anything under 100 MB lives comfortably in a git repo; if your traffic
is heavier than that, hash-check it into Git LFS instead.

## Step 3 — Add the workflow

Drop this into `.github/workflows/logflow-diff.yml`:

```yaml
name: Diff rsyslog routing

on:
  pull_request:
    paths:
      - 'rsyslog/**'
      - 'test/fixtures/replay-corpus.pcap'

permissions:
  contents: read
  pull-requests: write   # for the sticky PR comment

jobs:
  diff:
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
          pcap: head/test/fixtures/replay-corpus.pcap
          max-route-change-pct: '5'
          pr-comment: 'true'
```

`max-route-change-pct: 5` is the strict version — the job exits red if
more than 5% of replayed messages would route differently after the
PR. Tune to taste.

## Step 4 — Open a PR that breaks something

For demonstration, comment out one line in your sourcetype lookup:

```diff
 {
   "sshd": "linux:secure",
-  "sshd(pam_unix)": "linux:secure",
+  // "sshd(pam_unix)": "linux:secure",
   "cron": "linux:cron"
 }
```

Open the PR. Within ~20 seconds the action posts a sticky comment:

> **logflow-sim diff verdict**
>
> **2,138** of **25,567** messages change routing (**8.36%**) ·
> moved-to-delivered: **+0** · moved-to-unmatched: **+0**
>
> Overlay: `rsyslog/lookups/sourcetypes.json`
>
> | kind | target | baseline | overlay | delta |
> |---|---|---:|---:|---:|
> | `omfile` | `/var/log/syslog/linux:secure/` | 4,996 | 2,858 | **−2,138** |
> | `omfile` | `/var/log/syslog/syslog/` | 11,497 | 13,635 | **+2,138** |
>
> #### Sample route changes
> - `sshd(pam_unix)` @ `web-01`
>   - baseline: `omfile:/var/log/syslog/linux:secure/web-01/2026-…`
>   - overlay:  `omfile:/var/log/syslog/syslog/web-01/2026-…`

The job exits red (`max-route-change-pct: 5` was exceeded). Merge
blocked. The PR author sees that the seemingly-tiny comment line
re-routes 8.36% of authpriv traffic away from the SIEM bucket that
their detection rules look at.

## Step 5 — Catch the silent footguns

Diff is one CI gate; the parser-validator is another. Add a parallel
job that just runs `parse` with `--fail-on=warnings`:

```yaml
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gweber/logflow-sim@v1
        with:
          command: parse
          conf-path: rsyslog
          fail-on: warnings
```

That trips on:
- A new `input(type="imtcp" ...)` declared without `module(load="imtcp")` —
  rsyslog silently won't bind the listener.
- A `template="JsonForElastic"` referenced by an action where no
  `template(name="JsonForElastic" ...)` is declared.
- A ruleset whose tail is an `if` without `else` — messages on the
  fall-through path are silently dropped.

Both checks live in the same Action; you can split them across two
jobs (so a routing-impact regression doesn't block a typo fix) or
keep them serial for stricter merge discipline.

## What it costs

Compute is trivial — replaying 25k messages through the simulator
takes ~1.5 seconds on a default GitHub runner. The dominating cost
is keeping a fresh-enough replay corpus committed; rotate it every
few weeks if your traffic shape changes.

## What it doesn't do

This is **routing-impact** analysis, not **detection-rule-impact**.
If you also want to know whether your Splunk / Elastic / Sentinel
detection rules will fire less often after a routing change, see
[`detection-impact`](/docs/api#detection-rule-coverage) — same
pattern, takes Sigma rules as input.

---

Live demo: try the verdict against the bundled demo config at
[netverdict.io/logflow/diff](https://netverdict.io/logflow/diff).
Then flip the dialect picker to OpenTelemetry to see the same routing
re-emitted as an OTel Collector config you could deploy as the
migration target.
