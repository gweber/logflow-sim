/**
 * Sumo Logic SIEM target — value-mappings.
 *
 * Sumo Logic classifies incoming events via three "source" axes set as
 * HTTP headers or JSON fields:
 *   - `_sourceCategory`: free-form category (often the primary taxonomy)
 *   - `_sourceName`: file path or logical event source
 *   - `_sourceHost`: originating host
 *
 * `_sourceCategory` is the closest analog to Splunk's sourcetype.
 *
 * Source: https://help.sumologic.com/docs/send-data/hosted-collectors/http-source/
 *         https://help.sumologic.com/docs/manage/fields/
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

export const SUMO_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': 'timestamp',
    'src_endpoint.hostname': '_sourceHost',
    'service.name': '_sourceName',
    'metadata.log_name': '_sourceCategory'
  }
};

/**
 * Sumo's _sourceCategory convention is `slash/separated/paths` like
 * `prod/linux/auth` or `aws/cloudtrail`. We map a small set of canonical
 * paths; everything else preserves.
 */
export const SUMO_SOURCE_CATEGORY_MAP: ValueMap = {
  taxonomy: 'sumo.sourceCategory',
  unmappedHandling: 'preserve',
  entries: {
    'prod/linux/auth': {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    'prod/linux/cron': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    'prod/linux/kernel': {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    },
    'prod/linux/syslog': { category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY },
    'prod/web/nginx': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    'prod/web/apache': {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    'prod/mail/postfix': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    'prod/dns/bind': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.DNS_ACTIVITY
    },
    'prod/firewall': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    'aws/cloudtrail': {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.ACCOUNT_CHANGE
    },
    'aws/vpc/flowlogs': {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    }
  }
};
