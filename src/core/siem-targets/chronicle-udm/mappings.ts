/**
 * Google Chronicle (UDM) SIEM target — value-mappings.
 *
 * Chronicle classifies events via `metadata.event_type` — an enum of
 * UDM event types (NETWORK_CONNECTION, USER_LOGIN, FILE_MODIFICATION,
 * PROCESS_LAUNCH, DNS_QUERY, …). The `udm.event_type` taxonomy here
 * carries the most common ones.
 *
 * Source: https://cloud.google.com/chronicle/docs/reference/udm-field-list
 *         https://cloud.google.com/chronicle/docs/unified-data-model/udm-usage
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

export const UDM_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'metadata.event_timestamp',
    'metadata.product.name': 'metadata.product_name',
    'metadata.product.vendor_name': 'metadata.vendor_name',
    'metadata.log_name': 'metadata.event_type',
    'src_endpoint.ip': 'principal.ip',
    'src_endpoint.hostname': 'principal.hostname',
    'src_endpoint.port': 'principal.port',
    'dst_endpoint.ip': 'target.ip',
    'dst_endpoint.hostname': 'target.hostname',
    'dst_endpoint.port': 'target.port',
    'service.name': 'principal.application'
  }
};

export const UDM_EVENT_TYPE_MAP: ValueMap = {
  taxonomy: 'udm.event_type',
  unmappedHandling: 'preserve',
  entries: {
    USER_LOGIN: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    USER_UNCATEGORIZED: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    PROCESS_LAUNCH: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      activity_id: 1
    },
    PROCESS_TERMINATION: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      activity_id: 2
    },
    FILE_MODIFICATION: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.FILE_SYSTEM_ACTIVITY
    },
    FILE_READ: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.FILE_SYSTEM_ACTIVITY
    },
    NETWORK_CONNECTION: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    NETWORK_HTTP: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    NETWORK_DNS: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    NETWORK_DHCP: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },
    EMAIL_TRANSACTION: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    SCAN_NETWORK: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.SCAN_ACTIVITY
    },
    SCAN_HOST: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.SCAN_ACTIVITY
    }
  }
};

/**
 * Whitelist of UDM event_type values accepted by Chronicle. Used by the
 * validation rule.
 */
export const UDM_KNOWN_EVENT_TYPES = new Set(Object.keys(UDM_EVENT_TYPE_MAP.entries).concat([
  'GENERIC_EVENT',
  'STATUS_HEARTBEAT',
  'STATUS_STARTUP',
  'STATUS_SHUTDOWN',
  'SETTING_MODIFICATION'
]));
