/**
 * Datadog SIEM target — value-mappings.
 *
 * Datadog Logs Intake API accepts JSON with a small set of well-known
 * top-level fields: `ddsource`, `service`, `hostname`, `ddtags`, `message`.
 * `ddsource` is the closest equivalent to Splunk's sourcetype — it
 * identifies the technology emitting the log so Datadog can attach the
 * right out-of-the-box parsing pipeline.
 *
 * Source: https://docs.datadoghq.com/api/latest/logs/
 *         https://docs.datadoghq.com/logs/log_collection/ (integrations list)
 *
 * Scope: ~25 most common `ddsource` values across Datadog's 600+
 * integrations. Unmapped values pass through verbatim.
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

export const DATADOG_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'timestamp',
    'src_endpoint.hostname': 'hostname',
    'service.name': 'service',
    'metadata.log_name': 'ddsource',
    'src_endpoint.ip': 'network.client.ip',
    'dst_endpoint.ip': 'network.destination.ip',
    'src_endpoint.port': 'network.client.port',
    'dst_endpoint.port': 'network.destination.port'
  }
};

export const DATADOG_DDSOURCE_MAP: ValueMap = {
  taxonomy: 'ddsource',
  unmappedHandling: 'preserve',
  entries: {
    // System / OS
    syslog: { category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY },
    ssh: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      hint: 'sshd auth'
    },
    sudo: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    auth: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    audit: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      hint: 'auditd'
    },
    systemd: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    cron: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    kernel: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    },

    // Web servers
    nginx: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    apache: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    haproxy: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },

    // Mail
    postfix: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    sendmail: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },

    // DNS / DHCP
    bind: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    dnsmasq: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    dhcp: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DHCP_ACTIVITY
    },

    // Network / firewalls
    'palo-alto': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    cisco: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    juniper: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    fortinet: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },

    // Containers / k8s (popular Datadog use)
    docker: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    kubernetes: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },

    // Databases
    postgresql: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },
    mysql: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },
    redis: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },

    // Languages (common Datadog application sources)
    python: { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    java: { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    nodejs: { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    go: { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY },
    ruby: { category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY }
  }
};
