/**
 * OCSF pivot helpers.
 *
 * Two operations: convert a native taxonomy value to the OCSF pivot
 * (`toOCSF`) and convert the pivot back to a target's native vocabulary
 * (`fromOCSF`). Together they form the cross-vendor translation primitive:
 *
 *   target.fromOCSF(source.toOCSF(value))
 *
 * Both functions are pure — they take the plugin instance and a value, and
 * return a result with a lossiness flag. Diagnostics are produced by the
 * caller (the kernel orchestration in `rewriteLookupValue`).
 */

import type { OCSFEvent } from './ocsf.js';
import type { SIEMTarget, TaxonomyId, ToOCSFResult, FromOCSFResult } from './types.js';

/**
 * Translate a native value into an OCSF pivot using the source plugin's
 * value-map for the given taxonomy. When the taxonomy is unknown or the
 * value has no entry, returns a lossy result that the renderer can decide
 * to passthrough or drop.
 */
export function toOCSF(
  source: SIEMTarget,
  taxonomy: TaxonomyId,
  value: string
): ToOCSFResult {
  const valueMap = source.valueMaps[taxonomy];
  if (!valueMap) {
    return {
      ocsf: {
        _original: { taxonomy, value, siemId: source.id }
      },
      lossy: true,
      originalValue: value
    };
  }

  const entry = valueMap.entries[value] ?? valueMap.catchAll;
  if (!entry) {
    return {
      ocsf: {
        _original: { taxonomy, value, siemId: source.id }
      },
      lossy: true,
      originalValue: value
    };
  }

  const ocsf: OCSFEvent = {
    _original: { taxonomy, value, siemId: source.id }
  };
  if (entry.category_uid !== undefined) ocsf.category_uid = entry.category_uid;
  if (entry.class_uid !== undefined) ocsf.class_uid = entry.class_uid;
  if (entry.activity_id !== undefined) ocsf.activity_id = entry.activity_id;
  if (entry.hint !== undefined) {
    ocsf.unmapped = { hint: entry.hint };
  }

  return { ocsf, lossy: false, originalValue: value };
}

/**
 * Translate an OCSF pivot into a target's native vocabulary for the given
 * taxonomy. When the target doesn't know the taxonomy or no entry matches
 * the OCSF class, returns a lossy result. Same-vendor pivots (source ===
 * target) short-circuit to the original value to avoid round-tripping
 * cleanup.
 */
export function fromOCSF(
  target: SIEMTarget,
  taxonomy: TaxonomyId,
  ocsf: OCSFEvent
): FromOCSFResult {
  // Same-vendor fast path: if the OCSF carries an _original tag from this
  // same SIEM, just re-emit the original value verbatim. Avoids precision
  // loss for plugin-internal vocabularies that happen to round-trip cleanly.
  if (ocsf._original && ocsf._original.siemId === target.id && ocsf._original.taxonomy === taxonomy) {
    return { nativeValue: ocsf._original.value, lossy: false };
  }

  const valueMap = target.valueMaps[taxonomy];
  if (!valueMap) {
    // Target has no opinion on this taxonomy; preserve the original or drop
    // it based on the source's unmapped-handling default. Default: preserve.
    const fallback = ocsf._original?.value ?? '';
    return { nativeValue: fallback, lossy: true };
  }

  // Find the native value whose OCSF mapping matches the pivot. If the
  // pivot carries class_uid, prefer the entry with the matching class; if
  // it has only category_uid, fall back to the first entry in the same
  // category. This handles plugins that classify at different granularities.
  const candidates = Object.entries(valueMap.entries);
  let exact = candidates.find(
    ([, ref]) =>
      ocsf.class_uid !== undefined &&
      ref.class_uid === ocsf.class_uid &&
      (ocsf.activity_id === undefined || ref.activity_id === undefined || ref.activity_id === ocsf.activity_id)
  );
  if (!exact && ocsf.category_uid !== undefined) {
    exact = candidates.find(([, ref]) => ref.category_uid === ocsf.category_uid);
  }

  if (exact) {
    return { nativeValue: exact[0], lossy: false };
  }

  // No mapping. Honor the target's unmapped-handling policy.
  if (valueMap.unmappedHandling === 'drop') {
    return { nativeValue: '', lossy: true };
  }
  const fallback = ocsf._original?.value ?? '';
  return { nativeValue: fallback, lossy: true };
}

/**
 * Convenience: end-to-end retag of a single value. Used by the kernel's
 * `rewriteLookupValue` helper when iterating rows of a taxonomy-tagged
 * lookup table.
 *
 * Returns the rewritten native value plus a combined lossiness flag — the
 * caller emits a single diagnostic per lossy row, not per pivot half.
 */
export function retagValue(
  source: SIEMTarget,
  target: SIEMTarget,
  taxonomy: TaxonomyId,
  value: string
): { value: string; lossy: boolean } {
  if (source.id === target.id) {
    return { value, lossy: false };
  }
  const pivot = toOCSF(source, taxonomy, value);
  const rendered = fromOCSF(target, taxonomy, pivot.ocsf);
  return {
    value: rendered.nativeValue,
    lossy: pivot.lossy || rendered.lossy
  };
}
