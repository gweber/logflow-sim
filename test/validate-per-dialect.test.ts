import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../src/core/dialects/rsyslog/index.js';
import { syslogNgDialect } from '../src/core/dialects/syslog-ng/index.js';
import { otelDialect } from '../src/core/dialects/otel/index.js';
import { vectorDialect } from '../src/core/dialects/vector/index.js';
import { fluentBitDialect } from '../src/core/dialects/fluent-bit/index.js';
import { validate } from '../src/core/validate/index.js';

function rsyslogModel(src: string) {
  return buildIR([parse({ path: 'main.conf', content: src }).ast]);
}

describe('validate/per-dialect', () => {
  // -------------------- rsyslog --------------------

  it('rsyslog: flags an undefined template referenced by an action', () => {
    const model = rsyslogModel(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        action(type="omfile" file="/var/log/x" template="MissingFormat")
      }
    `);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_RSYSLOG_TEMPLATE_UNDEFINED');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('MissingFormat');
  });

  it('rsyslog: flags $DefaultRuleset pointing to a missing ruleset', () => {
    const model = rsyslogModel(`
      $DefaultRuleset catch_all
      module(load="imudp")
      input(type="imudp" port="514")
      ruleset(name="catchall") { action(type="omfile" file="/var/log/messages") }
    `);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_RSYSLOG_DEFAULT_RULESET_UNDEFINED');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('catch_all');
  });

  // -------------------- syslog-ng --------------------

  it('syslog-ng: flags orphan destinations', () => {
    const src = `
      source s_net { udp(port(514)); };
      destination d_local { file("/var/log/messages"); };
      destination d_unused { file("/var/log/dead"); };
      log { source(s_net); destination(d_local); };
    `;
    const { model } = syslogNgDialect.parseFiles([{ path: 'syslog-ng.conf', content: src }]);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_SYSLOGNG_ORPHAN_DESTINATION' && f.message.includes('d_unused')
    );
    expect(finding).toBeDefined();
  });

  it('syslog-ng: flags log{} blocks with no destinations', () => {
    const src = `
      source s_net { udp(port(514)); };
      log { source(s_net); };
    `;
    const { model } = syslogNgDialect.parseFiles([{ path: 'syslog-ng.conf', content: src }]);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_SYSLOGNG_LOG_NO_DEST');
    expect(finding).toBeDefined();
  });

  // -------------------- otel --------------------

  it('otel: flags pipeline referencing undeclared exporter', () => {
    const yaml = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  file/main:
    path: /var/log/otel.json
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file/typo]
`;
    const { model } = otelDialect.parseFiles([{ path: 'config.yaml', content: yaml }]);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_OTEL_COMPONENT_UNDEFINED' && f.message.includes('file/typo')
    );
    expect(finding).toBeDefined();
  });

  it('otel: flags pipeline with no exporters', () => {
    const yaml = `
receivers:
  otlp:
    endpoint: 0.0.0.0:4317
exporters:
  file/main:
    path: /var/log/otel.json
service:
  pipelines:
    logs/dry:
      receivers: [otlp]
      exporters: []
`;
    const { model } = otelDialect.parseFiles([{ path: 'config.yaml', content: yaml }]);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_OTEL_PIPELINE_NO_EXPORTERS');
    expect(finding).toBeDefined();
  });

  // -------------------- vector --------------------

  it('vector: flags sink referencing non-existent transform/source', () => {
    const toml = `
[sources.in]
type = "syslog"
address = "0.0.0.0:514"

[sinks.out]
type = "file"
inputs = ["typo_in"]
path = "/var/log/messages"
`;
    const { model } = vectorDialect.parseFiles([{ path: 'vector.toml', content: toml }]);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_VECTOR_INPUT_REF_UNDEFINED' && f.message.includes('typo_in')
    );
    expect(finding).toBeDefined();
  });

  // -------------------- fluent-bit --------------------

  it('fluent-bit: flags OUTPUT section without Match', () => {
    const ini = `
[INPUT]
    Name tail
    Tag  app.*
    Path /var/log/*.log

[OUTPUT]
    Name stdout
`;
    const { model } = fluentBitDialect.parseFiles([{ path: 'fluent-bit.conf', content: ini }]);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_FLUENT_BIT_OUTPUT_NO_MATCH');
    expect(finding).toBeDefined();
  });

  // -------------------- cross-dialect rule activation --------------------

  it('rsyslog-specific rules do NOT fire against syslog-ng configs', () => {
    const src = `
      source s_net { udp(port(514)); };
      destination d_local { file("/var/log/messages"); };
      log { source(s_net); destination(d_local); };
    `;
    const { model } = syslogNgDialect.parseFiles([{ path: 'syslog-ng.conf', content: src }]);
    const r = validate(model);
    // No rsyslog-specific findings should appear on a syslog-ng model.
    const rsyslogFindings = r.findings.filter((f) => f.code?.startsWith('V_RSYSLOG_'));
    expect(rsyslogFindings).toEqual([]);
    expect(rsyslogFindings.find((f) => f.code === 'V_MODULE_MISSING')).toBeUndefined();
  });
});
