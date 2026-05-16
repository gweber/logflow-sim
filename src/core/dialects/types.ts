import type { Diagnostic } from '../diagnostics.js';
import type { IRModel } from '../ir/model.js';

/**
 * A log-pipeline dialect plugin.
 *
 * Each supported configuration syntax (rsyslog's RainerScript, syslog-ng's
 * source/filter/destination grammar, Fluent Bit's sectioned ini, etc.)
 * implements this contract. The simulator and UI operate purely on the
 * normalized `IRModel` produced by `parseFiles`, so they remain dialect-
 * agnostic.
 *
 * A dialect MUST be a pure function over its inputs — no filesystem or
 * network access. File reading happens at the loader layer, which then
 * hands the dialect a list of `(path, content)` pairs to parse.
 */
export interface Dialect {
  /** Stable identifier, lowercase kebab-case ("rsyslog", "syslog-ng"). */
  readonly id: string;

  /** Human-readable name for the UI. */
  readonly displayName: string;

  /** File extensions this dialect typically owns (".conf", ".sng", ".yaml"). */
  readonly fileExtensions: string[];

  /**
   * Heuristic to identify whether a given config file belongs to this dialect.
   * Used when the user uploads a folder of mixed configs or when the entrypoint
   * has an ambiguous extension. Should be cheap — a few regex probes.
   */
  detect(sample: { path: string; content: string }): number /* 0.0 - 1.0 */;

  /**
   * Parse one or more files into a normalized IR. The caller pre-resolves
   * includes via the loader layer; the dialect sees the full flattened list.
   *
   * Recoverable syntax errors should be reported as diagnostics — the
   * dialect MUST NOT throw on bad input. Unknown constructs SHOULD be
   * preserved as `Unknown` IR statements so they remain visible.
   */
  parseFiles(files: { path: string; content: string }[]): {
    model: IRModel;
    diagnostics: Diagnostic[];
  };

  /**
   * Render a normalized IR back as this dialect's syntax — the inverse of
   * `parseFiles`. Used by the cross-dialect converter (`POST /api/convert`).
   *
   * Implementations don't have to round-trip every byte. They MUST produce
   * a config that, when re-parsed by this dialect, yields a model whose
   * routing graph and outputs are semantically equivalent.
   *
   * Optional second argument: the loaded lookup-table contents. When given,
   * an emitter is encouraged to rewrite lookup-table references in the
   * idiom of the target dialect — e.g. Vector `enrichment_tables`, OTel
   * `attributes`/`transform` processor with inlined maps, etc. When absent,
   * emitters fall back to emitting the lookup files unchanged.
   *
   * Optional — dialects that aren't yet round-trippable can omit this and
   * the converter will report "target dialect doesn't support emit yet".
   */
  emit?(
    model: IRModel,
    opts?: { lookupTables?: Record<string, EmitLookupData> }
  ): EmitResult;
}

export interface EmitLookupData {
  /** key → value pairs of the loaded table, or undefined if loading failed. */
  entries?: Record<string, string>;
  /** Returned by the lookup miss-path, e.g. rsyslog's nomatch. */
  nomatch?: string;
  /** Path the table was loaded from, for reference in target-dialect emit. */
  filePath?: string;
}

export interface EmitFile {
  path: string;
  content: string;
}

export interface EmitResult {
  /** Primary output — backwards-compatible single-file rendering. */
  output: string;
  /**
   * Optional multi-file output. When set, this is the canonical answer and
   * `output` is just `files[0].content`. Use this to emit a lookup-table
   * sidecar alongside the main config, or to split sections of a large
   * config the way the target dialect would on disk.
   */
  files?: EmitFile[];
  diagnostics: Diagnostic[];
}
