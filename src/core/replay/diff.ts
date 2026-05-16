/**
 * Replay-diff engine — runs the same message batch through two model
 * variants ("baseline" + "overlay") and reports both aggregates plus the
 * routing delta.
 *
 * Routing delta semantics:
 *   • output deltas: net change in message count per (kind, target) bucket
 *   • ruleset deltas: same, keyed by ruleset name
 *   • route changes: set of messages whose output-bucket signature differs
 *     between baseline and overlay (a "move" — same input, different sink)
 *
 * We deliberately keep this engine pure: it operates on already-built
 * IRModel + lookupTable pairs and SyslogMessage[]. Constructing the
 * overlaid model from a base VFS + an overlay map is the caller's job —
 * the API route does that with `buildOverlayedModel()` below.
 */

import type { VFS } from '../vfs.js';
import type { IRModel } from '../ir/model.js';
import type { LookupTableData } from '../lookups/types.js';
import type { SyslogMessage } from '../simulate/syslog-message.js';
import { simulate } from '../simulate/evaluator.js';
import { load } from '../kernel.js';
import { MemoryVFS } from '../vfs/memory.js';
import { replay } from './engine.js';
import type { ReplayReport } from './types.js';

export interface OverlayBundle {
  /**
   * Map of vfs-path → replacement-content. Paths use the same scheme as the
   * config tree — e.g. "rsyslog.conf" or "etc/rsyslog.d/10-catchall.conf".
   * A leading slash is tolerated.
   */
  [path: string]: string;
}

export interface DiffBucketDelta {
  key: string;
  baseline: number;
  overlay: number;
  delta: number;
}

export interface DiffOutputDelta {
  kind: string;
  target: string;
  baseline: number;
  overlay: number;
  delta: number;
}

export interface DiffSample {
  index: number;
  programname?: string;
  hostname?: string;
  msg?: string;
  baselineOutputs: string[];
  overlayOutputs: string[];
}

export interface ReplayDiffReport {
  baseline: ReplayReport;
  overlay: ReplayReport;

  /** Per-output deltas, sorted by absolute delta descending. */
  outputDeltas: DiffOutputDelta[];
  /** Per-ruleset deltas, sorted by absolute delta descending. */
  rulesetDeltas: DiffBucketDelta[];

  /** Messages whose output-bucket signature changed between the two runs. */
  routeChanges: number;
  /** Pure category transitions on the matched/delivered axis. */
  movedToDelivered: number;
  movedToUnmatched: number;
  /** Up to N concrete examples of route changes for drill-down. */
  routeChangeSamples: DiffSample[];
}

const ROUTE_SAMPLE_CAP = 10;

export function replayDiff(input: {
  baseline: { model: IRModel; lookupTables: Record<string, LookupTableData> };
  overlay: { model: IRModel; lookupTables: Record<string, LookupTableData> };
  messages: SyslogMessage[];
  options?: { maxMessages?: number; samplesPerBucket?: number };
}): ReplayDiffReport {
  const baselineReport = replay({
    model: input.baseline.model,
    lookupTables: input.baseline.lookupTables,
    messages: input.messages,
    options: input.options
  });
  const overlayReport = replay({
    model: input.overlay.model,
    lookupTables: input.overlay.lookupTables,
    messages: input.messages,
    options: input.options
  });

  // Per-message routing diff — capped to the same prefix the aggregator saw
  // (so we never compare ghost messages from the maxMessages-truncated tail).
  const max = Math.max(baselineReport.processed, overlayReport.processed);
  const slice = input.messages.slice(0, max);

  let routeChanges = 0;
  let movedToDelivered = 0;
  let movedToUnmatched = 0;
  const samples: DiffSample[] = [];

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const a = signatureFor(m, input.baseline);
    const b = signatureFor(m, input.overlay);
    if (a.key === b.key) continue;
    routeChanges++;
    if (a.delivered && !b.delivered) movedToUnmatched++;
    else if (!a.delivered && b.delivered) movedToDelivered++;
    if (samples.length < ROUTE_SAMPLE_CAP) {
      samples.push({
        index: i + 1,
        programname: m.programname,
        hostname: m.hostname,
        msg: m.msg?.slice(0, 200),
        baselineOutputs: a.outputs,
        overlayOutputs: b.outputs
      });
    }
  }

  return {
    baseline: baselineReport,
    overlay: overlayReport,
    outputDeltas: computeOutputDeltas(baselineReport, overlayReport),
    rulesetDeltas: computeBucketDeltas(baselineReport.perRuleset, overlayReport.perRuleset),
    routeChanges,
    movedToDelivered,
    movedToUnmatched,
    routeChangeSamples: samples
  };
}

function signatureFor(
  m: SyslogMessage,
  ctx: { model: IRModel; lookupTables: Record<string, LookupTableData> }
): { key: string; outputs: string[]; delivered: boolean } {
  try {
    const r = simulate({ model: ctx.model, lookupTables: ctx.lookupTables, message: m });
    const outs = r.finalState.outputs
      .map((o) =>
        o.kind === 'omfile'
          ? `omfile:${o.path ?? '?'}`
          : o.kind === 'omfwd'
            ? `omfwd:${o.target ?? '?'}:${o.port ?? '?'}/${o.protocol ?? '?'}`
            : `${o.kind}:${o.target ?? o.path ?? o.template ?? '?'}`
      )
      .sort();
    return {
      key: r.selectedRuleset ? `rs=${r.selectedRuleset}|${outs.join(',')}` : 'unmatched',
      outputs: outs,
      delivered: outs.length > 0 && !!r.selectedRuleset
    };
  } catch {
    return { key: 'error', outputs: [], delivered: false };
  }
}

function computeOutputDeltas(
  baseline: ReplayReport,
  overlay: ReplayReport
): DiffOutputDelta[] {
  const merged = new Map<string, DiffOutputDelta>();
  for (const o of baseline.perOutput) {
    merged.set(`${o.kind}|${o.target}`, {
      kind: o.kind,
      target: o.target,
      baseline: o.count,
      overlay: 0,
      delta: -o.count
    });
  }
  for (const o of overlay.perOutput) {
    const key = `${o.kind}|${o.target}`;
    const cur = merged.get(key);
    if (cur) {
      cur.overlay = o.count;
      cur.delta = o.count - cur.baseline;
    } else {
      merged.set(key, { kind: o.kind, target: o.target, baseline: 0, overlay: o.count, delta: o.count });
    }
  }
  return [...merged.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function computeBucketDeltas(
  baseline: { key: string; count: number }[],
  overlay: { key: string; count: number }[]
): DiffBucketDelta[] {
  const merged = new Map<string, DiffBucketDelta>();
  for (const b of baseline) merged.set(b.key, { key: b.key, baseline: b.count, overlay: 0, delta: -b.count });
  for (const o of overlay) {
    const cur = merged.get(o.key);
    if (cur) {
      cur.overlay = o.count;
      cur.delta = o.count - cur.baseline;
    } else {
      merged.set(o.key, { key: o.key, baseline: 0, overlay: o.count, delta: o.count });
    }
  }
  return [...merged.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/**
 * Materialize an overlaid VFS by copying every file from `base` into a fresh
 * MemoryVFS and then applying `overlay` on top. Returns a kernel-loaded
 * pair (model + lookup data) ready for the diff engine. Path-traversal
 * attempts in the overlay map are rejected by MemoryVFS's normalize.
 */
export async function buildOverlayedModel(
  base: VFS,
  overlay: OverlayBundle,
  opts: { entrypoint: string; dialect?: string }
): Promise<{
  model: IRModel;
  lookupTables: Record<string, LookupTableData>;
  /**
   * Loader + dialect + lookup diagnostics gathered while building the
   * overlaid model. Surfacing them up to the API lets the diff endpoint
   * tell the caller "your overlay didn't parse" instead of returning a
   * silent empty-routing diff against a garbage model.
   */
  diagnostics: import('../diagnostics.js').Diagnostic[];
}> {
  const mem = new MemoryVFS(undefined, { label: 'overlay' });
  for (const f of await base.list('/')) {
    const content = await base.readFile(f.path);
    mem.write(f.path, content);
  }
  for (const [path, content] of Object.entries(overlay)) {
    const key = path.startsWith('/') ? path : '/' + path;
    mem.write(key, content);
  }
  const loaded = await load(mem, { entrypoint: opts.entrypoint, dialect: opts.dialect });
  return {
    model: loaded.model,
    lookupTables: loaded.lookupTables,
    diagnostics: loaded.diagnostics
  };
}
