/**
 * Google Chronicle / SecOps SIEM target (Unified Data Model).
 *
 * Chronicle ingests events as UDM (Unified Data Model) JSON via its
 * malachite (forwarder) or unstructured-log push APIs. Events have a
 * strongly-typed shape with `metadata.event_type` as the primary
 * discriminator.
 *
 * Recognized output drivers: rsyslog's `omhttp` to Chronicle's
 * ingest endpoint, the Chronicle Forwarder agent (not modelled — runs
 * on the wire), Vector's `gcp_chronicle_logging` sink, Logstash's
 * `google_cloud_chronicle` output.
 */

import type { SIEMTarget } from '../types.js';
import { UDM_FIELD_MAP, UDM_EVENT_TYPE_MAP } from './mappings.js';

export const chronicleUdmTarget: SIEMTarget = {
  id: 'chronicle-udm',
  displayName: 'Google Chronicle (UDM)',
  vendor: 'Google',
  outputDrivers: [
    'chronicle',
    'gcp_chronicle',
    'gcp_chronicle_logging',
    'google_cloud_chronicle',
    'chronicle_forwarder'
  ],
  fieldMap: UDM_FIELD_MAP,
  valueMaps: {
    'udm.event_type': UDM_EVENT_TYPE_MAP
  },
  rendering: 'udm',
  passthroughFields: ['security_result', 'additional', 'observer'],
  defaults: {
    requiredFields: ['metadata.event_type', 'metadata.event_timestamp'],
    placeholders: {
      api_endpoint: 'https://malachiteingestion-pa.googleapis.com',
      customer_id: '${CHRONICLE_CUSTOMER_ID}',
      auth_credentials: '${CHRONICLE_SERVICE_ACCOUNT}'
    }
  }
};
