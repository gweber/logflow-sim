/**
 * Detection-impact engine.
 *
 * Runs a set of SigmaRules against a batch of messages — optionally also
 * an overlaid-model batch — and reports the firing counts. The unique
 * value-prop versus a stock SIEM:
 *
 *   "Before this config change the rule fired 47×/hour against this
 *    corpus. After the change: 12×/hour. Delta: −74%."
 *
 * The reason for the delta lives in the routing layer (a programname
 * lookup got dropped, a hostname normalization changed, etc.) — the
 * engine reports the WHAT; the operator infers the WHY by jumping into
 * the simulator with one of the per-rule sample messages.
 */

import type { SyslogMessage } from '../simulate/syslog-message.js';
import type { SigmaRule } from './types.js';
import { matches } from './sigma-matcher.js';

export interface DetectionFireSample {
  /** 1-based index in the input batch. */
  index: number;
  programname?: string;
  hostname?: string;
  msg?: string;
}

export interface DetectionRuleReport {
  id?: string;
  title: string;
  level?: string;
  tags?: string[];
  /** How many messages in the batch the rule fired on. */
  fires: number;
  /** Up to N concrete examples for drill-down. */
  samples: DetectionFireSample[];
}

export interface DetectionImpactReport {
  /** Per-rule firing counts. */
  rules: DetectionRuleReport[];
  /** Messages processed (after maxMessages cap). */
  processed: number;
  /** Wall time of the impact run, milliseconds. */
  durationMs: number;
}

export interface DetectionImpactOptions {
  maxMessages?: number;
  samplesPerRule?: number;
}

const DEFAULT_MAX = 50_000;
const DEFAULT_SAMPLES = 5;

export function detectionImpact(input: {
  rules: SigmaRule[];
  messages: SyslogMessage[];
  options?: DetectionImpactOptions;
}): DetectionImpactReport {
  const t0 = Date.now();
  const max = input.options?.maxMessages ?? DEFAULT_MAX;
  const sampleCap = input.options?.samplesPerRule ?? DEFAULT_SAMPLES;
  const slice = input.messages.slice(0, max);

  const reports: DetectionRuleReport[] = input.rules.map((r) => ({
    id: r.id,
    title: r.title,
    level: r.level,
    tags: r.tags,
    fires: 0,
    samples: []
  }));

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    for (let r = 0; r < input.rules.length; r++) {
      const rule = input.rules[r];
      let hit = false;
      try {
        hit = matches(rule, { message: m });
      } catch {
        // A pathological condition expression should not take the whole
        // batch down. The rule is treated as "did not fire" for this
        // message; the operator sees a 0-fires entry and can investigate.
        hit = false;
      }
      if (hit) {
        const report = reports[r];
        report.fires++;
        if (report.samples.length < sampleCap) {
          report.samples.push({
            index: i + 1,
            programname: m.programname,
            hostname: m.hostname,
            msg: m.msg?.slice(0, 200)
          });
        }
      }
    }
  }

  return { rules: reports, processed: slice.length, durationMs: Date.now() - t0 };
}

export interface DetectionDiffEntry {
  id?: string;
  title: string;
  level?: string;
  baseline: number;
  overlay: number;
  delta: number;
  pctChange: number;
  baselineSamples: DetectionFireSample[];
  overlaySamples: DetectionFireSample[];
}

export interface DetectionDiffReport {
  baseline: DetectionImpactReport;
  overlay: DetectionImpactReport;
  entries: DetectionDiffEntry[];
  /** Rules that fire fewer times under overlay (likely-coverage regressions). */
  regressionsCount: number;
}

/**
 * Compare two impact reports — same rule set, same message batch, two
 * model variants — and emit a delta-sorted entry per rule.
 *
 * Note: the message batch isn't replayed twice (it's the same input on
 * both sides). The reason a Sigma rule fires more or less under overlay
 * comes from upstream routing differences — typically the overlay drops
 * messages onto a different ruleset that mutates `$programname` or
 * structured fields the rule looks at, OR adds enrichment that the rule
 * keys on. This engine produces the data; the simulator explains the why
 * for a specific affected message.
 */
export function detectionDiff(input: {
  rules: SigmaRule[];
  baselineMessages: SyslogMessage[];
  overlayMessages: SyslogMessage[];
  options?: DetectionImpactOptions;
}): DetectionDiffReport {
  const baseline = detectionImpact({
    rules: input.rules,
    messages: input.baselineMessages,
    options: input.options
  });
  const overlay = detectionImpact({
    rules: input.rules,
    messages: input.overlayMessages,
    options: input.options
  });
  const entries: DetectionDiffEntry[] = baseline.rules.map((b, i) => {
    const o = overlay.rules[i];
    const delta = o.fires - b.fires;
    const pctChange = b.fires === 0 ? (o.fires === 0 ? 0 : 100) : Math.round((delta / b.fires) * 1000) / 10;
    return {
      id: b.id,
      title: b.title,
      level: b.level,
      baseline: b.fires,
      overlay: o.fires,
      delta,
      pctChange,
      baselineSamples: b.samples,
      overlaySamples: o.samples
    };
  });
  entries.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    baseline,
    overlay,
    entries,
    regressionsCount: entries.filter((e) => e.delta < 0).length
  };
}
