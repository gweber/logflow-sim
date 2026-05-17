/**
 * Default JSON renderer.
 *
 * Used by SIEM targets whose wire format is "structured JSON with
 * vendor-specific field names": Splunk HEC, Elastic ECS, Datadog, Loki,
 * Sentinel, Sumo. The renderer takes a logical event and the target
 * plugin's field map, and produces a JSON object with the target's
 * preferred field paths.
 *
 * For pipe-format targets (LEEF, CEF) and Chronicle UDM, dedicated
 * renderers live alongside this one — they share the same input shape
 * but produce a different wire payload.
 */

import type { SIEMTarget } from '../types.js';

/**
 * Logical event passed into the renderer. Sparse — only the fields the
 * caller has actually populated. Keys are OCSF-style dotted paths
 * (`src_endpoint.ip`, `service.name`).
 */
export type LogicalEvent = Record<string, unknown>;

/**
 * Render a logical event into the target's native JSON shape.
 *
 * Walks the input keys, looks up each one in the target's `fieldMap.toNative`
 * (OCSF → native path), and writes the value at the native dotted path.
 * Keys not in the map fall under `unmapped.<originalKey>` so the consumer
 * can still surface them; the caller decides whether to log a diagnostic.
 */
export function renderJSON(target: SIEMTarget, event: LogicalEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unmapped: Record<string, unknown> = {};

  for (const [ocsfPath, value] of Object.entries(event)) {
    const nativePath = target.fieldMap.toNative[ocsfPath];
    if (nativePath) {
      setDotted(out, nativePath, value);
    } else if (target.passthroughFields?.includes(ocsfPath)) {
      setDotted(out, ocsfPath, value);
    } else {
      unmapped[ocsfPath] = value;
    }
  }

  if (Object.keys(unmapped).length > 0) {
    out.unmapped = unmapped;
  }
  return out;
}

/**
 * Assign `value` at `path` (e.g. `src_endpoint.ip` → obj.src_endpoint.ip)
 * inside `obj`, creating intermediate objects as needed. Mutates `obj`.
 */
function setDotted(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]] = value;
}
