---
title: Limitations
order: 99
---

# Parser, simulator, replay & convert — known limitations

This tool is an **explainer**, not a re-implementation of rsyslog. Known gaps:

## Parser

- No support for `foreach`, user-defined functions, or the `=~` / `!~` regex match operators
  (use the `R,ERE,...` template modifier or `exec_template` instead).
- Property modifiers in expressions (e.g. `$msg:1:10` in a comparison) are not yet supported.
  They **are** supported inside template strings.
- Legacy filter selectors (`*.* /var/log/foo`) are preserved as `UnknownNode` with a warning.
  Migrate them to `action(...)` syntax to get them simulated.
- List-style templates `template(name="x" type="list") { ... }` not parsed.
- `prifilt("mail.*")` not implemented.

## Simulator

- **No queue semantics.** Queue parameters on actions, rulesets, or `main_queue(...)` are
  parsed but not executed. The simulator runs synchronously and deterministically.
- **No file or network I/O.** `omfile` resolves the target path; `omfwd` resolves the
  target/port/protocol. Nothing is actually written or sent.
- **Lookup tables**: JSON only — plain object, array-of-objects, or rsyslog-native format.
  CSV (rsyslog's other native lookup format) is out of scope.
- **Inputs**: `imudp`, `imtcp`, and `imptcp` inputs participate in port-based selection.
  Other input types (imfile, imrelp, etc.) are parsed but not exercised by the simulator.
- **`continue`** is treated as a no-op that records a trace event — rsyslog's actual
  continue semantics across action chains differ subtly and are not modelled.
- **`%$NOW%`, `%$YEAR%`, etc.** are resolved from a **simulation time** (defaults to wall-clock
  time at simulation; can be overridden via the `simTime` field on the request).

If your config relies on something not listed here and the simulator's behavior surprises you,
that's worth opening an issue — but expect "not supported" rather than "supported but broken"
as the answer.

## Replay & pcap

- **pcapng**: receivers/processors/exporters parsed; multi-section, multi-byte-order
  pcapng accepted. **Per-packet timestamp resolution** is treated as microseconds
  regardless of the IDB `tsresol` option (Wireshark defaults match this).
- **TCP reassembly**: per-flow with auto-detect between RFC 6587 octet-counted
  (`LEN MSG`) and non-transparent (`\n`-delimited) framing. **No TLS** —
  syslog-over-TLS pcaps must be decrypted with an external tool first.
- **Link layers**: Ethernet (1), LINUX_SLL (113), Raw IPv4 (12 / 101). Other
  link-types are skipped with a diagnostic. **IPv6 not supported** — rare for
  syslog and adds extraction complexity without unblocking real users today.
- **Per-flow buffer cap**: 1 MB. A pathological TCP flow that never frames
  gets its buffer dropped with a diagnostic.
- **Pcap-to-message rate** in replay reports is intentionally limited to the
  syslog ports `514`, `601`, `6514` — other packets are dropped silently.

## Cross-dialect convert

- **Expression bodies don't translate.** rsyslog `lookup()`, Vector VRL, OTel
  OTTL all parse fine in their source form — but the emitter for another
  dialect cannot regenerate equivalent logic. Concrete cases:
  - rsyslog → Vector: `if $msg contains "x" then action(...)` becomes a sink
    wired to every source through a single sink — the predicate is dropped.
    Diagnostic emitted.
  - rsyslog → OTel: ruleset `if`/`set`/`stop` flows are flattened into a
    single `logs` pipeline with all receivers fanning into all exporters.
- **Lookup table content** is preserved, but the **lookup expressions**
  that reference them aren't. OTel emit synthesizes a transform processor
  with OTTL `set(...) where attributes["lookup_key"] == "..."` per entry;
  Vector emits an `enrichment_tables` block + CSV sidecar. You still have
  to point your transform/remap code at the right table by hand.
- **Round-trip** (A → B → A) generally **does not** preserve the original
  file structure. We optimize for "a config that boots and routes the same
  buckets," not byte-identical reproduction.

## Static validation

The validator catches obvious silent-drop paths, undefined references, dead
code, missing lookup files, and conflicting outputs. **It does NOT** symbolically
execute conditions to check exhaustiveness (`if x == "a"` / `if x == "b"` with
no `else` is correctly flagged; `if x == "a" then ... else if x == "b" then ...
else action()` is correctly NOT flagged; but a pattern like `if x =~ ".*foo.*"`
followed by `if x == "foobar"` — second statement is unreachable — is NOT
caught today).
