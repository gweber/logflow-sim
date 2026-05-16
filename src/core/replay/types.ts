/**
 * Replay-engine types — runs a batch of real syslog messages through the
 * simulator and returns an aggregate report instead of per-message traces.
 *
 * Per-message traces would blow up to ~MB for a 10k batch; the aggregate is
 * what the user actually wants: "of my 25k real Linux logs, where do they
 * land in my config?" The engine keeps small sample sets for drill-down
 * (first N unmatched, first N error cases) so a UI can still show concrete
 * examples without paging through the whole stream.
 */

import type { SyslogMessage } from '../simulate/syslog-message.js';

/** Input format the engine accepts after source-specific parsing. */
export interface ReplayMessage extends SyslogMessage {
  /** 1-based index in the source stream, for drill-down references. */
  index: number;
}

export interface ReplayOptions {
  /** Stop after this many messages. Default 50_000. */
  maxMessages?: number;
  /** How many concrete samples to keep per "interesting" bucket. Default 5. */
  samplesPerBucket?: number;
  /** Override the input selection (rare — usually let the model decide). */
  forceRuleset?: string;
}

export interface BucketCount {
  key: string;
  count: number;
  pct: number;
}

export interface OutputBucket {
  kind: 'omfile' | 'omfwd' | string;
  /** For omfile: resolved file path. For omfwd: `target:port/protocol`. */
  target: string;
  count: number;
}

export interface ReplaySample {
  index: number;
  programname?: string;
  hostname?: string;
  msg?: string;
  reason?: string;
}

export interface ReplayReport {
  /** Total messages submitted (pre-cap). */
  total: number;
  /** Messages actually simulated (after maxMessages cap). */
  processed: number;
  /** Messages that hit a ruleset and produced output. */
  delivered: number;
  /** Messages where no input matched (would be dropped at intake). */
  noInputMatch: number;
  /** Messages where the kernel threw during simulation. */
  errors: number;
  /** Messages whose ruleset ran but produced zero outputs (silent drop). */
  noOutput: number;

  /** Total wall time of the replay in milliseconds. */
  durationMs: number;

  topPrograms: BucketCount[];
  topHostnames: BucketCount[];
  perRuleset: BucketCount[];
  perOutput: OutputBucket[];

  unmatchedSamples: ReplaySample[];
  noOutputSamples: ReplaySample[];
  errorSamples: ReplaySample[];
}
