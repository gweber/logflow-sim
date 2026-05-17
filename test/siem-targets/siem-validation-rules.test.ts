import { describe, it, expect } from 'vitest';
import { validate } from '../../src/core/validate/index.js';
import type { IRModel, IROutput, IRStatement } from '../../src/core/ir/model.js';

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
    params: params as Record<string, never>,
    siemTarget,
    source: NO_SRC
  };
}

function setStmt(name: string): IRStatement {
  return {
    kind: 'Set',
    id: 's',
    source: NO_SRC,
    targetKind: 'structured',
    targetName: name,
    value: { kind: 'StringLit', value: 'x', source: NO_SRC } as never
  };
}

describe('SIEM-target validation rules', () => {
  describe('splunk/missing-sourcetype', () => {
    it('fires when no sourcetype param and no upstream set', () => {
      const model = emptyModel({
        outputs: [makeOutput('hec1', 'splunk_hec', 'splunk')]
      });
      const report = validate(model);
      const f = report.findings.find((d) => d.code === 'SIEM_SPLUNK_MISSING_SOURCETYPE');
      expect(f).toBeDefined();
    });

    it("doesn't fire when sourcetype is in output params", () => {
      const model = emptyModel({
        outputs: [makeOutput('hec1', 'splunk_hec', 'splunk', { sourcetype: 'linux:secure' })]
      });
      const report = validate(model);
      const f = report.findings.find((d) => d.code === 'SIEM_SPLUNK_MISSING_SOURCETYPE');
      expect(f).toBeUndefined();
    });

    it("doesn't fire when an upstream ruleset sets $!sourcetype", () => {
      const model = emptyModel({
        outputs: [makeOutput('hec1', 'splunk_hec', 'splunk')],
        rulesets: [
          {
            kind: 'Ruleset',
            id: 'r',
            name: 'r',
            statements: [setStmt('sourcetype')],
            params: {},
            source: NO_SRC
          }
        ]
      });
      const report = validate(model);
      const f = report.findings.find((d) => d.code === 'SIEM_SPLUNK_MISSING_SOURCETYPE');
      expect(f).toBeUndefined();
    });
  });

  describe('datadog/missing-service', () => {
    it('fires for Datadog output without service', () => {
      const model = emptyModel({
        outputs: [makeOutput('dd', 'datadog_logs', 'datadog')]
      });
      const report = validate(model);
      expect(report.findings.find((d) => d.code === 'SIEM_DATADOG_MISSING_SERVICE')).toBeDefined();
    });

    it('passes when upstream sets $!service', () => {
      const model = emptyModel({
        outputs: [makeOutput('dd', 'datadog_logs', 'datadog')],
        rulesets: [
          {
            kind: 'Ruleset',
            id: 'r',
            name: 'r',
            statements: [setStmt('service')],
            params: {},
            source: NO_SRC
          }
        ]
      });
      const report = validate(model);
      expect(
        report.findings.find((d) => d.code === 'SIEM_DATADOG_MISSING_SERVICE')
      ).toBeUndefined();
    });
  });

  describe('elastic-ecs/missing-event-dataset', () => {
    it('fires for ECS output without event.dataset', () => {
      const model = emptyModel({
        outputs: [makeOutput('es', 'elasticsearch', 'elastic-ecs')]
      });
      const report = validate(model);
      expect(
        report.findings.find((d) => d.code === 'SIEM_ECS_MISSING_EVENT_DATASET')
      ).toBeDefined();
    });
  });

  describe('loki/high-cardinality-label', () => {
    it('flags labels sourced from high-cardinality property refs', () => {
      const model = emptyModel({
        outputs: [
          makeOutput('lk', 'loki', 'loki', {
            labels: { user_label: '$!user' }
          })
        ]
      });
      const report = validate(model);
      expect(
        report.findings.find((d) => d.code === 'SIEM_LOKI_HIGH_CARDINALITY_LABEL')
      ).toBeDefined();
    });

    it('passes low-cardinality labels', () => {
      const model = emptyModel({
        outputs: [
          makeOutput('lk', 'loki', 'loki', {
            labels: { job: 'syslog', env: 'prod' }
          })
        ]
      });
      const report = validate(model);
      expect(
        report.findings.find((d) => d.code === 'SIEM_LOKI_HIGH_CARDINALITY_LABEL')
      ).toBeUndefined();
    });
  });

  describe('loki/no-labels', () => {
    it('fires for Loki output with empty labels', () => {
      const model = emptyModel({
        outputs: [makeOutput('lk', 'loki', 'loki', { labels: {} })]
      });
      const report = validate(model);
      expect(report.findings.find((d) => d.code === 'SIEM_LOKI_NO_LABELS')).toBeDefined();
    });
  });

  describe('graylog-gelf/custom-field-prefix', () => {
    it('fires when a non-reserved field lacks the underscore prefix', () => {
      const model = emptyModel({
        outputs: [
          makeOutput('g', 'gelf', 'graylog-gelf', {
            fields: { customField: 'x', _proper: 'y', host: 'reserved-ok' }
          })
        ]
      });
      const report = validate(model);
      const f = report.findings.find((d) => d.code === 'SIEM_GELF_CUSTOM_FIELD_PREFIX');
      expect(f).toBeDefined();
      expect(f!.message).toContain('customField');
    });
  });

  describe('siemTargets filter', () => {
    it("doesn't run SIEM rules when no matching output exists", () => {
      const model = emptyModel({
        outputs: [makeOutput('plain', 'omfile', '')]
      });
      const report = validate(model);
      const ran = report.ranRuleIds;
      // SIEM rules should be skipped — none of them ran
      expect(ran).not.toContain('splunk/missing-sourcetype');
      expect(ran).not.toContain('datadog/missing-service');
      expect(ran).not.toContain('loki/high-cardinality-label');
    });
  });
});
