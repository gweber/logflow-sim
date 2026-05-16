---
title: The CLI and the merge gate — log configs as first-class code
date: 2026-05-17
excerpt: Your application code goes through review, tests, and CI. Your log-pipeline config almost certainly doesn't. Here's what changes when you put it on the same footing.
tags: [cli, ci, github-actions, workflow, pre-commit]
---

# The CLI and the merge gate — log configs as first-class code

If you asked a senior engineer "how do you ship a backend change
safely?", the answer would be reflexive: small PRs, code review,
unit tests, integration tests, a CI pipeline that runs the lot, a
deployment process that can roll back.

If you asked the same person "how do you ship a log-pipeline change
safely?", the answer would usually be quieter. A senior teammate
eyeballs the diff. Maybe someone restarts the daemon on a canary
host. Maybe nobody does anything special at all.

This isn't because log pipelines are less important than application
code. Often the opposite — when they break, the consequences land on
audit, compliance, and the SOC, all groups that don't tolerate
silent breakage. The reason the workflow is quieter is structural:
the tooling has historically not existed.

logflow-sim ships a CLI and a GitHub Action that fix that. The
config-changing PR can have the same shape as the code-changing PR.
The same review, the same tests, the same CI gate, the same green
checkmark.

## What the CLI does

`logflow-sim` is the same engine as the web UI, exposed as a
command. The most useful invocations:

```bash
# Parse the config tree, run the validator, exit non-zero on errors
logflow-sim parse ./rsyslog --fail-on=errors

# Run a corpus of real syslog through it, report routing breakdown
logflow-sim replay ./rsyslog --lines=./test/corpus/15min-sample.log

# Compare two configs against the same corpus, exit non-zero if more
# than 5% of messages change routing
logflow-sim diff ./rsyslog --overlay-dir=./pr-rsyslog \
                           --lines=./test/corpus/15min-sample.log \
                           --max-route-change-pct=5

# Convert the config to another dialect, write the result to a directory
logflow-sim convert ./rsyslog --target=otel --out-dir=./otel-out
```

All commands respect a small set of conventions:
`--format=human|github|json` for output style, exit code 0 for
success, 1 for "diagnostics or threshold breached," 2 for "test
cases failed," 3 for "bad invocation."

These are the same conventions that make `npm test`, `go test`, and
`pytest` predictable. The CI runner doesn't have to know what
logflow-sim is — it knows what a process returning non-zero means.

## Three workflows that this enables

### 1. Pre-commit: catch the obvious before pushing

A pre-commit hook that runs `logflow-sim parse ./rsyslog
--fail-on=errors` takes a few seconds and catches the entire class
of "valid but broken" bugs we wrote about in
[the validation post](/blog/2026-05-17-validation-catches-broken-configs-early).
Undefined ruleset references, dead code, silently dropped paths —
all flagged before the commit lands locally.

This is the same as having an ESLint or `gofmt` hook on the
application code. Nobody thinks of those as remarkable; they should
be the same for config code.

### 2. CI on every PR: catch what the local hook missed

A GitHub Actions workflow that runs `logflow-sim parse` on every PR
produces inline annotations on the lines with diagnostics. The PR
author sees the warnings exactly where they introduced them. The
reviewer doesn't have to mentally validate the config from scratch
— the tool has already done the mechanical part.

Configuring it is a handful of YAML lines:

```yaml
- uses: gweber/logflow-sim@v1
  with:
    conf-path: ./rsyslog
    command: test
    fail-on: errors
```

If you want this as a required check, add it to your branch
protection rules. PRs with errors can't merge until the errors are
fixed or explicitly accepted.

### 3. The merge gate: refuse to ship routing changes that move too much traffic

This is the workflow with the highest leverage and the most
under-appreciated. A routing change that affects 0.1% of traffic
is probably refactoring. A routing change that affects 30% of
traffic is probably a mistake, and the reviewer is going to want
the author to walk them through the intent.

`logflow-sim diff` answers that question quantitatively. Run the
proposed change and the live config against the same corpus of real
syslog, count how many messages take different paths, and fail the
build if the delta exceeds a threshold:

```yaml
- uses: gweber/logflow-sim@v1
  with:
    command: diff
    conf-path: base/rsyslog
    overlay-dir: head/rsyslog
    lines: head/test/fixtures/replay-corpus.log
    max-route-change-pct: 5
    pr-comment: true
```

The action posts a comment on the PR with the verdict and a table
of per-output deltas:

> **logflow-sim diff verdict** — **127** of **25,567** messages
> change routing (**0.50%**) — within threshold.
>
> | kind | target | baseline | overlay | delta |
> |---|---|---:|---:|---:|
> | omfile | `/var/log/secure` | 4,996 | 5,123 | **+127** |
> | omfile | `/var/log/messages` | 11,497 | 11,370 | **−127** |

Now the conversation in the PR is concrete. "This refactor moves
127 messages from `/var/log/messages` to `/var/log/secure`. Is that
intentional?" The reviewer doesn't have to mentally simulate the
change to know what changed.

## Where the corpus comes from

The diff workflow needs a representative corpus to be useful. Three
practical sources:

1. **A short tcpdump capture** from a production-adjacent host
   (staging, a canary, a replica). Fifteen minutes is enough. The
   capture lives in the repo as a fixture; it doesn't have to be
   large.

2. **An export from your existing pipeline.** If your daemon already
   writes a "raw archive" of everything it receives, take a
   representative chunk of one day.

3. **A curated set of test cases.** Hand-written messages that
   exercise the routing decisions that matter. Lower bandwidth than
   a corpus, but much higher signal — and easier to maintain.

We wrote a full walkthrough of going from `tcpdump` to a working
CI gate in [the merge-gate
post](/blog/2026-05-16-tcpdump-to-merge-gate). The TL;DR: it's a
30-minute setup that protects every subsequent PR.

## What this isn't

It isn't a deployment tool. logflow-sim's CLI doesn't push configs
to hosts, doesn't restart daemons, doesn't talk to your config
management system. That's deliberate — deployment is a much
larger problem with much more variation, and the right answer
depends on whether you use Ansible, Puppet, Chef, raw SSH, a
custom in-house orchestrator, or something else.

The CLI gives you the **validation and routing-equivalence**
guarantees that your deployment tool can then act on. "The new
config parses, has no validator errors, and doesn't move more than
5% of traffic" is the kind of assertion you can build a deployment
pipeline around.

## The shift

The thing this all adds up to: treating log configs as code that
goes through the same pipeline as your application code. Reviewed,
tested, validated, gated. Not because log configs are special, but
because they aren't — and they shouldn't be the one piece of your
production stack that ships without a CI gate.

## Try it

The fastest path is the GitHub Action — drop this into
`.github/workflows/`:

```yaml
- uses: gweber/logflow-sim@v1
  with:
    conf-path: ./rsyslog
    command: parse
    fail-on: errors
```

That gives you the validator on every PR with inline annotations.
Locally, clone the repo and build once:

```bash
git clone https://github.com/gweber/logflow-sim.git
cd logflow-sim && npm install && npm run build:server
node dist/cli/main.js parse /path/to/your-conf-dir
```

Once the CI signal is live, you can layer in the diff gate, the
detection-impact gate, and any other check that fits your team's
risk tolerance. Each one is incremental — none of them have to
land all at once.
