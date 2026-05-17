/**
 * Microsoft Sentinel SIEM target — value-mappings.
 *
 * Sentinel ingests logs into Log Analytics workspace tables. Custom logs
 * use Data Collection Rules (DCRs) to route incoming events into specific
 * `*_CL` (custom log) tables. The table name is the primary classification
 * axis — `SyslogAuth_CL` vs `SyslogWeb_CL` is the Sentinel equivalent of
 * `sourcetype=linux:secure` vs `nginx:access`.
 *
 * Source: https://learn.microsoft.com/azure/azure-monitor/logs/custom-logs-overview
 *         https://learn.microsoft.com/azure/sentinel/data-connectors-reference
 *
 * Scope: common custom-table names + the two standard syslog tables
 * Sentinel ships out of the box (`Syslog`, `SecurityEvent`). Real
 * deployments customize heavily; the unmapped path preserves.
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

export const SENTINEL_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'TimeGenerated',
    'src_endpoint.hostname': 'Computer',
    'src_endpoint.ip': 'SourceIP',
    'dst_endpoint.ip': 'DestinationIP',
    'src_endpoint.port': 'SourcePort',
    'dst_endpoint.port': 'DestinationPort',
    'service.name': 'ProcessName',
    'metadata.log_name': 'Type'
  }
};

/**
 * Common Sentinel custom-log table names. All `_CL` per Microsoft's
 * convention for custom tables.
 */
export const SENTINEL_TABLE_MAP: ValueMap = {
  taxonomy: 'sentinel.table',
  unmappedHandling: 'preserve',
  entries: {
    Syslog: { category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY },
    SyslogAuth_CL: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    SyslogCron_CL: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    SyslogKernel_CL: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    },
    SyslogWeb_CL: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    SyslogMail_CL: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    SyslogDNS_CL: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    SyslogDHCP_CL: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },
    SyslogFirewall_CL: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    SecurityEvent: {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    CommonSecurityLog: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY,
      hint: 'CEF in CommonSecurityLog'
    },
    AzureActivity: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.ACCOUNT_CHANGE
    },
    SigninLogs: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    }
  }
};

/**
 * DCR custom-log table name regex: must match `^[A-Za-z][A-Za-z0-9]{1,44}_CL$`
 * — used by the validation rule.
 */
export const SENTINEL_CUSTOM_TABLE_REGEX = /^[A-Za-z][A-Za-z0-9]{1,44}_CL$/;
