---
title: Catch broken log configs before they reach a daemon reload
date: 2026-05-17
excerpt: A syntactically valid config can still be broken in a dozen interesting ways — undefined rulesets, dead branches, lookup tables nobody loaded. Validation rules find these in your editor, not at 3 AM.
tags: [validation, rsyslog, syslog-ng, lint]
---

# Catch broken log configs before they reach a daemon reload

There's a category of bug specific to log pipelines that hides from
every conventional check.

The config parses. The daemon starts. No errors in the log on
reload. Everything *looks* fine. And yet, somehow, certain log lines
are getting dropped on the floor, or going to the wrong destination,
or hitting a lookup table that — silently — returns the empty string
for every key because the table file was never actually loaded.

These bugs share a structural property: they're **semantically wrong
inside a syntactically valid config**. The parser is happy. The
daemon is happy. The downstream consumer (your archive, your SIEM,
your alerts) is confused.

## A taxonomy of "valid but broken"

In the course of building logflow-sim, we ended up cataloguing the
specific shapes these bugs take. They cluster into a handful of
recognizable patterns:

- **Undefined ruleset references.** A `call rs_security` statement
  pointing at a ruleset that doesn't exist anywhere in the config
  tree. The daemon often silently ignores it.
- **Dead rulesets.** A ruleset that's defined but never bound to an
  input or called from another ruleset. Pure dead code, easy to
  forget about, and a sign that the routing intent has drifted from
  the actual routing.
- **Silent drops.** A conditional branch that catches a class of
  message and has no actions inside it — effectively a `if condition
  then { /* nothing */ }`. The message gets evaluated, the branch
  matches, and then... nothing happens. Looks intentional, often
  isn't.
- **Lookup tables not loaded.** A `lookup("table_name", $key)` call
  whose `table_name` was never registered via a `lookup_table(...)`
  declaration. Every lookup returns empty. The dependent routing
  silently breaks.
- **Undefined templates.** A `DynaFile="my_template"` action whose
  template was renamed three months ago and the action never
  followed.
- **Default ruleset pointing at nothing.** `$DefaultRuleset
  some_ruleset` where `some_ruleset` doesn't exist. The fallback
  route is the most important one — when it's broken, anything that
  falls through to it disappears.
- **Module not loaded.** Using `imtcp` inputs without ever having
  called `module(load="imtcp")`. Some daemons error on this, others
  warn-and-continue.

Each of these is a config that the parser will happily accept. Each
of them is something a careful human review *could* catch — but
careful humans are expensive, and they're not always assigned to
your routing-config PR.

## What validation rules do

logflow-sim has a small but growing library of validation rules,
each one targeting one of the patterns above. They run automatically
against any config it loads, and surface in two places:

- The [Config browser](/config) shows a Diagnostics panel with the
  full list, severity-filtered.
- The CLI / API returns the same diagnostics in JSON, so you can
  wire them into a CI gate that fails on errors.

Rules are **per-dialect** where appropriate. A "lookup table not
loaded" rule fires for rsyslog and syslog-ng but not for Vector,
because Vector doesn't have an equivalent construct. A "Vector input
not referenced by any transform" rule fires for Vector but not for
rsyslog. The validation engine knows which rules apply to which
dialect and skips the ones that don't.

## "Did you mean…?" suggestions

For the "undefined reference" rules (rulesets, templates, lookup
tables), the diagnostic doesn't just say "not found." It also
suggests the closest existing name, using a string-distance metric.
So instead of:

> error: ruleset 'rs_secuirty' is referenced from line 47 but not
> defined

you get:

> error: ruleset 'rs_secuirty' is referenced from line 47 but not
> defined. Did you mean **rs_security**?

That's the difference between a five-minute typo hunt and a
five-second fix.

## Where validation ends and runtime begins

Validation rules can catch every problem expressible as "your config
is internally inconsistent." They cannot catch problems that depend
on runtime data: a lookup table that loads but whose data is stale,
a regex that compiles but doesn't match the messages you actually
receive, a forwarder that resolves DNS but lands on a host that's
firewalled.

For those, you need the [simulator](/simulator), the
[replay](/replay), and the live daemon. Validation is the first line
of defence: it catches the things that don't need runtime data to
detect. The other tools handle what's left.

## The broken-demo

There's a deliberately-broken example config we ship — a config
that trips nine different validation rules at once. It exists as a
teaching tool, so you can see what each diagnostic looks like in
context before you encounter them in your own configs. We wrote
about it in the [broken-demo
post](/blog/2026-05-17-the-broken-demo-learn-by-clicking).

## Try it

Load your own config via the [Projects page](/projects), or open the
broken-demo, then look at the Diagnostics panel on the [Config
browser](/config). If you've never run a validator over your live
config before, you might be surprised by what comes out.
