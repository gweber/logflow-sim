/**
 * Elastic Common Schema (ECS) SIEM target — value-mappings.
 *
 * Source vocabulary: ECS field hierarchy with `event.category` (array) and
 * `event.type` (subcategory) as the primary taxonomy. ECS uses dotted
 * field paths and has hundreds of defined fields — we cover the most
 * common ~30 routing-relevant ones.
 *
 * Source:
 *   - ECS 8 reference: https://www.elastic.co/guide/en/ecs/8.17/
 *   - event.category allowed values: https://www.elastic.co/docs/reference/ecs/ecs-allowed-values-event-category
 *   - AWS Security Lake ECS↔OCSF crosswalk: https://docs.aws.amazon.com/security-lake/latest/userguide/open-cybersecurity-schema-framework.html
 */

import type { ValueMap, FieldMap } from '../types.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../ocsf.js';

/**
 * ECS field map. ECS uses dotted hierarchical paths (host.hostname,
 * source.ip, event.category) — they line up well with OCSF's nested
 * structure but with different vocabulary on the leaves.
 */
export const ELASTIC_ECS_FIELD_MAP: FieldMap = {
  toNative: {
    'metadata.original_time': '@timestamp',
    'src_endpoint.hostname': 'host.hostname',
    'src_endpoint.ip': 'source.ip',
    'src_endpoint.port': 'source.port',
    'dst_endpoint.ip': 'destination.ip',
    'dst_endpoint.port': 'destination.port',
    'service.name': 'service.name',
    'service.version': 'service.version',
    'metadata.product.name': 'observer.product',
    'metadata.product.vendor_name': 'observer.vendor',
    'metadata.log_name': 'event.dataset'
  }
};

/**
 * ECS event.category taxonomy. ECS treats event.category as an array of
 * one or more top-level buckets; we map to the singular primary bucket
 * here. Renderers that want to emit multi-category values can do so by
 * combining multiple entries.
 *
 * Allowed event.category values (subset, ECS 8.17):
 *   authentication, configuration, database, driver, email, file, host,
 *   iam, intrusion_detection, malware, network, package, process,
 *   registry, session, threat, vulnerability, web, api
 */
export const ELASTIC_ECS_CATEGORY_MAP: ValueMap = {
  taxonomy: 'ecs.event.category',
  unmappedHandling: 'preserve',
  entries: {
    // event.category : OCSF class mapping
    authentication: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION
    },
    iam: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.ACCOUNT_CHANGE
    },
    process: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY
    },
    file: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.FILE_SYSTEM_ACTIVITY
    },
    host: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },
    network: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    web: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    email: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.EMAIL_ACTIVITY
    },
    database: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY
    },
    session: {
      category_uid: OCSF_CATEGORIES.IAM,
      class_uid: OCSF_CLASSES.AUTHENTICATION,
      hint: 'session lifecycle'
    },
    api: {
      category_uid: OCSF_CATEGORIES.APPLICATION_ACTIVITY,
      class_uid: OCSF_CLASSES.HTTP_ACTIVITY
    },
    threat: {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    intrusion_detection: {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    malware: {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    vulnerability: {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    configuration: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },
    package: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },
    registry: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },
    driver: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.KERNEL_ACTIVITY
    }
  }
};

/**
 * Bonus: ECS knows DNS/DHCP/SSH/FTP/RDP as event.type subdivisions of
 * event.category=network. We expose a parallel value-map keyed by
 * `ecs.event.type` so dialects that distinguish at the type-level get
 * lossless round-trips.
 */
export const ELASTIC_ECS_TYPE_MAP: ValueMap = {
  taxonomy: 'ecs.event.type',
  unmappedHandling: 'preserve',
  entries: {
    connection: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    protocol: {
      category_uid: OCSF_CATEGORIES.NETWORK_ACTIVITY,
      class_uid: OCSF_CLASSES.NETWORK_ACTIVITY
    },
    info: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY
    },
    error: {
      category_uid: OCSF_CATEGORIES.FINDINGS
    },
    start: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      activity_id: 1
    },
    end: {
      category_uid: OCSF_CATEGORIES.SYSTEM_ACTIVITY,
      class_uid: OCSF_CLASSES.PROCESS_ACTIVITY,
      activity_id: 2
    }
  }
};
