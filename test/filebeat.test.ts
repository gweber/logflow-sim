import { describe, it, expect } from 'vitest';
import { filebeatDialect } from '../src/core/dialects/filebeat/index.js';
import { detectDialect } from '../src/core/dialects/registry.js';

const SAMPLE = `
filebeat.inputs:
  - type: log
    paths:
      - /var/log/app/*.log
    fields:
      sourcetype: app
  - type: syslog
    protocol: udp
    host: 0.0.0.0:514

processors:
  - add_host_metadata: ~
  - drop_event:
      when.equals.severity: debug

output.elasticsearch:
  hosts: ["es:9200"]
  index: "logs-%{[agent.version]}-%{+yyyy.MM.dd}"
`;

describe('filebeat dialect', () => {
  it('detects filebeat over other YAML dialects', () => {
    const det = detectDialect([{ path: 'filebeat.yml', content: SAMPLE }]);
    expect(det).not.toBeNull();
    expect(det!.dialect.id).toBe('filebeat');
    expect(det!.confidence).toBeGreaterThan(0.5);
  });

  it('parses inputs / processors / outputs into the IR', () => {
    const { model, diagnostics } = filebeatDialect.parseFiles([
      { path: 'filebeat.yml', content: SAMPLE }
    ]);
    expect(diagnostics).toEqual([]);
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[0].type).toBe('log');
    expect(model.inputs[1].type).toBe('syslog');
    expect(model.inputs[1].port).toBe(514);

    expect(model.modules.map((m) => m.load)).toEqual(
      expect.arrayContaining(['processor:add_host_metadata', 'processor:drop_event'])
    );

    expect(model.outputs).toHaveLength(1);
    expect(model.outputs[0].name).toBe('elasticsearch');
    expect(model.outputs[0].actionKind).toBe('omelasticsearch');

    expect(model.routes).toHaveLength(1);
    expect(model.routes[0].outputRefs).toEqual(['elasticsearch']);
  });

  it('parses the legacy filebeat.prospectors key as inputs', () => {
    const legacy = `
filebeat.prospectors:
  - type: log
    paths: [/var/log/syslog]
output.logstash:
  hosts: ["ls:5044"]
`;
    const { model } = filebeatDialect.parseFiles([{ path: 'filebeat.yml', content: legacy }]);
    expect(model.inputs).toHaveLength(1);
    expect(model.outputs[0].name).toBe('logstash');
  });

  it('emit produces a valid YAML that re-parses through the same dialect', () => {
    const { model } = filebeatDialect.parseFiles([{ path: 'filebeat.yml', content: SAMPLE }]);
    expect(filebeatDialect.emit).toBeDefined();
    const { output, diagnostics } = filebeatDialect.emit!(model);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(output).toContain('filebeat.inputs');
    expect(output).toContain('output.elasticsearch');
    const round = filebeatDialect.parseFiles([{ path: 'roundtrip.yml', content: output }]);
    expect(round.model.inputs.length).toBe(model.inputs.length);
    expect(round.model.outputs.length).toBe(model.outputs.length);
  });
});
