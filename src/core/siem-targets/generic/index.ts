/**
 * Generic / passthrough SIEM target.
 *
 * The mandatory escape hatch. Use this when:
 *   - the user explicitly doesn't want any value rewriting
 *   - the source SIEM couldn't be detected and we don't want to guess
 *   - the user is exporting to a vendor we don't yet support
 *
 * Field maps are empty; the renderer passes every field through as-is.
 * Value maps are also empty, so `retagValue(generic → X)` lossy-passes,
 * and `retagValue(X → generic)` returns the original value verbatim.
 */

import type { SIEMTarget } from '../types.js';

export const genericTarget: SIEMTarget = {
  id: 'generic',
  displayName: 'Generic (passthrough)',
  vendor: '—',
  outputDrivers: [],
  fieldMap: { toNative: {} },
  valueMaps: {},
  rendering: 'passthrough',
  // Generic should never be detected. It's an explicit choice.
  detect: () => 0
};
