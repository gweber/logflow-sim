/**
 * SIEM-target plugin registry.
 *
 * Mirrors src/core/dialects/registry.ts. Plugins are pure data, so a single
 * shared instance serves server, CLI, and worker contexts without state
 * leaks. Adding a new SIEM target is one import + one entry in the
 * SIEM_TARGETS map.
 */

import type { SIEMTarget } from './types.js';
import type { IRModel } from '../ir/model.js';
import { genericTarget } from './generic/index.js';
import { splunkTarget } from './splunk/index.js';
import { elasticEcsTarget } from './elastic-ecs/index.js';
import { datadogTarget } from './datadog/index.js';
import { lokiTarget } from './loki/index.js';
import { graylogGelfTarget } from './graylog-gelf/index.js';
import { microsoftSentinelTarget } from './microsoft-sentinel/index.js';
import { sumoLogicTarget } from './sumo-logic/index.js';

/**
 * The registry. Order is intentional — `generic` first so it shows up
 * as the safe default in pickers, then the most common destinations.
 */
const SIEM_TARGETS: Record<string, SIEMTarget> = {
  [genericTarget.id]: withComputedInverse(genericTarget),
  [splunkTarget.id]: withComputedInverse(splunkTarget),
  [elasticEcsTarget.id]: withComputedInverse(elasticEcsTarget),
  [datadogTarget.id]: withComputedInverse(datadogTarget),
  [lokiTarget.id]: withComputedInverse(lokiTarget),
  [graylogGelfTarget.id]: withComputedInverse(graylogGelfTarget),
  [microsoftSentinelTarget.id]: withComputedInverse(microsoftSentinelTarget),
  [sumoLogicTarget.id]: withComputedInverse(sumoLogicTarget)
};

/**
 * Compute `fieldMap.fromNative` from `toNative` if the plugin didn't
 * declare both directions. Done once at registry construction so the
 * runtime lookups are pure-data O(1).
 */
function withComputedInverse(t: SIEMTarget): SIEMTarget {
  if (t.fieldMap.fromNative) return t;
  const fromNative: Record<string, string> = {};
  for (const [canonical, native] of Object.entries(t.fieldMap.toNative)) {
    fromNative[native] = canonical;
  }
  return {
    ...t,
    fieldMap: { toNative: t.fieldMap.toNative, fromNative }
  };
}

export function registerSIEMTarget(target: SIEMTarget): void {
  SIEM_TARGETS[target.id] = withComputedInverse(target);
}

export function getSIEMTarget(id: string): SIEMTarget | undefined {
  return SIEM_TARGETS[id];
}

export function listSIEMTargets(): SIEMTarget[] {
  // Stable order: generic first, then alphabetical by id. Mirrors how
  // listDialects() returns dialects sorted but with a consistent UI default.
  const all = Object.values(SIEM_TARGETS);
  const generic = all.filter((t) => t.id === 'generic');
  const rest = all.filter((t) => t.id !== 'generic').sort((a, b) => a.id.localeCompare(b.id));
  return [...generic, ...rest];
}

/**
 * Detect which SIEM destination an IR model targets, based on the output
 * drivers it declares. Returns the highest-confidence match, or null when
 * no plugin recognizes any output driver.
 *
 * Algorithm:
 *   1. If the plugin provides a custom `detect()` hook, use it.
 *   2. Otherwise score by counting outputs whose driver appears in the
 *      plugin's `outputDrivers` list, divided by total outputs.
 *   3. Tie-break by registration order (stable).
 *
 * `generic` never wins detection — it's an explicit user choice, not an
 * inferred destination.
 */
export function detectSIEMTarget(
  model: IRModel
): { target: SIEMTarget; confidence: number } | null {
  let best: { target: SIEMTarget; confidence: number } | null = null;
  for (const target of listSIEMTargets()) {
    if (target.id === 'generic') continue;
    const score = target.detect ? target.detect(model) : defaultDetect(target, model);
    if (score > 0 && (!best || score > best.confidence)) {
      best = { target, confidence: score };
    }
  }
  return best;
}

/**
 * Default detection: count IROutputs (and IRActions, since rsyslog uses
 * actions for what other dialects call outputs) whose driver matches one
 * of the plugin's owned drivers. Normalized to 0..1 by total output count.
 */
function defaultDetect(target: SIEMTarget, model: IRModel): number {
  const drivers = new Set(target.outputDrivers.map((d) => d.toLowerCase()));
  let matches = 0;
  let total = 0;
  for (const out of model.outputs) {
    total++;
    if (drivers.has(out.driver.toLowerCase())) matches++;
  }
  // rsyslog: actions inside rulesets carry the equivalent driver info via
  // actionType. We walk each ruleset and inspect Action statements.
  for (const rs of model.rulesets) {
    walkActions(rs.statements, (a) => {
      total++;
      if (drivers.has(a.actionType.toLowerCase())) matches++;
    });
  }
  if (total === 0) return 0;
  return matches / total;
}

function walkActions(
  statements: IRModel['rulesets'][number]['statements'],
  visit: (a: { actionType: string }) => void
): void {
  for (const s of statements) {
    if (s.kind === 'Action') visit(s);
    else if (s.kind === 'If') {
      walkActions(s.then, visit);
      if (s.else) walkActions(s.else, visit);
    }
  }
}
