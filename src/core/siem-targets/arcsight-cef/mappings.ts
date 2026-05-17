/**
 * ArcSight (CEF) SIEM target — value-mappings.
 *
 * CEF events carry classification in the header via `eventClassID` and
 * `name` slots. Vendors use their own conventions; for syslog-shaped
 * sources we model a small set of common event-class IDs that map to
 * OCSF classes.
 *
 * Source: ArcSight CEF Implementation Standard (Micro Focus / OpenText)
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

/**
 * CEF uses fixed short field names: `src` (source IP), `spt` (source
 * port), `dst`, `dpt`, `suser` (source user), `duser` (dest user), etc.
 */
export const CEF_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'rt',
    'src_endpoint.ip': 'src',
    'src_endpoint.hostname': 'shost',
    'src_endpoint.port': 'spt',
    'dst_endpoint.ip': 'dst',
    'dst_endpoint.hostname': 'dhost',
    'dst_endpoint.port': 'dpt',
    'service.name': 'app'
  }
};

export const CEF_EVENT_CLASS_MAP: ValueMap = {
  taxonomy: 'cef.eventClassID',
  unmappedHandling: 'preserve',
  entries: {
    'auth.login.success': {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      activity_id: 1
    },
    'auth.login.failure': {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      activity_id: 2
    },
    'firewall.accept': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY,
      activity_id: 1
    },
    'firewall.deny': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY,
      activity_id: 2
    },
    'http.request': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    'dns.query': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    'dhcp.ack': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },
    'mail.delivery': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    'process.start': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      activity_id: 1
    }
  }
};
