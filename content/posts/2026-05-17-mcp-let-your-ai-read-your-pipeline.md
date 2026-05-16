---
title: Let your AI assistant read your log pipeline
date: 2026-05-17
excerpt: AI coding assistants are good at reading code they can see. Log-pipeline configs are code, but the simulator that explains them isn't on the model's side of the screen — unless you give it an MCP server.
tags: [mcp, ai, claude, model-context-protocol, assistants]
---

# Let your AI assistant read your log pipeline

A pattern has emerged in the last year of using AI coding assistants
day to day. They are remarkably good at reasoning about code as text
— reading it, suggesting changes, explaining what a function does.
But they're noticeably weaker the moment a question requires running
the code or interpreting its runtime behaviour.

For most code, this is a workable limitation. The assistant suggests
a change, you run the tests, you tell it what failed. The loop
works.

For log-pipeline configs, it breaks down harder than usual.
"What does this rsyslog config actually do with a typical syslog
message?" is a question you can't answer by reading. The control
flow involves conditionals on properties that come from the
message, lookups that come from external files, includes that pull
in dozens of other configs. The assistant can describe the *shape*
of the routing but can't trace a concrete message through it without
guessing.

## The MCP server

logflow-sim ships with a Model Context Protocol (MCP) server. MCP
is an open protocol that lets an AI assistant call tools running on
your local machine. With the logflow-sim MCP server registered, the
assistant gets access to:

- `logflow_parse` — read a config tree and return a structured
  summary (files, inputs, rulesets, lookup tables, validation
  diagnostics).
- `logflow_simulate` — push a synthetic syslog message through the
  config and return the full trace: which input matched, which
  conditions fired, which lookups were hit, where the message ended
  up.
- `logflow_replay` — feed a batch of real syslog through the config
  and return aggregate routing data.
- `logflow_diff` — replay the same batch through two configs and
  return what changed.
- `logflow_convert` — translate the config to another dialect.
- `logflow_detect` — run Sigma detection rules against the replay
  corpus and return what fires.
- `logflow_validate` — return the diagnostics for the loaded config.

The shape of those tools matches the simulator UI's capabilities
roughly one-to-one. Anything you'd do by clicking around in the
browser, the assistant can do by calling a tool.

## Why this changes the conversation

Without the MCP server, asking an assistant "why is this log line
not reaching the SIEM" looks like:

> **You:** Here's our rsyslog config. Why might `<some specific
> message>` not be reaching the SIEM forwarder?
>
> **Assistant:** *long, careful narrative about how rsyslog's
> control flow works, with multiple "if your config looks like X"
> branches. Helpful but generic.*

With it, the same conversation looks like:

> **You:** Why is `<some specific message>` not reaching the SIEM
> forwarder?
>
> **Assistant:** *calls* `logflow_simulate` *with the actual
> message, reads the trace, identifies that an `if` on line 412
> evaluated false because* `$msg` *doesn't contain a substring it
> expects.* The config drops the message at line 412 because the
> condition `$msg contains "AUTH_OK"` is false for your sample.
> Here's the trace.

That's a different kind of answer. It's grounded in what the
config actually does, not in what it might plausibly do.

## What this isn't

It isn't a "let the AI deploy your config" feature. The MCP server
exposes **read-only analytical tools**. There's no `logflow_apply`,
no `logflow_restart_daemon`, no anything that touches production.
The assistant can describe and simulate; it can't change.

It also isn't a magic "the AI now understands your config" button.
Tool access expands what the assistant can investigate, but the
quality of the answer still depends on the quality of the
question. The good news is that "ask the simulator" is now a tool
the assistant can reach for unprompted, which usually nudges its
answers from speculative to specific.

## How to wire it up

The MCP server speaks line-delimited JSON-RPC 2.0 on stdio — the
standard MCP transport. Point your MCP-enabled client (Claude
Desktop, an MCP-capable editor, your own integration) at the
`logflow-sim-mcp` binary, and the tools show up automatically.

The repo's [README](https://github.com/gweber/logflow-sim) has the
current registration snippet. We don't gate it behind an account
because there's nothing to gate — it's reading your local
configs, nothing else.

## What we hope happens

People stop having to read their own rsyslog config line by line at
3 AM to figure out where a log went. They ask their assistant. The
assistant calls the simulator. The simulator answers honestly. The
person goes back to sleep.

That's the goal.
