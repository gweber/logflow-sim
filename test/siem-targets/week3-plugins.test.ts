import { describe, it, expect } from 'vitest';
import { getSIEMTarget, listSIEMTargets } from '../../src/core/siem-targets/registry.js';
import { toOCSF, fromOCSF } from '../../src/core/siem-targets/pivot.js';
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

describe('Week 3: registry size', () => {
  it('lists 8 SIEM targets', () => {
    expect(listSIEMTargets().length).toBe(8);
  });
});

describe('Microsoft Sentinel plugin', () => {
  it('maps SyslogAuth_CL → AUTHENTICATION', () => {
    const r = toOCSF(getSIEMTarget('microsoft-sentinel')!, 'sentinel.table', 'SyslogAuth_CL');
    expect(r.lossy).toBe(false);
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
  });

  it('maps SecurityEvent → FINDINGS', () => {
    const r = toOCSF(getSIEMTarget('microsoft-sentinel')!, 'sentinel.table', 'SecurityEvent');
    expect(r.ocsf.category_uid).toBe(OCSF_CATEGORIES.FINDINGS);
  });
});

describe('Sumo Logic plugin', () => {
  it('maps prod/linux/auth → AUTHENTICATION', () => {
    const r = toOCSF(getSIEMTarget('sumo-logic')!, 'sumo.sourceCategory', 'prod/linux/auth');
    expect(r.lossy).toBe(false);
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
  });

  it('preserves bespoke source categories', () => {
    const r = toOCSF(
      getSIEMTarget('sumo-logic')!,
      'sumo.sourceCategory',
      'team/special/internal'
    );
    expect(r.lossy).toBe(true);
    expect(r.originalValue).toBe('team/special/internal');
  });
});

describe('Sentinel validation', () => {
  it('flags invalid table names', () => {
    const model = emptyModel({
      outputs: [
        makeOutput('s', 'azuremonitor', 'microsoft-sentinel', {
          table: 'lowercase_bad'
        })
      ]
    });
    const report = validate(model);
    expect(
      report.findings.find((d) => d.code === 'SIEM_SENTINEL_INVALID_TABLE_NAME')
    ).toBeDefined();
  });

  it('accepts standard built-in tables', () => {
    const model = emptyModel({
      outputs: [makeOutput('s', 'azuremonitor', 'microsoft-sentinel', { table: 'Syslog' })]
    });
    const report = validate(model);
    expect(
      report.findings.find((d) => d.code === 'SIEM_SENTINEL_INVALID_TABLE_NAME')
    ).toBeUndefined();
  });

  it('accepts well-formed *_CL custom tables', () => {
    const model = emptyModel({
      outputs: [
        makeOutput('s', 'azuremonitor', 'microsoft-sentinel', { table: 'MyCustomLog_CL' })
      ]
    });
    const report = validate(model);
    expect(
      report.findings.find((d) => d.code === 'SIEM_SENTINEL_INVALID_TABLE_NAME')
    ).toBeUndefined();
  });
});

describe('Sumo validation', () => {
  it('flags missing _sourceCategory', () => {
    const model = emptyModel({
      outputs: [makeOutput('s', 'sumologic', 'sumo-logic')]
    });
    const report = validate(model);
    expect(
      report.findings.find((d) => d.code === 'SIEM_SUMO_MISSING_SOURCE_CATEGORY')
    ).toBeDefined();
  });
});

describe('Cross-vendor retag through OCSF (Week 3 additions)', () => {
  it('Splunk linux:secure → Sentinel SyslogAuth_CL', () => {
    const splunk = getSIEMTarget('splunk')!;
    const sentinel = getSIEMTarget('microsoft-sentinel')!;
    const pivot = toOCSF(splunk, 'sourcetype', 'linux:secure').ocsf;
    delete pivot._original;
    const r = fromOCSF(sentinel, 'sentinel.table', pivot);
    expect(r.lossy).toBe(false);
    expect(r.nativeValue).toBe('SyslogAuth_CL');
  });

  it('Datadog nginx → Sumo prod/web/nginx', () => {
    const datadog = getSIEMTarget('datadog')!;
    const sumo = getSIEMTarget('sumo-logic')!;
    const pivot = toOCSF(datadog, 'ddsource', 'nginx').ocsf;
    delete pivot._original;
    const r = fromOCSF(sumo, 'sumo.sourceCategory', pivot);
    expect(r.lossy).toBe(false);
    expect(r.nativeValue).toBe('prod/web/nginx');
  });
});
