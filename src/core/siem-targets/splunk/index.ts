/**
 * Splunk SIEM target.
 *
 * Splunk's HTTP Event Collector (HEC) accepts JSON events with optional
 * metadata fields (sourcetype, index, host, source, time). The actual
 * payload lives under `event`. Authentication is a bearer token in the
 * Authorization header — out of scope for logflow-sim, which only models
 * the *shape* of the destination.
 *
 * Detection: we recognize a config as Splunk-targeted when its output
 * drivers include splunk_hec, splunk_hec_logs, or omsplunkhec. The rsyslog
 * `omsplunkhec` module, OTel `splunk_hec` exporter, and Vector
 * `splunk_hec_logs` sink all land in the same bucket.
 */

import type { SIEMTarget } from '../types.js';
import { SPLUNK_FIELD_MAP, SPLUNK_SOURCETYPE_MAP } from './mappings.js';

export const splunkTarget: SIEMTarget = {
  id: 'splunk',
  displayName: 'Splunk',
  vendor: 'Splunk',
  outputDrivers: [
    'splunk_hec',
    'splunk_hec_logs',
    'omsplunkhec',
    'splunk'
  ],
  fieldMap: SPLUNK_FIELD_MAP,
  valueMaps: {
    sourcetype: SPLUNK_SOURCETYPE_MAP
  },
  rendering: 'json',
  passthroughFields: ['index', 'source', 'host'],
  defaults: {
    requiredFields: ['sourcetype'],
    placeholders: {
      hec_token: '${SPLUNK_HEC_TOKEN}',
      hec_endpoint: 'https://splunk.example.com:8088/services/collector'
    }
  }
};
