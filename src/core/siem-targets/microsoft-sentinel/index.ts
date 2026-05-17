/**
 * Microsoft Sentinel SIEM target.
 *
 * Sentinel sits on top of Azure Log Analytics workspaces. Custom logs
 * are routed via Data Collection Rules (DCRs) into `*_CL` tables. We
 * model the table name as the primary taxonomy axis.
 *
 * Authentication uses Azure AD (out of scope for logflow-sim). Output
 * drivers we recognize: rsyslog's `omhttp` configured against an Azure
 * Monitor Logs Ingestion endpoint, OTel's `azuremonitor` exporter,
 * Vector's `azure_monitor_logs` sink, Fluent Bit's `azure_logs_ingestion`
 * output, Logstash's `microsoft-sentinel-logstash-output-plugin`.
 */

import type { SIEMTarget } from '../types.js';
import { SENTINEL_FIELD_MAP, SENTINEL_TABLE_MAP } from './mappings.js';

export const microsoftSentinelTarget: SIEMTarget = {
  id: 'microsoft-sentinel',
  displayName: 'Microsoft Sentinel',
  vendor: 'Microsoft',
  outputDrivers: [
    'azuremonitor',
    'azure_monitor_logs',
    'azure_logs_ingestion',
    'sentinel',
    'azure_sentinel'
  ],
  fieldMap: SENTINEL_FIELD_MAP,
  valueMaps: {
    'sentinel.table': SENTINEL_TABLE_MAP
  },
  rendering: 'json',
  passthroughFields: ['TenantId', 'SubscriptionId', 'ResourceId', 'TimeGenerated'],
  defaults: {
    requiredFields: ['TimeGenerated'],
    placeholders: {
      dcr_endpoint: 'https://<dce>.<region>.ingest.monitor.azure.com',
      dcr_immutable_id: '${SENTINEL_DCR_ID}',
      stream_name: 'Custom-${TABLE_NAME}',
      bearer_token: '${SENTINEL_AAD_TOKEN}'
    }
  }
};
