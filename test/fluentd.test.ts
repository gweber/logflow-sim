import { describe, it, expect } from 'vitest';
import { fluentdDialect } from '../src/core/dialects/fluentd/index.js';
import { detectDialect } from '../src/core/dialects/registry.js';

const SAMPLE = `
# Fluentd td-agent.conf

<source>
  @type forward
  port 24224
  bind 0.0.0.0
  tag forward.in
</source>

<source>
  @type syslog
  port 5140
  tag syslog.in
</source>

<filter syslog.in>
  @type record_transformer
  enable_ruby true
  <record>
    hostname "#{Socket.gethostname}"
  </record>
</filter>

<match syslog.in>
  @type elasticsearch
  host es.example.com
  port 9200
  logstash_format true
</match>

<match forward.in>
  @type kafka2
  brokers kafka1:9092,kafka2:9092
  topic forward-stream
</match>
`;

describe('fluentd dialect', () => {
  it('detects fluentd over other DSL configs', () => {
    const det = detectDialect([{ path: 'td-agent.conf', content: SAMPLE }]);
    expect(det).not.toBeNull();
    expect(det!.dialect.id).toBe('fluentd');
    expect(det!.confidence).toBeGreaterThan(0.5);
  });

  it('parses <source>, <filter>, <match> into the IR', () => {
    const { model, diagnostics } = fluentdDialect.parseFiles([
      { path: 'td-agent.conf', content: SAMPLE }
    ]);
    expect(diagnostics).toEqual([]);
    expect(model.inputs).toHaveLength(2);
    expect(model.outputs).toHaveLength(2);
    expect(model.modules).toHaveLength(1);
    const syslogIn = model.inputs.find((i) => i.type === 'syslog')!;
    expect(syslogIn.port).toBe(5140);
    const elastic = model.outputs.find((o) => o.driver === 'elasticsearch')!;
    expect(elastic.actionKind).toBe('omelasticsearch');
  });

  it('routes a <match> to the matching tagged sources', () => {
    const { model } = fluentdDialect.parseFiles([
      { path: 'td-agent.conf', content: SAMPLE }
    ]);
    const syslogMatch = model.routes.find((r) => r.outputRefs[0]?.includes('elasticsearch'));
    expect(syslogMatch).toBeDefined();
    expect(syslogMatch!.inputRefs).toContain('syslog.in');
  });

  it('emit produces a config that re-parses through the same dialect', () => {
    const { model } = fluentdDialect.parseFiles([
      { path: 'td-agent.conf', content: SAMPLE }
    ]);
    const { output, diagnostics } = fluentdDialect.emit!(model);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(output).toContain('<source>');
    expect(output).toContain('<match');
    const round = fluentdDialect.parseFiles([{ path: 'roundtrip.conf', content: output }]);
    expect(round.model.inputs.length).toBe(model.inputs.length);
    expect(round.model.outputs.length).toBe(model.outputs.length);
  });

  it('skips comments and blank lines', () => {
    const minimal = `
# a comment
<source>
  # another comment

  @type forward
  port 24224
</source>
`;
    const { model } = fluentdDialect.parseFiles([{ path: 'min.conf', content: minimal }]);
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0].type).toBe('forward');
  });
});
