---
title: Ten log dialects, one simulator
date: 2026-05-17
excerpt: rsyslog, syslog-ng, Fluent Bit, NXLog, Vector, Logstash, OpenTelemetry, Filebeat, Promtail, Fluentd. One UI, one mental model. Stop context-switching every time a team rebuilds their pipeline.
tags: [dialects, multi-vendor, overview]
---

# Ten log dialects, one simulator

If your organisation has been around for more than two years, your logs
probably do not travel through a single pipeline. The infra team runs
**rsyslog** on the bastion hosts. The Kubernetes team ships container
output via **Fluent Bit**. The Windows fleet uses **NXLog**. The
observability team is migrating everything to **Vector** "next quarter."
And somewhere in there, an ELK stack still has a **Logstash** receiving
end that nobody quite wants to touch.

Every one of those tools has a different config language, different
mental model for routing, different way of expressing "send this to
that file but only when the hostname matches." When something goes
wrong, the on-call engineer needs to be fluent in whichever dialect
owns the problem this week.

## The cost of dialect-hopping

It's not just learning curve. It's the small daily friction:

- You can't reuse your debugging muscle memory between tools.
- Each tool's "let me just try it" workflow is different — some
  require a reload, some hot-reload, some only validate on startup.
- The vendor-specific tooling that ships with each (config-test,
  dry-run, lint) varies wildly in quality. Some have it, some don't.
- Documentation is fragmented across vendor docs, community wikis, and
  Stack Overflow answers from 2017.

The result: when a real incident hits, the engineer who knows the
right dialect happens to be on PTO, and the rest of the team is one
Google search behind every step.

## What logflow-sim does about it

logflow-sim parses **all ten** dialects with the same engine and
normalises them into one vendor-neutral model. From there, the rest of
the UI doesn't care which dialect you started with. The simulator,
replay, diff, validation, detection-impact, and migration views all
work the same way regardless of whether you fed it `rsyslog.conf` or
`vector.toml` or `fluent-bit.yaml`.

Concretely, here's what that means in practice:

**You don't have to remember which UI tab is which.** Whether you're
debugging a Fluent Bit DaemonSet routing issue or a stubborn rsyslog
include, you open the simulator, paste a sample message, and read the
same trace timeline. The questions you'd ask ("which rule matched?
which lookup table was hit? where did the message end up?") get the
same answer-shape every time.

**You can compare across dialects.** When the Vector migration finally
lands on your team's quarter, you can open the existing rsyslog config
and the proposed Vector config side-by-side, replay a real syslog batch
through both, and see whether anything moved in a way you didn't
expect. We dive into that workflow in the [tcpdump-to-merge-gate
post](/blog/2026-05-16-tcpdump-to-merge-gate); the point here is that
the comparison only works because both sides land in the same
intermediate model.

**You can carry domain knowledge across tools.** Once you understand
how logflow-sim shows a "this rule dropped your log" decision in
rsyslog, you'll recognise the same pattern when you open a Vector
config. Different syntax, same explanation.

## What it doesn't do

We don't run your config. There's no `omfwd` actually sending traffic,
no Fluent Bit output plugin actually writing to S3. logflow-sim is a
**read-only simulator**: it tells you what *would* happen if you sent
this message through this config. The actual daemons remain the only
thing that can do the real work — and that's by design. Simulating
side effects is for explaining routing decisions, not for taking over
production.

We also don't pretend every dialect is fully covered. Some dialects
(rsyslog, syslog-ng) have years of edge cases; others (Promtail,
Filebeat) are newer additions and cover the common shapes but not
every esoteric option. The [parser limitations
page](/docs/limitations) is the honest list.

## Try it

Open the [config browser](/config) and switch the dialect picker in
the top-right. It auto-detects from the entrypoint, but you can force
any of the ten. Or upload your own config on the [Projects
page](/projects) and let auto-detection pick the right plugin.

If a dialect you care about is missing, file an issue — adding a new
dialect is a self-contained module with a clear interface, and we've
done it nine times now.
