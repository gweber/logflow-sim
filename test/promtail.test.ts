import { describe, it, expect } from 'vitest';
import { promtailDialect } from '../src/core/dialects/promtail/index.js';
import { detectDialect } from '../src/core/dialects/registry.js';

const SAMPLE = `
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: syslog-stream
    syslog:
      listen_address: 0.0.0.0:1514
      labels:
        job: syslog-stream
  - job_name: varlog
    static_configs:
      - targets: [localhost]
        labels:
          job: varlog
          __path__: /var/log/*.log
    pipeline_stages:
      - regex:
          expression: '^(?P<severity>\\\\w+):'
      - labels:
          severity:
`;

describe('promtail dialect', () => {
  it('detects promtail over other YAML configs', () => {
    const det = detectDialect([{ path: 'promtail.yml', content: SAMPLE }]);
    expect(det).not.toBeNull();
    expect(det!.dialect.id).toBe('promtail');
    expect(det!.confidence).toBeGreaterThan(0.5);
  });

  it('parses scrape_configs into inputs with correct typing', () => {
    const { model, diagnostics } = promtailDialect.parseFiles([
      { path: 'promtail.yml', content: SAMPLE }
    ]);
    expect(diagnostics).toEqual([]);
    expect(model.inputs).toHaveLength(2);
    const syslog = model.inputs.find((i) => i.type === 'syslog');
    expect(syslog).toBeDefined();
    expect(syslog!.port).toBe(1514);
    const file = model.inputs.find((i) => i.type === 'file');
    expect(file).toBeDefined();
  });

  it('parses pipeline_stages into modules', () => {
    const { model } = promtailDialect.parseFiles([
      { path: 'promtail.yml', content: SAMPLE }
    ]);
    expect(model.modules.map((m) => m.load)).toEqual(
      expect.arrayContaining(['stage:regex', 'stage:labels'])
    );
  });

  it('treats clients[*] as outputs of kind loki', () => {
    const { model } = promtailDialect.parseFiles([
      { path: 'promtail.yml', content: SAMPLE }
    ]);
    expect(model.outputs).toHaveLength(1);
    expect(model.outputs[0].driver).toBe('loki');
  });

  it('emit produces a YAML that re-parses through the same dialect', () => {
    const { model } = promtailDialect.parseFiles([
      { path: 'promtail.yml', content: SAMPLE }
    ]);
    const { output, diagnostics } = promtailDialect.emit!(model);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(output).toContain('scrape_configs:');
    expect(output).toContain('clients:');
    const round = promtailDialect.parseFiles([{ path: 'roundtrip.yml', content: output }]);
    expect(round.model.inputs.length).toBe(model.inputs.length);
    expect(round.model.outputs.length).toBe(model.outputs.length);
  });
});
