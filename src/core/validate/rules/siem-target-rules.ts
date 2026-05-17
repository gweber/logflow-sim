/**
 * Per-SIEM-destination validation rules.
 *
 * These rules fire when a parsed model contains at least one output
 * whose `siemTarget` matches the rule's `siemTargets` filter. The aim
 * is to catch configurations that *would* work syntactically but
 * deliver the wrong shape to the destination — Splunk HEC outputs
 * without a sourcetype, ECS outputs without event.dataset, Loki labels
 * sourced from high-cardinality fields, and so on.
 *
 * Rules are intentionally narrow: each one targets a single
 * well-defined misuse with a clear remediation. PRs welcome to expand.
 */

import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { IRModel, IRStatement, IROutput } from '../../ir/model.js';
import {
  LOKI_RECOMMENDED_LABEL_FIELDS,
  LOKI_HIGH_CARDINALITY_FIELDS
} from '../../siem-targets/loki/mappings.js';
import { SENTINEL_CUSTOM_TABLE_REGEX } from '../../siem-targets/microsoft-sentinel/mappings.js';

const NO_SRC = { file: '<validator>', line: 0, col: 0, offset: 0, length: 0 };

/**
 * Returns true iff any ruleset assigns `$!fieldName` (case-insensitive)
 * in the model. Used to verify that a SIEM-required structured field is
 * actually populated upstream of the output.
 */
function structuredFieldIsSet(model: IRModel, fieldName: string): boolean {
  const wanted = fieldName.toLowerCase();
  let found = false;
  function walk(stmts: IRStatement[]): void {
    for (const s of stmts) {
      if (found) return;
      if (
        (s.kind === 'Set' || s.kind === 'Reset') &&
        s.targetKind === 'structured' &&
        s.targetName.toLowerCase() === wanted
      ) {
        found = true;
        return;
      }
      if (s.kind === 'If') {
        walk(s.then);
        if (s.else) walk(s.else);
      }
    }
  }
  for (const rs of model.rulesets) walk(rs.statements);
  return found;
}

/**
 * Returns the outputs whose `siemTarget` matches `targetId`. Used by
 * each rule's `run()` to locate the relevant outputs for diagnostics.
 */
function outputsFor(model: IRModel, targetId: string): IROutput[] {
  return model.outputs.filter((o) => o.siemTarget === targetId);
}

// ---------------------------------------------------------------------------
// Splunk
// ---------------------------------------------------------------------------

export const splunkMissingSourcetypeRule: ValidationRule = {
  id: 'splunk/missing-sourcetype',
  description:
    'A Splunk HEC output should either declare a sourcetype param or be ' +
    'fed a $!sourcetype value upstream — otherwise events land in `_unknown`.',
  defaultSeverity: 'warning',
  siemTargets: ['splunk'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const upstreamSourcetype = structuredFieldIsSet(model, 'sourcetype');
    for (const o of outputsFor(model, 'splunk')) {
      const hasParam =
        'sourcetype' in o.params || 'Sourcetype' in o.params || 'SOURCETYPE' in o.params;
      if (!hasParam && !upstreamSourcetype) {
        findings.push({
          severity: 'warning',
          code: 'SIEM_SPLUNK_MISSING_SOURCETYPE',
          message:
            `Splunk HEC output "${o.name}" has no sourcetype param and no ` +
            `upstream \`set $!sourcetype = ...\` was found. Events will land ` +
            `in Splunk's _unknown sourcetype and bypass field extractions.`,
          source: o.source
        });
      }
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Elastic ECS
// ---------------------------------------------------------------------------

export const ecsMissingEventDatasetRule: ValidationRule = {
  id: 'elastic-ecs/missing-event-dataset',
  description:
    'An Elastic/ECS output should set event.dataset (used by Elastic ' +
    'index-routing and dashboards).',
  defaultSeverity: 'info',
  siemTargets: ['elastic-ecs'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const upstream = structuredFieldIsSet(model, 'event_dataset') ||
      structuredFieldIsSet(model, 'event.dataset');
    for (const o of outputsFor(model, 'elastic-ecs')) {
      const hasParam =
        'event.dataset' in o.params ||
        'event_dataset' in o.params ||
        'dataset' in o.params;
      if (!hasParam && !upstream) {
        findings.push({
          severity: 'info',
          code: 'SIEM_ECS_MISSING_EVENT_DATASET',
          message:
            `ECS output "${o.name}" doesn't set event.dataset. Elastic uses ` +
            `this field for index-pattern routing; without it documents go ` +
            `to the catch-all index.`,
          source: o.source
        });
      }
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

export const datadogMissingServiceRule: ValidationRule = {
  id: 'datadog/missing-service',
  description:
    'A Datadog output should set `service` (unified service tagging). ' +
    'Without it, search/correlation in Datadog is significantly harder.',
  defaultSeverity: 'warning',
  siemTargets: ['datadog'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const upstream = structuredFieldIsSet(model, 'service');
    for (const o of outputsFor(model, 'datadog')) {
      const hasParam = 'service' in o.params;
      if (!hasParam && !upstream) {
        findings.push({
          severity: 'warning',
          code: 'SIEM_DATADOG_MISSING_SERVICE',
          message:
            `Datadog output "${o.name}" has no service param and no upstream ` +
            `\`set $!service = ...\`. Unified service tagging is the primary ` +
            `Datadog correlation axis — omitting it cripples search.`,
          source: o.source
        });
      }
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Loki
// ---------------------------------------------------------------------------

export const lokiHighCardinalityLabelRule: ValidationRule = {
  id: 'loki/high-cardinality-label',
  description:
    'Loki labels should be low cardinality. Sourcing a label from a ' +
    'high-cardinality field (user, trace_id, ip, etc.) explodes the index.',
  defaultSeverity: 'warning',
  siemTargets: ['loki'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const highCard = new Set(LOKI_HIGH_CARDINALITY_FIELDS);
    for (const o of outputsFor(model, 'loki')) {
      const labels = readParamAsObject(o.params, 'labels') ?? {};
      for (const [labelName, value] of Object.entries(labels)) {
        const v = String(value);
        // Heuristic: a label whose value is a property reference to a known
        // high-cardinality field is suspect.
        for (const hc of highCard) {
          if (v.includes('$!' + hc) || v.includes('$' + hc) || v.includes('%' + hc + '%')) {
            findings.push({
              severity: 'warning',
              code: 'SIEM_LOKI_HIGH_CARDINALITY_LABEL',
              message:
                `Loki label "${labelName}" on output "${o.name}" is sourced ` +
                `from "${hc}", a high-cardinality field. Move it to ` +
                `structured_metadata instead.`,
              source: o.source
            });
            break;
          }
        }
      }
    }
    return findings;
  }
};

export const lokiNoLabelsRule: ValidationRule = {
  id: 'loki/no-labels',
  description:
    'A Loki output without any labels collapses all events into a single ' +
    'stream and limits query parallelism.',
  defaultSeverity: 'info',
  siemTargets: ['loki'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const o of outputsFor(model, 'loki')) {
      const labels = readParamAsObject(o.params, 'labels');
      if (!labels || Object.keys(labels).length === 0) {
        findings.push({
          severity: 'info',
          code: 'SIEM_LOKI_NO_LABELS',
          message:
            `Loki output "${o.name}" declares no labels. Add at least one ` +
            `low-cardinality label (e.g. ${LOKI_RECOMMENDED_LABEL_FIELDS.slice(0, 3).join(', ')}) ` +
            `so streams can be queried independently.`,
          source: o.source
        });
      }
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Graylog GELF
// ---------------------------------------------------------------------------

export const gelfCustomFieldPrefixRule: ValidationRule = {
  id: 'graylog-gelf/custom-field-prefix',
  description:
    'GELF custom fields must start with an underscore. Non-underscore ' +
    'fields not in the reserved set are silently dropped by Graylog.',
  defaultSeverity: 'warning',
  siemTargets: ['graylog-gelf'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const reserved = new Set([
      'version',
      'host',
      'short_message',
      'full_message',
      'timestamp',
      'level',
      'facility'
    ]);
    for (const o of outputsFor(model, 'graylog-gelf')) {
      const fields = readParamAsObject(o.params, 'fields') ?? {};
      for (const fname of Object.keys(fields)) {
        if (!reserved.has(fname) && !fname.startsWith('_')) {
          findings.push({
            severity: 'warning',
            code: 'SIEM_GELF_CUSTOM_FIELD_PREFIX',
            message:
              `GELF custom field "${fname}" on output "${o.name}" lacks the ` +
              `underscore prefix required by GELF 1.1. Graylog will drop it.`,
            source: o.source
          });
        }
      }
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Microsoft Sentinel
// ---------------------------------------------------------------------------

export const sentinelInvalidTableNameRule: ValidationRule = {
  id: 'microsoft-sentinel/invalid-table-name',
  description:
    'A Sentinel DCR stream targets a table that must match `[A-Z][A-Za-z0-9]{1,44}_CL`.',
  defaultSeverity: 'error',
  siemTargets: ['microsoft-sentinel'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    for (const o of outputsFor(model, 'microsoft-sentinel')) {
      const candidates: unknown[] = [
        o.params['table'],
        o.params['Table'],
        o.params['stream'],
        o.params['Stream'],
        o.params['table_name']
      ];
      for (const c of candidates) {
        if (typeof c !== 'string' || c.length === 0) continue;
        if (!SENTINEL_CUSTOM_TABLE_REGEX.test(c) && !KNOWN_SENTINEL_STANDARD_TABLES.has(c)) {
          findings.push({
            severity: 'error',
            code: 'SIEM_SENTINEL_INVALID_TABLE_NAME',
            message:
              `Sentinel custom-log table name "${c}" on output "${o.name}" is ` +
              `invalid — must be a standard table (Syslog, SecurityEvent, …) ` +
              `or a custom table matching [A-Za-z][A-Za-z0-9]{1,44}_CL.`,
            source: o.source
          });
        }
      }
    }
    return findings;
  }
};

const KNOWN_SENTINEL_STANDARD_TABLES = new Set([
  'Syslog',
  'SecurityEvent',
  'CommonSecurityLog',
  'AzureActivity',
  'SigninLogs',
  'AuditLogs'
]);

// ---------------------------------------------------------------------------
// Sumo Logic
// ---------------------------------------------------------------------------

export const sumoMissingSourceCategoryRule: ValidationRule = {
  id: 'sumo-logic/missing-source-category',
  description:
    'Sumo Logic outputs should set _sourceCategory — it drives search, ' +
    'dashboards, and pipeline routing across the entire account.',
  defaultSeverity: 'warning',
  siemTargets: ['sumo-logic'],
  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    const upstream =
      structuredFieldIsSet(model, '_sourceCategory') ||
      structuredFieldIsSet(model, 'sourceCategory');
    for (const o of outputsFor(model, 'sumo-logic')) {
      const hasParam =
        '_sourceCategory' in o.params ||
        'sourceCategory' in o.params ||
        'category' in o.params;
      if (!hasParam && !upstream) {
        findings.push({
          severity: 'warning',
          code: 'SIEM_SUMO_MISSING_SOURCE_CATEGORY',
          message:
            `Sumo Logic output "${o.name}" has no _sourceCategory. ` +
            `Without it, events land in an unindexed default category and ` +
            `Sumo Field Extraction Rules can't fire.`,
          source: o.source
        });
      }
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------

export const SIEM_TARGET_RULES: ValidationRule[] = [
  splunkMissingSourcetypeRule,
  ecsMissingEventDatasetRule,
  datadogMissingServiceRule,
  lokiHighCardinalityLabelRule,
  lokiNoLabelsRule,
  gelfCustomFieldPrefixRule,
  sentinelInvalidTableNameRule,
  sumoMissingSourceCategoryRule
];

// ---------------------------------------------------------------------------
// Helpers

function readParamAsObject(
  params: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const v = params[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}
