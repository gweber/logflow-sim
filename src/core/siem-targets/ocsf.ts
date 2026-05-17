/**
 * OCSF pivot model.
 *
 * The Open Cybersecurity Schema Framework (https://schema.ocsf.io) is a
 * vendor-agnostic event taxonomy backed by Splunk, AWS, IBM, and 15+ other
 * security vendors. logflow-sim uses it as a *pivot schema* during retag:
 * every SIEM target plugin maps to/from OCSF, never to other plugins
 * directly, keeping the mapping surface at O(N) instead of O(N²).
 *
 * We model a small subset — just enough to round-trip the common log-routing
 * vocabulary (sourcetype, ECS event.category, GELF facility, Datadog source,
 * etc.). The full OCSF schema has hundreds of fields; we don't aim for full
 * conformance, only enough fidelity to translate routing-significant values.
 *
 * Source: https://schema.ocsf.io/1.5.0
 */

/**
 * OCSF top-level category. Values match `category_uid` in the OCSF spec.
 * https://schema.ocsf.io/1.5.0/categories
 */
export const OCSF_CATEGORIES = {
  SYSTEM_ACTIVITY: 1,
  FINDINGS: 2,
  IAM: 3,
  NETWORK_ACTIVITY: 4,
  DISCOVERY: 5,
  APPLICATION_ACTIVITY: 6
} as const;

/**
 * OCSF event classes we care about for log-routing translation. Only the
 * classes that actually show up in syslog/HEC/GELF/etc. taxonomies are
 * included; the security-finding classes are out of scope.
 */
export const OCSF_CLASSES = {
  // System Activity (category 1)
  FILE_SYSTEM_ACTIVITY: 1001,
  KERNEL_ACTIVITY: 1003,
  PROCESS_ACTIVITY: 1007,

  // IAM (category 3)
  AUTHENTICATION: 3002,
  AUTHORIZATION: 3003,
  ACCOUNT_CHANGE: 3001,

  // Network Activity (category 4)
  NETWORK_ACTIVITY: 4001,
  HTTP_ACTIVITY: 4002,
  DNS_ACTIVITY: 4003,
  DHCP_ACTIVITY: 4004,
  SMTP_ACTIVITY: 4009,
  SSH_ACTIVITY: 4007,
  FTP_ACTIVITY: 4008,
  RDP_ACTIVITY: 4005,
  EMAIL_ACTIVITY: 4009,

  // Application Activity (category 6)
  WEB_RESOURCES_ACTIVITY: 6001,
  APPLICATION_LIFECYCLE: 6002,
  SCAN_ACTIVITY: 6007
} as const;

/**
 * Minimal OCSF event pivot. Carries just the fields we translate across SIEM
 * vocabularies. Anything a source plugin can't classify ends up in
 * `unmapped` and is dropped or passed through verbatim, depending on the
 * target plugin's policy.
 */
export interface OCSFEvent {
  /** Top-level OCSF category — see OCSF_CATEGORIES. */
  category_uid?: number;
  /** Finer-grained class within the category — see OCSF_CLASSES. */
  class_uid?: number;
  /** Activity within the class (e.g. login attempt, login success). */
  activity_id?: number;
  /** Severity level: 0=unknown, 1=informational, 2=low, 3=medium, 4=high, 5=critical, 6=fatal. */
  severity_id?: number;

  /** Logical service / product producing the event. */
  service?: { name?: string; version?: string };

  /** Source endpoint of the activity. */
  src_endpoint?: { ip?: string; hostname?: string; port?: number };

  /** Destination endpoint of the activity. */
  dst_endpoint?: { ip?: string; hostname?: string; port?: number };

  /** Metadata about the event itself. */
  metadata?: {
    product?: { name?: string; vendor_name?: string };
    original_time?: string;
    log_name?: string;
    profiles?: string[];
  };

  /**
   * Escape hatch: any fields a source plugin couldn't classify into the
   * canonical shape land here. Target plugins may inspect this for
   * vendor-specific passthrough or ignore it entirely.
   */
  unmapped?: Record<string, unknown>;

  /**
   * The original native value before translation, preserved so passthrough
   * renderers can re-emit when source and target are the same vendor.
   */
  _original?: { taxonomy: string; value: string; siemId: string };
}

/**
 * Convenience: empty OCSF event. Used as a "no classification" pivot when
 * upstream value extraction fails.
 */
export function emptyOCSFEvent(): OCSFEvent {
  return {};
}

/**
 * Tiny lookup so renderers can map an OCSF severity_id back to a human label.
 * Some SIEM targets want strings ("warning", "critical"), some want ints.
 */
export const OCSF_SEVERITY_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'informational',
  2: 'low',
  3: 'medium',
  4: 'high',
  5: 'critical',
  6: 'fatal'
};
