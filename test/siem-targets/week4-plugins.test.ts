import { describe, it, expect } from 'vitest';
import { getSIEMTarget, listSIEMTargets } from '../../src/core/siem-targets/registry.js';
import { toOCSF, fromOCSF, retagValue } from '../../src/core/siem-targets/pivot.js';
import { renderLEEF } from '../../src/core/siem-targets/renderers/leef.js';
import { renderCEF } from '../../src/core/siem-targets/renderers/cef.js';
import { renderUDM } from '../../src/core/siem-targets/renderers/udm.js';
import { validate } from '../../src/core/validate/index.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../../src/core/siem-targets/ocsf.js';
import type { IRModel, IROutput } from '../../src/core/ir/model.js';

const NO_SRC = { file: 'x', line: 1, col: 1, offset: 0, length: 0 };

function emptyModel(overrides: Partial<IRModel> = {}): IRModel {
  return {
    inputs: [],
    rulesets: [],
    templates: [],
    lookupTables: [],
    modules: [],
    globals: { params: {}, legacy: [] },
    diagnostics: [],
    rulesetByName: {},
    templateByName: {},
    lookupTableByName: {},
    files: [],
    outputs: [],
    outputByName: {},
    filters: [],
    filterByName: {},
    routes: [],
    dialect: 'rsyslog',
    ...overrides
  };
}

function makeOutput(
  name: string,
  driver: string,
  siemTarget: string,
  params: Record<string, unknown> = {}
): IROutput {
  return {
    kind: 'Output',
    id: name,
    name,
    driver,
    actionKind: 'omhttp',
    params: params as never,
    siemTarget,
    source: NO_SRC
  };
}

describe('Week 4: registry complete (11 SIEM targets)', () => {
  it('all 10 destinations + generic registered', () => {
    const ids = listSIEMTargets().map((t) => t.id).sort();
    expect(ids).toEqual([
      'arcsight-cef',
      'chronicle-udm',
      'datadog',
      'elastic-ecs',
      'generic',
      'graylog-gelf',
      'loki',
      'microsoft-sentinel',
      'qradar-leef',
      'splunk',
      'sumo-logic'
    ]);
  });
});

describe('Chronicle UDM plugin', () => {
  const udm = getSIEMTarget('chronicle-udm')!;

  it('maps USER_LOGIN → AUTHENTICATION', () => {
    expect(toOCSF(udm, 'udm.event_type', 'USER_LOGIN').ocsf.class_uid).toBe(
      OCSF_CLASSES.AUTHENTICATION
    );
  });

  it('maps NETWORK_DNS → DNS_ACTIVITY', () => {
    expect(toOCSF(udm, 'udm.event_type', 'NETWORK_DNS').ocsf.class_uid).toBe(
      OCSF_CLASSES.DNS_ACTIVITY
    );
  });

  it('round-trips Splunk linux:secure → UDM USER_LOGIN', () => {
    const splunk = getSIEMTarget('splunk')!;
    const r = retagValue(splunk, udm, 'udm.event_type', 'linux:secure');
    // No exact match (we're crossing taxonomies). Verify via raw pivot.
    const pivot = toOCSF(splunk, 'sourcetype', 'linux:secure').ocsf;
    delete pivot._original;
    expect(fromOCSF(udm, 'udm.event_type', pivot).nativeValue).toBe('USER_LOGIN');
    // retagValue with mismatched taxonomies → lossy (no shared cross-walk)
    expect(r.lossy).toBe(true);
  });
});

describe('QRadar LEEF plugin', () => {
  const leef = getSIEMTarget('qradar-leef')!;

  it('maps LOGIN_SUCCESS → AUTHENTICATION activity=1', () => {
    const r = toOCSF(leef, 'leef.eventId', 'LOGIN_SUCCESS');
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
    expect(r.ocsf.activity_id).toBe(1);
  });

  it('maps FW_DENY → NETWORK activity=2', () => {
    const r = toOCSF(leef, 'leef.eventId', 'FW_DENY');
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.NETWORK_ACTIVITY);
    expect(r.ocsf.activity_id).toBe(2);
  });
});

describe('ArcSight CEF plugin', () => {
  const cef = getSIEMTarget('arcsight-cef')!;

  it('maps auth.login.success → AUTHENTICATION activity=1', () => {
    const r = toOCSF(cef, 'cef.eventClassID', 'auth.login.success');
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
    expect(r.ocsf.activity_id).toBe(1);
  });
});

describe('LEEF renderer', () => {
  const leef = getSIEMTarget('qradar-leef')!;

  it('emits a LEEF 2.0 header line with defaults', () => {
    const out = renderLEEF(leef, {});
    expect(out).toMatch(/^LEEF:2\.0\|logflow-sim\|unknown\|0\|0\|/);
  });

  it('includes mapped fields tab-delimited after header', () => {
    const out = renderLEEF(leef, {
      'src_endpoint.ip': '10.0.0.1',
      'dst_endpoint.ip': '10.0.0.2'
    });
    expect(out).toContain('src=10.0.0.1');
    expect(out).toContain('dst=10.0.0.2');
    expect(out).toContain('\t'); // default delimiter
  });

  it('escapes pipe and equals in values', () => {
    const out = renderLEEF(leef, { 'src_endpoint.ip': 'a=b' });
    expect(out).toContain('a\\=b');
  });
});

describe('CEF renderer', () => {
  const cef = getSIEMTarget('arcsight-cef')!;

  it('emits a CEF:0 header line with 7 slots', () => {
    const out = renderCEF(cef, {});
    expect(out).toMatch(/^CEF:0\|logflow-sim\|unknown\|0\|0\|event\|5$/);
  });

  it('clamps severity to 0..10', () => {
    expect(renderCEF(cef, {}, { severity: 99 })).toMatch(/\|10$/);
    expect(renderCEF(cef, {}, { severity: -5 })).toMatch(/\|0$/);
  });

  it('escapes pipes in header slots', () => {
    const out = renderCEF(cef, {}, { vendor: 'we|leak' });
    expect(out).toContain('we\\|leak');
  });

  it('emits k=v body separated by spaces after final pipe', () => {
    const out = renderCEF(cef, {
      'src_endpoint.ip': '10.0.0.1',
      'dst_endpoint.ip': '10.0.0.2'
    });
    expect(out).toContain('|src=10.0.0.1 dst=10.0.0.2');
  });
});

describe('UDM renderer', () => {
  const udm = getSIEMTarget('chronicle-udm')!;

  it('always emits metadata.product_name and event_type defaults', () => {
    const out = renderUDM(udm, {});
    expect((out.metadata as Record<string, unknown>).product_name).toBe('logflow-sim');
    expect((out.metadata as Record<string, unknown>).event_type).toBe('GENERIC_EVENT');
  });

  it('routes mapped paths into the correct UDM group', () => {
    const out = renderUDM(udm, {
      'src_endpoint.ip': '10.0.0.1',
      'dst_endpoint.ip': '10.0.0.2'
    });
    expect((out.principal as Record<string, unknown>).ip).toBe('10.0.0.1');
    expect((out.target as Record<string, unknown>).ip).toBe('10.0.0.2');
  });

  it('stuffs unmapped fields into additional.fields[]', () => {
    const out = renderUDM(udm, { 'made.up.path': 'x' });
    const additional = out.additional as { fields: Array<{ key: string }> };
    expect(additional.fields.find((f) => f.key === 'made.up.path')).toBeDefined();
  });
});

describe('Week 4 validation rules', () => {
  it('udm/unknown-event-type fires for non-standard event_types', () => {
    const model = emptyModel({
      outputs: [
        makeOutput('udm', 'chronicle', 'chronicle-udm', {
          event_type: 'TOTALLY_MADE_UP'
        })
      ]
    });
    const report = validate(model);
    expect(report.findings.find((d) => d.code === 'SIEM_UDM_UNKNOWN_EVENT_TYPE')).toBeDefined();
  });

  it('udm/unknown-event-type passes USER_LOGIN', () => {
    const model = emptyModel({
      outputs: [
        makeOutput('udm', 'chronicle', 'chronicle-udm', {
          event_type: 'USER_LOGIN'
        })
      ]
    });
    const report = validate(model);
    expect(report.findings.find((d) => d.code === 'SIEM_UDM_UNKNOWN_EVENT_TYPE')).toBeUndefined();
  });

  it('leef/header-required reports missing slots', () => {
    const model = emptyModel({
      outputs: [makeOutput('q', 'qradar', 'qradar-leef')]
    });
    const report = validate(model);
    expect(report.findings.find((d) => d.code === 'SIEM_LEEF_HEADER_INCOMPLETE')).toBeDefined();
  });

  it('cef/severity-range flags out-of-range severity', () => {
    const model = emptyModel({
      outputs: [makeOutput('c', 'arcsight', 'arcsight-cef', { severity: 42 })]
    });
    const report = validate(model);
    expect(report.findings.find((d) => d.code === 'SIEM_CEF_SEVERITY_OUT_OF_RANGE')).toBeDefined();
  });

  it('cef/severity-range passes valid severities', () => {
    const model = emptyModel({
      outputs: [makeOutput('c', 'arcsight', 'arcsight-cef', { severity: 7 })]
    });
    const report = validate(model);
    expect(
      report.findings.find((d) => d.code === 'SIEM_CEF_SEVERITY_OUT_OF_RANGE')
    ).toBeUndefined();
  });
});
