/**
 * Replay engine — runs a batch of messages through `simulate()` and
 * produces an aggregate report. No per-message traces are kept; the goal
 * is "where do real logs go in this config?", answered in O(messages)
 * memory for the aggregates plus a small fixed-size sample pool.
 */

import type { IRModel } from '../ir/model.js';
import type { LookupTableData } from '../lookups/types.js';
import type { SyslogMessage } from '../simulate/syslog-message.js';
import { simulate } from '../simulate/evaluator.js';
import type { SimulationOutput } from '../simulate/evaluator.js';
import type { ReplayOptions, ReplayReport, ReplaySample } from './types.js';

const DEFAULT_MAX_MESSAGES = 50_000;
const DEFAULT_SAMPLES = 5;
const TOP_N = 10;

export interface ReplayInput {
  model: IRModel;
  lookupTables: Record<string, LookupTableData>;
  messages: SyslogMessage[];
  options?: ReplayOptions;
}

export function replay(input: ReplayInput): ReplayReport {
  const { model, lookupTables, messages, options = {} } = input;
  const max = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const sampleCap = options.samplesPerBucket ?? DEFAULT_SAMPLES;

  const t0 = Date.now();
  const total = messages.length;
  const slice = messages.slice(0, max);
  const processed = slice.length;

  let delivered = 0;
  let noInputMatch = 0;
  let errors = 0;
  let noOutput = 0;

  const programCounts = new Map<string, number>();
  const hostnameCounts = new Map<string, number>();
  const rulesetCounts = new Map<string, number>();
  const outputCounts = new Map<string, { kind: string; target: string; count: number }>();

  const unmatchedSamples: ReplaySample[] = [];
  const noOutputSamples: ReplaySample[] = [];
  const errorSamples: ReplaySample[] = [];

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    bump(programCounts, m.programname || '<none>');
    bump(hostnameCounts, m.hostname || '<none>');

    try {
      const res = simulate({
        model,
        lookupTables,
        message: m,
        forceRuleset: options.forceRuleset
      });

      if (!res.selectedRuleset) {
        noInputMatch++;
        pushSample(unmatchedSamples, sampleCap, i, m, 'no input matched');
        continue;
      }
      bump(rulesetCounts, res.selectedRuleset);

      if (res.finalState.outputs.length === 0) {
        noOutput++;
        pushSample(noOutputSamples, sampleCap, i, m, 'ruleset ran but no outputs');
        continue;
      }

      delivered++;
      for (const o of res.finalState.outputs) recordOutput(outputCounts, o);
    } catch (e) {
      errors++;
      pushSample(errorSamples, sampleCap, i, m, (e as Error).message);
    }
  }

  return {
    total,
    processed,
    delivered,
    noInputMatch,
    errors,
    noOutput,
    durationMs: Date.now() - t0,
    topPrograms: topN(programCounts, processed, TOP_N),
    topHostnames: topN(hostnameCounts, processed, TOP_N),
    perRuleset: topN(rulesetCounts, processed, TOP_N),
    perOutput: topOutputs(outputCounts, TOP_N),
    unmatchedSamples,
    noOutputSamples,
    errorSamples
  };
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function recordOutput(
  m: Map<string, { kind: string; target: string; count: number }>,
  o: SimulationOutput
): void {
  const target =
    o.kind === 'omfile'
      ? o.path ?? '<unresolved>'
      : o.kind === 'omfwd'
        ? `${o.target ?? '?'}:${o.port ?? '?'}/${o.protocol ?? '?'}`
        : (o.target ?? o.path ?? o.template ?? o.kind);
  const key = `${o.kind}|${target}`;
  const cur = m.get(key);
  if (cur) cur.count++;
  else m.set(key, { kind: o.kind, target, count: 1 });
}

function topN(
  m: Map<string, number>,
  denominator: number,
  n: number
): { key: string; count: number; pct: number }[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({
      key,
      count,
      pct: denominator > 0 ? Math.round((count / denominator) * 1000) / 10 : 0
    }));
}

function topOutputs(
  m: Map<string, { kind: string; target: string; count: number }>,
  n: number
): { kind: string; target: string; count: number }[] {
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

function pushSample(
  bucket: ReplaySample[],
  cap: number,
  idx: number,
  m: SyslogMessage,
  reason: string
): void {
  if (bucket.length >= cap) return;
  bucket.push({
    index: idx + 1,
    programname: m.programname,
    hostname: m.hostname,
    msg: m.msg?.slice(0, 200),
    reason
  });
}
