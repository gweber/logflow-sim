/**
 * IBM QRadar (LEEF) SIEM target — value-mappings.
 *
 * LEEF events carry their classification in the header's `EventID`
 * slot. QRadar's DSM (Device Support Module) library defines vendor-
 * specific event-ID conventions; for syslog-shaped sources the
 * canonical convention is to use a short uppercase mnemonic
 * (LOGIN_SUCCESS, AUTH_FAIL, FW_TRAFFIC, …).
 *
 * Source: https://www.ibm.com/docs/en/dsm?topic=overview-leef-event-components
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

export const LEEF_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'devTime',
    'src_endpoint.hostname': 'srcHost',
    'src_endpoint.ip': 'src',
    'src_endpoint.port': 'srcPort',
    'dst_endpoint.ip': 'dst',
    'dst_endpoint.port': 'dstPort',
    'service.name': 'cat'
  }
};

export const LEEF_EVENT_ID_MAP: ValueMap = {
  taxonomy: 'leef.eventId',
  unmappedHandling: 'preserve',
  entries: {
    LOGIN_SUCCESS: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      activity_id: 1
    },
    LOGIN_FAILURE: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      activity_id: 2
    },
    AUTH_FAIL: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      activity_id: 2
    },
    FW_ACCEPT: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY,
      activity_id: 1
    },
    FW_DENY: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY,
      activity_id: 2
    },
    FW_TRAFFIC: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    HTTP_REQUEST: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    DNS_QUERY: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    DHCP_ACK: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },
    MAIL_DELIVERED: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    PROCESS_START: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    }
  }
};
