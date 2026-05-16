---
title: Migrate to a new log pipeline without rewriting from scratch
date: 2026-05-17
excerpt: "Your team has decided: rsyslog out, Vector in. Or syslog-ng out, Fluent Bit in. The current config is 2,000 lines of accumulated knowledge. How do you not lose it?"
tags: [migration, vector, rsyslog, syslog-ng, fluent-bit]
---

# Migrate to a new log pipeline without rewriting from scratch

There's a moment every infra team has lived through. Someone — maybe
the new SRE lead, maybe a quarterly tech-strategy slide — proposes
moving the log pipeline off the current tool onto the shiny new one.
Vector. Fluent Bit. OpenTelemetry Collector. Whatever has the most
mindshare this season.

The technical argument is usually sound. The political argument is
sometimes sound. But there's always one nagging question:

> What about the 2,000 lines of `rsyslog.conf` we've accumulated over
> eight years? The weird `if $msg contains "OOM" then` rule the
> Postgres team relies on? The lookup table that maps every retired
> hostname to its successor? The forwarder to that ancient SIEM that
> only the security team remembers exists?

That config is institutional knowledge encoded in a language nobody
on the team particularly wants to translate by hand.

## The two failure modes of "rewrite from scratch"

When migrations skip the translation step and go straight to "let's
just rebuild it the right way," one of two things tends to happen.

**Mode 1: Quiet feature loss.** The new config covers 90% of what the
old one did. The remaining 10% is the long tail of edge cases. They're
not caught until a quarter later, when someone notices a customer's
audit log is missing entries, or a compliance check fails because a
specific facility stopped reaching the archive bucket. The team has
spent four months on the migration and is still finding gaps.

**Mode 2: Endless dual-running.** The team is too cautious to cut over,
so both pipelines run side by side "for a while." A while becomes a
year. The new pipeline gets less attention than the old one because
the old one is what people actually trust. Eventually someone is paid
to remove the migration entirely.

## What the Migration page does

logflow-sim's Migration page takes the parsed model of your current
config — whichever of the ten supported dialects it's in — and emits
an equivalent config in the target dialect. Concretely:

- Every input, ruleset, conditional, action, lookup, and template gets
  translated to its target-dialect counterpart where one exists.
- Anything that **can't be cleanly translated** is flagged with a
  human-readable note, with the source location of the original line.
  No silent loss.
- The output is a runnable starting point, not a finished product.
  You'll still need to read the diagnostics, decide whether each
  caveat matters for your environment, and write the bits the source
  language can express but the target can't.

That last point matters. Some translations are lossless — an
rsyslog `if $hostname == "foo"` maps cleanly to a syslog-ng
`host("foo")` filter. Others are inherently lossy — Vector's
transform-based model handles a rsyslog `unset` differently because
Vector doesn't have mutable variables in the same way. Where the
mapping is approximate, we say so.

## The point isn't to skip the work — it's to skip the wrong work

A from-scratch rewrite spends most of its hours on the easy 90%: the
inputs, the basic routing, the simple file outputs. That's the part a
translator can do reliably in a few seconds.

A translator-then-review workflow spends those same hours on the
hard 10%: the rules the source language expresses elegantly and the
target language doesn't, the edge cases nobody documented but
everyone relies on, the institutional knowledge that needs to be made
explicit before it can be moved.

Same total effort, but spent where humans actually add value.

## When this isn't the right tool

The Migration page is built for **routing translation**, not for
re-architecting your observability strategy. If you're moving from
"every host runs rsyslog locally and forwards to a central server" to
"every container has a Fluent Bit sidecar emitting structured logs to
S3," the topology change is a strategic decision that no translator
can make for you. logflow-sim will help with the per-config parts of
that decision, but it can't redesign the shape of the pipeline.

It also can't handle config you haven't given it. If half your routing
lives in Ansible templates that haven't been rendered yet, render them
first and feed the result in.

## Try it

Open the [Migration page](/migrate), pick a target dialect, and look
at the output and the diagnostics. The "translation caveats" are
where to spend your reading time — that's the 10% that determines
whether the migration is honest or quietly broken.
