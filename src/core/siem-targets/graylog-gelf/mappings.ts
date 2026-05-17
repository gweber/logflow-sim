/**
 * Graylog GELF SIEM target — value-mappings.
 *
 * GELF carries category/classification primarily via the `facility`
 * field (syslog facility name) plus custom `_` prefixed fields. Our
 * primary taxonomy here is `gelf.facility` — the standard syslog
 * facility names ("auth", "mail", "daemon", "kern", …).
 *
 * Source: https://go2docs.graylog.org/current/getting_in_log_data/gelf_format.html
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

export const GELF_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'timestamp',
    'src_endpoint.hostname': 'host',
    'service.name': 'facility',
    'metadata.log_name': 'short_message'
  }
};

/**
 * Standard syslog facility names mapped to OCSF classes. Facilities
 * are well-defined by RFC 5424 / 3164 — no vendor-specific entries
 * needed.
 */
export const GELF_FACILITY_MAP: ValueMap = {
  taxonomy: 'gelf.facility',
  unmappedHandling: 'preserve',
  entries: {
    auth: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    authpriv: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    cron: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    daemon: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    kern: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    },
    mail: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    news: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },
    syslog: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },
    user: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },
    uucp: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },
    ftp: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.FTP_ACTIVITY
    },
    ntp: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY
    },
    'local0': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local1': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local2': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local3': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local4': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local5': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local6': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    'local7': { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY }
  }
};
