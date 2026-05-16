import { describe, it, expect } from 'vitest';
import { otelDialect } from '../src/core/dialects/otel/index.js';
import { detectDialect } from '../src/core/dialects/registry.js';

const SAMPLE = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  syslog/main:
    tcp:
      listen_address: 0.0.0.0:514
    protocol: rfc3164
  filelog/kern:
    include: [/var/log/kern.log]

processors:
  batch: {}
  attributes/redact:
    actions:
      - { action: delete, key: password }

exporters:
  file/local:
    path: /var/log/otel/logs.json
  otlp/upstream:
    endpoint: collector.example.net:4317
  debug:
    verbosity: detailed

service:
  pipelines:
    logs:
      receivers: [syslog/main, filelog/kern]
      processors: [batch, attributes/redact]
      exporters: [file/local, otlp/upstream]
    logs/debug:
      receivers: [syslog/main]
      exporters: [debug]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/upstream]
`;

describe('otel dialect', () => {
  it('detects an otel config over a vector config', () => {
    const det = detectDialect([{ path: 'config.yaml', content: SAMPLE }]);
    expect(det).not.toBeNull();
    expect(det!.dialect.id).toBe('otel');
    expect(det!.confidence).toBeGreaterThan(0.5);
  });

  it('parses receivers / processors / exporters / pipelines into the IR', () => {
    const { model, diagnostics } = otelDialect.parseFiles([{ path: 'config.yaml', content: SAMPLE }]);
    expect(diagnostics).toEqual([]);
    expect(model.inputs.map((i) => i.id)).toEqual(
      expect.arrayContaining([
        'input:config.yaml:otlp',
        'input:config.yaml:syslog/main',
        'input:config.yaml:filelog/kern'
      ])
    );
    expect(model.outputs.map((o) => o.name)).toEqual(
      expect.arrayContaining(['file/local', 'otlp/upstream', 'debug'])
    );
    expect(model.modules.map((m) => m.load)).toEqual(
      expect.arrayContaining(['processor:batch', 'processor:attributes'])
    );

    // Routes: each named pipeline becomes one IRRoute with explicit wiring.
    const logs = model.routes.find((r) => r.name === 'logs');
    expect(logs).toBeDefined();
    expect(logs!.inputRefs).toEqual(['syslog/main', 'filelog/kern']);
    expect(logs!.outputRefs).toEqual(['file/local', 'otlp/upstream']);
    expect(logs!.flags).toContain('logs');

    const debug = model.routes.find((r) => r.name === 'logs/debug');
    expect(debug!.outputRefs).toEqual(['debug']);
  });

  it('extracts ports from `protocols.<proto>.endpoint` style configs', () => {
    const { model } = otelDialect.parseFiles([{ path: 'config.yaml', content: SAMPLE }]);
    const syslog = model.inputs.find((i) => i.id.endsWith(':syslog/main'));
    expect(syslog!.port).toBe(514);
    // The otlp receiver has nested protocols.grpc.endpoint :4317; we pick
    // the first one we find — either is acceptable for routing analysis.
    const otlp = model.inputs.find((i) => i.id.endsWith(':otlp'));
    expect(otlp!.port).toBeGreaterThan(0);
  });

  it('emit produces a valid-shape YAML that re-parses through the same dialect', () => {
    const { model } = otelDialect.parseFiles([{ path: 'config.yaml', content: SAMPLE }]);
    expect(otelDialect.emit).toBeDefined();
    const { output, diagnostics } = otelDialect.emit!(model);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(output).toContain('receivers:');
    expect(output).toContain('exporters:');
    expect(output).toContain('service:');
    // Round-trip: re-parse must keep the receiver and exporter counts.
    const round = otelDialect.parseFiles([{ path: 'roundtrip.yaml', content: output }]);
    expect(round.model.inputs.length).toBe(model.inputs.length);
    expect(round.model.outputs.length).toBe(model.outputs.length);
    expect(round.model.routes.length).toBe(model.routes.length);
  });
});
