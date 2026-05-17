/**
 * Splunk SIEM target — value-mappings.
 *
 * Source vocabulary: Splunk's `sourcetype` taxonomy, which uses the
 * `vendor:product` convention (linux:secure, nginx:access, cisco:asa).
 * Mappings derived from Splunk Common Information Model (CIM) categories
 * and Splunk Add-on documentation.
 *
 * Source:
 *   - Splunk CIM data models: https://docs.splunk.com/Documentation/CIM/latest
 *   - Splunk OCSF mapping: https://github.com/splunk/ocsf-content
 *
 * Scope: the most common ~30 sourcetypes that appear in real-world routing
 * decisions. Unmapped sourcetypes flow through `preserve` (default).
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

/**
 * Splunk HEC field map: Splunk's metadata fields plus the event body.
 * https://docs.splunk.com/Documentation/Splunk/latest/Data/FormateventsforHTTPEventCollector
 */
export const SPLUNK_FIELD_MAP: FieldMap = {
  toNative: {
    // OCSF canonical → Splunk HEC native
    'metadata.original_time': 'time',
    'src_endpoint.hostname': 'host',
    'service.name': 'source',
    'metadata.log_name': 'sourcetype',
    'src_endpoint.ip': 'src_ip',
    'dst_endpoint.ip': 'dest_ip',
    'src_endpoint.port': 'src_port',
    'dst_endpoint.port': 'dest_port'
  }
};

/**
 * Splunk sourcetype → OCSF class mapping. Used when retagging Splunk-style
 * lookup-table values into another SIEM's vocabulary.
 *
 * Conventions:
 *   - `linux:*` → System Activity or IAM depending on subsystem
 *   - `cisco:*`, `pan:*`, `juniper:*`, `f5:*` → Network Activity
 *   - `bind:*`, `isc:*`, `dhcpd:*` → Network Activity (DNS/DHCP)
 *   - `nginx:*`, `apache:*`, `haproxy:*` → Web/HTTP Activity
 *   - `mail:*` → Email Activity
 */
export const SPLUNK_SOURCETYPE_MAP: ValueMap = {
  taxonomy: 'sourcetype',
  unmappedHandling: 'preserve',
  entries: {
    // Linux system
    'linux:secure': {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      hint: 'auth-related: sshd, sudo, su, login'
    },
    'linux:cron': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      hint: 'scheduled job'
    },
    'linux:kernel': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    },
    'linux:systemd': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      hint: 'service manager'
    },
    'linux:audit': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      hint: 'auditd'
    },
    'linux:messages': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },

    // Web servers
    'nginx:access': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    'nginx:error': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.WEB_RESOURCES_ACTIVITY
    },
    'apache:access': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    'apache:error': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.WEB_RESOURCES_ACTIVITY
    },
    'haproxy:access': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY,
      hint: 'load-balancer'
    },

    // Mail
    'mail:postfix': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    'sendmail:syslog': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },

    // DNS / DHCP
    'bind:query': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    'isc:dhcp': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },

    // Firewalls
    'pan:traffic': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY,
      hint: 'palo-alto firewall'
    },
    'pan:threat': {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    'cisco:asa': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    'cisco:ios': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    'juniper:srx': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    'f5:bigip': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },

    // Catch-all for unclassified network traffic
    'network:unclassified': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    }
  }
};
