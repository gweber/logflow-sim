/**
 * Google Chronicle UDM renderer.
 *
 * Chronicle's Unified Data Model (UDM) is a strongly-typed structured
 * event format used by Google's SecOps platform. Wire shape: JSON with
 * three top-level groupings — `metadata`, `principal`, `target`,
 * `network`, `security_result` — and a metadata.event_type discriminator.
 *
 * Source: https://cloud.google.com/chronicle/docs/reference/udm-field-list
 *         https://cloud.google.com/chronicle/docs/unified-data-model/format-events-as-udm
 *
 * Scope: this renderer produces the core structural skeleton; mapping
 * UDM's hundreds of fields exhaustively is out of scope for v0.2.0. The
 * unmapped escape hatch ships everything else under
 * `additional.fields[]`.
 */

import type { SIEMTarget } from '../types.js';
import type { LogicalEvent } from './json.js';

/**
 * UDM top-level groupings. The renderer routes mapped OCSF paths into
 * these by inspecting the native path prefix.
 */
const UDM_GROUPS = new Set([
  'metadata',
  'principal',
  'target',
  'src',
  'observer',
  'network',
  'security_result',
  'additional'
]);

/**
 * Render a logical event as a UDM JSON object. We respect the native-
 * path hierarchy the field-map declares (`metadata.event_type`,
 * `principal.user.userid`, `target.ip`, etc.) and stuff anything that
 * doesn't fit into `additional.fields[]` so the upstream operator
 * still sees it in Chronicle.
 */
export function renderUDM(target: SIEMTarget, event: LogicalEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    metadata: { product_name: 'logflow-sim', event_type: 'GENERIC_EVENT' }
  };
  const additional: Array<{ key: string; value: { string_value: string } }> = [];

  for (const [ocsfPath, value] of Object.entries(event)) {
    const nativePath = target.fieldMap.toNative[ocsfPath];
    if (nativePath) {
      const top = nativePath.split('.')[0];
      if (UDM_GROUPS.has(top)) {
        setDotted(out, nativePath, value);
        continue;
      }
    }
    additional.push({
      key: ocsfPath,
      value: { string_value: String(value) }
    });
  }

  if (additional.length > 0) {
    (out.additional as Record<string, unknown>) = { fields: additional };
  }
  return out;
}

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
