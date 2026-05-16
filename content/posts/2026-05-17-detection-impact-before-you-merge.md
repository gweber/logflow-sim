---
title: Will this routing change break your SIEM? Detection-Impact before you merge
date: 2026-05-17
excerpt: Routing changes don't fail loudly. They fail by silently cutting your security visibility — until an incident reveals the gap. Detection-Impact lets you see, before the merge, which alerts a config change would have prevented.
tags: [security, detection, sigma, soc, replay]
---

# Will this routing change break your SIEM? Detection-Impact before you merge

Here's a scenario that has played out at more than one company.

The platform team is doing some perfectly reasonable cleanup. They
remove a forwarder that's been there for years, on the (correct)
basis that the destination has been decommissioned. The change is
small, the diff is two lines, the PR goes through review in fifteen
minutes.

Three weeks later, the security team is doing a post-incident review
and notices that a particular alert family hasn't fired in a month.
Not because nothing's happening — because the events that would have
triggered those alerts stopped reaching the SIEM somewhere around
that two-line PR.

The detection wasn't broken. The pipe to the detection was broken.

## Why this is so easy to miss

Most config-review processes are good at catching syntax errors and
obvious functional regressions. They are bad at catching **visibility
regressions** because:

- The alert doesn't fail. It just doesn't fire.
- Coverage is measured in negative space — what *would have* been
  detected if the event had been received.
- The team that owns the routing change (platform/infra) usually
  isn't the team that owns the detections (security). The PR reviewer
  doesn't know what they don't know.

Security teams have started compensating by writing "detection-as-code"
tests, but those run against synthetic events. They prove the
detection rule itself works. They don't prove the rule is being fed
real events from your real pipeline.

## What Detection-Impact does

The [Detection-Impact page](/detection) runs **Sigma detection rules
against a corpus of real (or representative) syslog**, replayed through
your config. Then, optionally, it runs the same corpus through a
second config — typically the proposed change — and shows the diff.

The output answers two practical questions:

1. **Of all the alerts that should fire on this corpus, which actually
   do under the current config?** That number is your baseline
   visibility. It tells you, for the events you have, what fraction
   you're catching.

2. **What changes if you adopt the proposed config?** Specifically:
   which detections gain coverage, which lose coverage, and which
   are unaffected.

The "lose coverage" column is the one nobody wants to publish in a
PR description. It's also the one that prevents the post-incident
review three weeks later.

## What you need to use it

Three pieces:

- **A corpus of representative syslog.** This can be a 15-minute
  `tcpdump` capture, an exported set from your existing pipeline, or a
  curated set of test events. The [tcpdump-to-merge-gate
  post](/blog/2026-05-16-tcpdump-to-merge-gate) walks through the
  fastest way to get one.
- **A Sigma rule set.** logflow-sim ships with a small catalog of
  hand-built rules patterned after the public SigmaHQ catalog (with
  synthetic UUIDs so they don't collide). You can also point it at
  your own rules.
- **Your config**, plus optionally the proposed config you want to
  compare against.

## What it doesn't do

It doesn't replace your SIEM. The matcher is intentionally simple —
it covers the most common Sigma constructs (selection blocks, list
matches, contains modifiers) but doesn't reproduce every edge case
of a production correlation engine. It's enough to detect routing
regressions, not enough to replace Splunk.

It also doesn't tell you about events you don't have. If your tcpdump
sample doesn't include an SSH brute-force, the tool won't flag that
your SSH brute-force detection might break. Corpus quality matters.

## The point: shift coverage testing left

Security teams have always wished routing changes were reviewed with
visibility in mind. logflow-sim's Detection-Impact is a way to make
that wish executable. A PR that breaks routing for an active
detection family should fail a CI check the way a PR that breaks unit
tests does.

Once that's in place, the conversation between platform and security
shifts. Instead of "we removed that forwarder six weeks ago and now
your alerts are quiet," it's "we'd like to remove this forwarder; the
CI report says we'd lose six detections — can you confirm those are
all going to other channels?"

That's a much better conversation to have **before** the merge.
