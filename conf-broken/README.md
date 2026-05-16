# conf-broken — deliberately misconfigured rsyslog

This config tree exists to **prove the validator works**. Every file in here
trips at least one validation rule on purpose. Mounting it instead of
`conf-demo/` is how the live deployment at
`https://netverdict.io/logflow-broken/` lights up its diagnostics panel.

| Intent | Where it lives | Validation code |
|---|---|---|
| `imtcp` input without `module(load="imtcp")` | `rsyslog.conf` | `V_MODULE_MISSING` |
| `omkafka` action without `module(load="omkafka")` | `etc/rsyslog.d/10-routing.conf` | `V_MODULE_MISSING` |
| Action references undeclared template `JsonForElastic` | `etc/rsyslog.d/10-routing.conf` | `V_RSYSLOG_TEMPLATE_UNDEFINED` |
| `$DefaultRuleset catchall_typo` references a missing ruleset | `rsyslog.conf` | `V_RSYSLOG_DEFAULT_RULESET_UNDEFINED` |
| Ruleset whose tail is an `if` without `else` | `etc/rsyslog.d/10-routing.conf` | `V_SILENT_DROP` |
| Ruleset that ends with `set` only — no action, no stop | `etc/rsyslog.d/20-helper.conf` | `V_SILENT_DROP` |
| `lookup_table` references a JSON file that doesn't exist | `rsyslog.conf` | `V_LOOKUP_NOT_LOADED` |
| Ruleset declared but never bound and never `call`ed | `etc/rsyslog.d/20-helper.conf` | `V_DEAD_RULESET` |
| `call orphan_handler` to a ruleset that doesn't exist | `etc/rsyslog.d/10-routing.conf` | `V_UNDEFINED_CALL_TARGET` |

Run it locally:

```bash
podman run --rm -p 5141:3000 \
  -v $(pwd)/conf-broken:/app/conf:ro \
  logflow-sim:latest
open http://localhost:5141/config
```
