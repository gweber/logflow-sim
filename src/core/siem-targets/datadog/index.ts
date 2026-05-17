/**
 * Datadog SIEM target.
 *
 * Datadog accepts logs via its HTTP Intake API. JSON payload with
 * top-level fields `message`, `ddsource`, `service`, `hostname`,
 * `ddtags`. `ddsource` triggers Datadog's out-of-the-box parsing
 * pipelines — it's the closest analog to Splunk's sourcetype.
 *
 * Recognized output drivers: rsyslog's `omhttp` (when targeting
 * http-intake.logs.datadoghq.com), OTel's `datadog` exporter, Vector's
 * `datadog_logs` sink, Fluent Bit's `datadog` output, Logstash's
 * `datadog_logs` output.
 */

import type { SIEMTarget } from '../types.js';
import { DATADOG_FIELD_MAP, DATADOG_DDSOURCE_MAP } from './mappings.js';

export const datadogTarget: SIEMTarget = {
  id: 'datadog',
  displayName: 'Datadog',
  vendor: 'Datadog',
  outputDrivers: ['datadog', 'datadog_logs', 'datadog_agent'],
  fieldMap: DATADOG_FIELD_MAP,
  valueMaps: {
    ddsource: DATADOG_DDSOURCE_MAP
  },
  rendering: 'json',
  passthroughFields: ['ddtags', 'service', 'env', 'version'],
  defaults: {
    requiredFields: ['ddsource', 'service'],
    placeholders: {
      api_key: '${DD_API_KEY}',
      intake_endpoint: 'https://http-intake.logs.datadoghq.com/api/v2/logs'
    }
  }
};
