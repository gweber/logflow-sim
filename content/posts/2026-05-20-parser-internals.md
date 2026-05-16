---
title: Parser internals — why hand-written, what it covers
date: 2026-05-20
excerpt: Notes on the recursive-descent RainerScript parser, error recovery, and source location tracking.
tags: [parser, design, deep-dive]
---

The parser is a hand-written recursive-descent implementation in plain TypeScript. It covers
the subset of RainerScript needed for real Splunk-forwarding configurations:

- `module(load=...)`, `global(...)`, `main_queue(...)`
- `input(...)`, `ruleset(...) { ... }`, `template(...)`, `lookup_table(...)`
- `action(type="omfile" ...)`, `action(type="omfwd" ...)`
- `if ... then { ... } else if ... { ... } else { ... }`
- `set $.x = expr;`, `reset $.x = expr;`, `unset $.x;`, `stop`, `call rs`
- Property references: `$msg`, `$fromhost`, `$.var`, `$!field`
- Operators: `==`, `!=`, `and`, `or`, `contains`, `contains_i`, `startswith`, `startswith_i`
- Arrays: `[ "a", "b", "c" ]`
- `lookup("table", key)`
- Legacy directives: `$IncludeConfig`, `$DefaultRuleset`, and friends

## Why hand-written?

Two reasons. First, **source locations**. Every AST node needs to carry the file, line, column,
and span it came from so the UI can link directly back. Hand-written parsers make that trivial;
parser generators tend to make it possible-but-painful.

Second, **error recovery**. If a single line is malformed, we don't want to give up on the whole
file. The parser advances to the next statement boundary (`;`, newline at top level, or matching
`}`) on syntax error, emits a diagnostic, and preserves the offending text as an `UnknownNode`.

## Diagnostic guarantees

The cardinal rule: **never silently drop config**. If the parser doesn't understand something:

1. It is captured as `UnknownNode` with full source location and raw text.
2. A `warning` diagnostic with code `W_UNKNOWN_STATEMENT` is emitted.
3. The simulator surfaces these as `unknown` trace events at run time.

Silent skipping is a correctness bug.
