/**
 * Loki SIEM target — value-mappings.
 *
 * Loki's model differs significantly from row-based SIEMs: events are
 * keyed by *labels* (low cardinality, indexed) and the body is a free-
 * form log line plus optional *structured metadata* (higher cardinality,
 * not indexed). Best practice: ≤10 label values total per label, keep
 * dynamic/high-cardinality fields in structured metadata.
 *
 * The `loki.label` taxonomy here covers values used as routing labels
 * (job, service, environment). The `loki.streammeta` taxonomy is
 * informational — Loki doesn't restrict structured-metadata vocabulary,
 * so we mostly preserve.
 *
 * Source: https://grafana.com/docs/loki/latest/get-started/labels/
 *         https://grafana.com/docs/loki/latest/get-started/labels/structured-metadata/
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

/**
 * Loki push-API field map. Loki has a flatter shape than ECS — labels
 * sit at the top level of the stream definition.
 */
export const LOKI_FIELD_MAP: FieldMap = {
  toNative: {
    'src_endpoint.hostname': 'host',
    'service.name': 'service',
    'metadata.log_name': 'job',
    'metadata.product.name': 'app'
  }
};

/**
 * Loki "job" label conventions. Most Loki deployments use job to
 * distinguish log streams at the routing level. We map well-known job
 * names to OCSF classes; unknown jobs preserve.
 */
export const LOKI_LABEL_MAP: ValueMap = {
  taxonomy: 'loki.label',
  unmappedHandling: 'preserve',
  entries: {
    auth: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    sshd: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    syslog: { category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY },
    kernel: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    },
    cron: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    nginx: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    apache: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    mail: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    dns: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    dhcp: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },
    firewall: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    audit: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    kubernetes: { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    docker: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    }
  }
};

/**
 * Fields typically used as Loki labels at low cardinality. Used by the
 * validation rule to flag high-cardinality misuse.
 */
export const LOKI_RECOMMENDED_LABEL_FIELDS = [
  'job',
  'service',
  'environment',
  'env',
  'region',
  'cluster',
  'namespace',
  'app',
  'component'
];

/**
 * Fields known to be high-cardinality and should NOT be Loki labels —
 * they belong in structured metadata.
 */
export const LOKI_HIGH_CARDINALITY_FIELDS = [
  'user',
  'username',
  'uid',
  'trace_id',
  'span_id',
  'request_id',
  'session_id',
  'order_id',
  'customer_id',
  'ip',
  'src_ip',
  'dest_ip',
  'host_ip',
  'pid'
];
