---
title: The broken-demo — a config built to fail interestingly
date: 2026-05-17
excerpt: We deliberately wrote a config that trips nine validation rules at once, so you can see exactly what each problem looks like before you encounter it in your own pipeline.
tags: [broken-demo, learning, validation, teaching]
---

# The broken-demo — a config built to fail interestingly

If you've never used a config validator before, the most
interesting question isn't "what is it?" It's "what does a real
broken config look like through its eyes?"

Documentation tells you that the tool can detect "undefined ruleset
references." A real config doesn't say "look at me, I have an
undefined ruleset reference." It just sits there, syntactically
valid, with something quietly missing. The validator finds it; the
human, scrolling through 800 lines of `*.conf`, often doesn't.

To make that experience concrete, we ship a **deliberately broken
demo config**. It's a small rsyslog tree — a few inputs, a few
rulesets, some lookup tables — and it's been carefully constructed
to trigger **nine different validation rules at once**.

## What's in it

The broken-demo config tries to do something plausible: receive
syslog on TCP and UDP, route it by hostname and severity, look up
team owners from a table, forward to a SIEM, and archive everything
else to a per-day file.

Then it makes nine small mistakes. Specifically:

- The TCP input is used but the `imtcp` module is never loaded.
- A ruleset is called from a forwarder rule but defined under a
  slightly different name (a typo). The "did you mean…?"
  suggestion catches this.
- The default ruleset declared via `$DefaultRuleset` points at a
  ruleset that doesn't exist.
- A `lookup()` call references a table that was never registered
  via `lookup_table(...)`.
- A `DynaFile` action references a template name that doesn't
  exist.
- One of the rulesets is defined but never bound to an input and
  never called from another ruleset — pure dead code.
- An `if` branch matches an entire category of message and then
  has no actions inside it — a silent drop.
- A `call rs_audit` statement references a ruleset that was
  recently renamed.
- A forwarding action targets an output that points at no module.

Each of these is the kind of mistake a real config accumulates
over years of maintenance. Nobody sat down and wrote all nine in
one go. They drift in: someone renames a ruleset and forgets a
caller, someone removes a module and a remnant input stays, a
template gets restructured and an old reference lingers.

## Why see them all at once

There's a real teaching value in encountering every diagnostic
shape on one screen. You learn what an `error` looks like next to
a `warning`, you see how source locations are displayed, you click
through and watch the file viewer jump to the relevant line, you
notice that the "did you mean…?" suggestion is one click away from
a fix.

Once you've seen those patterns on the broken-demo, you recognise
them instantly in your own config. The first time a `V_DEAD_RULESET`
diagnostic shows up in a PR review, you don't need to look it up —
you've already seen what it means.

## Where it lives

The broken-demo is hosted as a separate instance with its own
config tree, so it never gets confused with the main demo. From
the [home page](/) you'll see a link to "the broken demo" — it's
the same UI, just pointed at the deliberately-broken config.

Switch to the [Config browser](/config) once you're there, and the
Diagnostics panel will show all nine. Click into any diagnostic
and you jump to the offending line. Switch to the
[Simulator](/simulator) and try sending a message — you'll see
which rules drop it on the floor and which silently route it
nowhere.

## Why we didn't make it perfectly clean

The temptation when building a demo is to show the tool at its
best — a beautifully structured config where everything is in its
right place and the tool reports zero issues. That's a great
screenshot. It's a terrible teaching aid.

A demo that does nothing wrong tells you nothing about what the
tool does when something *is* wrong. And the latter is the whole
reason you'd reach for the tool in the first place.

The broken-demo is the answer to "show me what this tool is
actually for." It's for the moment when a real config has drifted
into one of those nine shapes, and you'd like to know about it
before it bites.

## Use it as a tutorial

If you're evaluating logflow-sim, the recommended path is:

1. Open the broken-demo.
2. Look at the diagnostics panel and pick the rule that confuses
   you most.
3. Click through to the source location.
4. Fix it mentally — what would the right fix be?
5. Open your own config, switch back to the main demo or load a
   project, and see whether the same shape exists there.

Most teams who do this find at least one or two diagnostics on
their own config that surprise them. Those are the bugs that were
quietly waiting for the right outage to surface.
