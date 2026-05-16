---
title: Supported syntax
order: 2
---

# Supported syntax

The parser implements the subset of RainerScript needed for typical forwarding and
classification configurations.

## Top-level statements

```rsyslog
module(load="imudp")
global(workDirectory="/var/spool/rsyslog")
main_queue(queue.size="100000")

input(type="imudp" port="514" ruleset="default_rs")
input(type="imtcp" port="514" ruleset="default_rs")

template(name="my_file" type="string" string="/var/log/%hostname%/%programname%.log")

lookup_table(name="vendors" file="/etc/rsyslog.d/lookups/vendors.json" reloadOnHUP="on")

ruleset(name="default_rs") {
    # ... statements ...
}

include(file="/etc/rsyslog.d/*.conf")
$IncludeConfig /etc/rsyslog.d/legacy.conf
$DefaultRuleset default_rs
```

## Inside rulesets

```rsyslog
if $programname == "firewall" then {
    call firewall_rs
    stop
} else if $msg contains_i ["error", "critical"] then {
    set $!severity = "high";
    action(type="omfile" DynaFile="my_file")
} else {
    set $!severity = "info";
    unset $.tmp;
    action(type="omfwd" Target="splunk.example.net" Port="514" Protocol="tcp")
}
```

## Properties

| Form        | Meaning                              |
|-------------|--------------------------------------|
| `$msg`      | Message body                         |
| `$rawmsg`   | Original raw message                 |
| `$hostname` | Hostname                             |
| `$fromhost` | Sending host (FQDN)                  |
| `$fromhost-ip` | Sending host IP                   |
| `$programname` | Program name                      |
| `$syslogtag`   | Syslog tag                        |
| `$inputname`   | Name of receiving input           |
| `$.var`     | Local variable                       |
| `$!field`   | Structured data / JSON property      |

## Operators

- Equality / inequality: `==`, `!=`
- Numeric comparison: `<`, `<=`, `>`, `>=`
- Boolean: `and`, `or`, `not`, parentheses
- Substring: `contains`, `contains_i`
- Prefix: `startswith`, `startswith_i`
- String concatenation: `&`

RHS may be a string literal **or an array** for `contains*` / `startswith*` / `==`:

```rsyslog
if $programname startswith_i ["sshd", "sudo", "su"] then { ... }

if $fromhost-ip == ['10.1.2.3', '10.1.2.4'] then { ... }

set $.path = "/var/log/" & $hostname & "/" & $programname & ".log";
```

Both `"double"` and `'single'` quoted strings are accepted.

## Built-in functions

| Function | Purpose |
|---|---|
| `lookup("table", key)` | Lookup table query |
| `exec_template("name")` | Render a template against the current message |
| `tolower(s)` / `toupper(s)` | Case conversion |
| `cnum(x)` / `cstr(x)` | Cast to number / string |
| `strlen(s)` | Length |
| `substring(s, start, len)` | Substring |
| `getenv("VAR")` | Environment variable |

## Template properties & modifiers

Inside `template(string="...")` strings you can use `%property%` references:

| Form | Resolves to |
|---|---|
| `%hostname%`, `%fromhost%`, `%programname%`, etc. | Message properties (case-insensitive) |
| `%!fieldname%` | Structured data (`$!fieldname`) — note no `$` prefix |
| `%$.var%` | Local variables |
| `%$YEAR%`, `%$MONTH%`, `%$DAY%`, `%$HOUR%`, `%$MINUTE%`, `%$SECOND%` | Components of the simulation time (zero-padded) |
| `%$NOW%`, `%$NOW_UTC%` | Current date (yyyy-mm-dd) |
| `%$MYHOSTNAME%` | Hostname of the simulator host |
| `%timestamp%`, `%timegenerated%`, `%timereported%` | RFC3339 timestamp |
| `%pri%`, `%syslogfacility%`, `%syslogfacility-text%`, `%syslogseverity%`, `%syslogseverity-text%` | Decoded from `<PRI>` in rawmsg |

Property modifiers (chainable, after `:`):

| Modifier | Effect |
|---|---|
| `:::lowercase` / `:::uppercase` | Case conversion |
| `:::json` / `:::jsonf` | JSON-escape (string body / full JSON string) |
| `:::escape-cc` / `:::space-cc` | Control character handling |
| `:::date-rfc3339` / `:::date-rfc3164` | Date format passthrough |
| `:::date-unixtimestamp` | Epoch seconds |
| `:::date-year` / `:::date-month` / `:::date-day` / `:::date-hour` | Extract date component |
| `:N,M` | Substring (1-indexed start, exclusive end) |
| `:R,ERE,N,FIELD:pattern--end` | Regex extract — returns Nth capture group; `FIELD`/`BLANK`/`DFLT`/`ZERO` control on-no-match |

Example:

```rsyslog
template(name="firewall_host_extract" type="string"
         string="%msg:R,ERE,1,FIELD:originsicname=...=(\\w+)--end%")

ruleset(name="r") {
    reset $!host = exec_template("firewall_host_extract");
    reset $!host = tolower($!host);
}
```

## Lookup tables

```rsyslog
lookup_table(name="vendors" file="..." reloadOnHUP="on")

set $!sourcetype = lookup("vendors", $programname);
```

Supported lookup file formats (JSON):

1. Plain object: `{ "key": "value", ... }`
2. Array of objects with inferred `key`/`value` (or `index`/`value`) fields.
3. Native rsyslog format: `{ "version": 1, "nomatch": "...", "type": "string", "table": [{ "index": "...", "value": "..." }] }`.
