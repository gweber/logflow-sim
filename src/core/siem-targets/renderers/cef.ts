/**
 * ArcSight CEF 0 renderer.
 *
 * CEF (Common Event Format) is the de-facto standard for security-event
 * normalization, originally ArcSight, now used by HP ESM, Splunk
 * Add-ons, Microsoft Sentinel CommonSecurityLog, and others. Wire shape:
 *
 *   CEF:0|Vendor|Product|Version|EventClassID|Name|Severity|key1=v1 key2=v2…
 *
 * The header is strictly pipe-delimited (7 slots); the body is
 * space-separated key=value pairs. Severity is integer 0-10.
 *
 * Source: https://community.microfocus.com/cyberres/arcsight/w/arcsight-product-documentation
 */

import type { SIEMTarget } from '../types.js';
import type { LogicalEvent } from './json.js';

export interface CefHeader {
  vendor?: string;
  product?: string;
  version?: string;
  eventClassID?: string;
  name?: string;
  /** Integer 0-10 — out-of-range values fall back to 5 and emit a diagnostic upstream. */
  severity?: number;
}

const PIPE_ESCAPE_RE = /[\\|]/g;
const KV_ESCAPE_RE = /[\\=\n]/g;

/**
 * Render a logical event as a CEF 0 string. Header slots get sensible
 * placeholders when unspecified.
 */
export function renderCEF(target: SIEMTarget, event: LogicalEvent, header?: CefHeader): string {
  const h: CefHeader = {
    vendor: escapeHeader(header?.vendor ?? 'logflow-sim'),
    product: escapeHeader(header?.product ?? 'unknown'),
    version: escapeHeader(header?.version ?? '0'),
    eventClassID: escapeHeader(header?.eventClassID ?? '0'),
    name: escapeHeader(header?.name ?? 'event'),
    severity: clampSeverity(header?.severity ?? 5)
  };

  const parts: string[] = [];
  for (const [ocsfPath, value] of Object.entries(event)) {
    const nativePath = target.fieldMap.toNative[ocsfPath];
    const key = nativePath ?? ocsfPath;
    const cefKey = collapseKey(key);
    parts.push(`${cefKey}=${escapeKV(String(value))}`);
  }

  const head = `CEF:0|${h.vendor}|${h.product}|${h.version}|${h.eventClassID}|${h.name}|${h.severity}`;
  return parts.length === 0 ? head : `${head}|${parts.join(' ')}`;
}

function collapseKey(key: string): string {
  // CEF uses fixed short field names (src, dst, spt, dpt, suser, …).
  // We collapse OCSF dotted paths to camelCase as a best-effort.
  return key.replace(/[._]+(.)/g, (_, c) => (c as string).toUpperCase());
}

function escapeHeader(v: string): string {
  return v.replace(PIPE_ESCAPE_RE, (m) => '\\' + m);
}

function escapeKV(v: string): string {
  return v.replace(KV_ESCAPE_RE, (m) => '\\' + m);
}

function clampSeverity(s: number): number {
  if (!Number.isFinite(s)) return 5;
  if (s < 0) return 0;
  if (s > 10) return 10;
  return Math.round(s);
}
