import { describe, it, expect } from 'vitest';
import {
  getSIEMTarget,
  listSIEMTargets,
  detectSIEMTarget,
  registerSIEMTarget
} from '../../src/core/siem-targets/registry.js';
import type { IRModel, IROutput } from '../../src/core/ir/model.js';

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

function output(driver: string, name = 'o1'): IROutput {
  return {
    kind: 'Output',
    id: name,
    name,
    driver,
    actionKind: 'unknown',
    params: {},
    source: { file: 'x', line: 1, col: 1, offset: 0, length: 0 }
  };
}

describe('SIEM target registry', () => {
  it('lists generic first, then alphabetical', () => {
    const ids = listSIEMTargets().map((t) => t.id);
    expect(ids[0]).toBe('generic');
    const rest = ids.slice(1);
    const sorted = [...rest].sort();
    expect(rest).toEqual(sorted);
  });

  it('looks up known targets by id', () => {
    expect(getSIEMTarget('splunk')?.id).toBe('splunk');
    expect(getSIEMTarget('elastic-ecs')?.id).toBe('elastic-ecs');
    expect(getSIEMTarget('generic')?.id).toBe('generic');
    expect(getSIEMTarget('nope')).toBeUndefined();
  });

  it('computes fieldMap.fromNative from toNative when absent', () => {
    const splunk = getSIEMTarget('splunk')!;
    expect(splunk.fieldMap.fromNative).toBeDefined();
    // Spot-check the inverse direction
    expect(splunk.fieldMap.fromNative!['host']).toBe('src_endpoint.hostname');
  });
});

describe('detectSIEMTarget', () => {
  it('detects Splunk from a HEC output driver', () => {
    const model = emptyModel({ outputs: [output('splunk_hec_logs')] });
    const detected = detectSIEMTarget(model);
    expect(detected?.target.id).toBe('splunk');
    expect(detected?.confidence).toBe(1);
  });

  it('detects Elastic from an elasticsearch driver', () => {
    const model = emptyModel({ outputs: [output('elasticsearch')] });
    const detected = detectSIEMTarget(model);
    expect(detected?.target.id).toBe('elastic-ecs');
  });

  it('returns null when nothing matches', () => {
    const model = emptyModel({ outputs: [output('omfile')] });
    const detected = detectSIEMTarget(model);
    expect(detected).toBeNull();
  });

  it('never returns generic from detection', () => {
    // generic has empty outputDrivers, so default scoring is always 0.
    // The explicit `id === 'generic'` guard in detectSIEMTarget protects
    // against a custom detect() hook returning >0.
    const model = emptyModel({ outputs: [output('omfile')] });
    const detected = detectSIEMTarget(model);
    expect(detected?.target.id).not.toBe('generic');
  });

  it('runs custom detect() hook when provided', () => {
    let called = 0;
    registerSIEMTarget({
      id: 'test-custom',
      displayName: 'Test',
      vendor: 'test',
      outputDrivers: [],
      fieldMap: { toNative: {} },
      valueMaps: {},
      rendering: 'json',
      detect: () => {
        called++;
        return 0.9;
      }
    });
    const model = emptyModel({ outputs: [output('omfile')] });
    const detected = detectSIEMTarget(model);
    expect(called).toBeGreaterThan(0);
    expect(detected?.target.id).toBe('test-custom');
  });
});
