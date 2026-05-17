/**
 * Grafana Loki SIEM target.
 *
 * Loki ingests via the `/loki/api/v1/push` endpoint. Events are keyed
 * by stream labels (low cardinality, indexed) and contain a free-form
 * log line plus optional structured metadata. The 2024+ structured-
 * metadata feature is now standard and lets us carry high-cardinality
 * fields without inflating the label index.
 *
 * Recognized output drivers: Vector's `loki` sink, OTel's `loki`
 * exporter, Fluent Bit's `loki` output, Logstash's `loki` output,
 * Promtail's `clients` block (which is the canonical case — but
 * Promtail->Loki is the same dialect family, so this mostly catches
 * cross-pipeline pushes).
 */

import type { SIEMTarget } from '../types.js';
import { LOKI_FIELD_MAP, LOKI_LABEL_MAP } from './mappings.js';

export const lokiTarget: SIEMTarget = {
  id: 'loki',
  displayName: 'Grafana Loki',
  vendor: 'Grafana Labs',
  outputDrivers: ['loki', 'grafana_loki'],
  fieldMap: LOKI_FIELD_MAP,
  valueMaps: {
    'loki.label': LOKI_LABEL_MAP
  },
  rendering: 'json',
  passthroughFields: ['cluster', 'namespace', 'pod', 'container', 'app'],
  defaults: {
    requiredFields: ['job'],
    placeholders: {
      loki_endpoint: 'http://loki.example.com:3100/loki/api/v1/push',
      tenant_id: '${LOKI_TENANT_ID}'
    }
  }
};
