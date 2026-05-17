/**
 * QRadar LEEF 2.0 renderer.
 *
 * LEEF (Log Event Extended Format) is IBM QRadar's preferred normalized
 * format. Wire shape:
 *
 *   LEEF:2.0|Vendor|Product|Version|EventID|Delimiter|key1=v1<TAB>key2=v2…
 *
 * The header is pipe-delimited; the body is delimited by either tab (the
 * default) or whatever character is specified in the Delimiter slot.
 *
 * Source: https://www.ibm.com/docs/en/dsm?topic=overview-leef-event-components
 */

import type { SIEMTarget } from '../types.js';
import type { LogicalEvent } from './json.js';

const DEFAULT_DELIMITER = '\t';

export interface LeefHeader {
  vendor?: string;
  product?: string;
  version?: string;
  eventID?: string;
}

/**
 * Render a logical event as a LEEF 2.0 string. The first four header
 * slots default to placeholders when missing; LEEF tooling will accept
 * them but flag them as "unknown vendor/product" in the parser.
 */
export function renderLEEF(
  target: SIEMTarget,
  event: LogicalEvent,
  header?: LeefHeader,
  delimiter: string = DEFAULT_DELIMITER
): string {
  const h: LeefHeader = {
    vendor: header?.vendor ?? 'logflow-sim',
    product: header?.product ?? 'unknown',
    version: header?.version ?? '0',
    eventID: header?.eventID ?? '0'
  };

  const parts: string[] = [];
  for (const [ocsfPath, value] of Object.entries(event)) {
    const nativePath = target.fieldMap.toNative[ocsfPath];
    const key = nativePath ?? ocsfPath;
    // LEEF keys are flat; dotted OCSF paths get collapsed to camelCase
    // approximations (src_endpoint.ip → srcIP, dst_endpoint.ip → dstIP)
    const flatKey = collapseKey(key);
    parts.push(`${flatKey}=${escapeValue(String(value), delimiter)}`);
  }

  // Header per LEEF 2.0; explicit delimiter slot only when non-default
  const delimSlot = delimiter === DEFAULT_DELIMITER ? '' : delimiter;
  const headerLine = `LEEF:2.0|${h.vendor}|${h.product}|${h.version}|${h.eventID}|${delimSlot}`;
  return parts.length === 0 ? headerLine : `${headerLine}|${parts.join(delimiter)}`;
}

function collapseKey(key: string): string {
  // src_endpoint.ip → srcIp ; metadata.original_time → metadataOriginalTime
  return key
    .replace(/[._]+(.)/g, (_, c) => (c as string).toUpperCase())
    .replace(/^src/, 'src')
    .replace(/^dst/, 'dst');
}

function escapeValue(v: string, delimiter: string): string {
  // LEEF requires escaping the delimiter and equals signs inside values
  return v.replace(new RegExp(`[\\\\${escapeRegex(delimiter)}=\\n]`, 'g'), (m) => '\\' + m);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
