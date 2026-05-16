/**
 * logflow-sim kernel.
 *
 * A single, portable API surface for the entire pipeline:
 *
 *   load     → read files via a VFS and parse them with a chosen dialect
 *   analyze  → flow graph + reachability over a parsed IR
 *   validate → run validation rules over an IR
 *   simulate → run a single message through the IR and return a trace
 *   convert  → emit an IR back as text in a target dialect (planned)
 *
 * The kernel has no Node-specific imports. It runs unchanged in:
 *
 *   • Node (server, CLI, GitHub Action)         — paired with NodeVFS
 *   • Web Worker (browser SPA, browser extension) — paired with MemoryVFS
 *   • A Cloudflare Worker or other isolate runtime — same deal
 *
 * The host environment provides the VFS, the kernel does the work, and the
 * result is plain JSON-friendly data that can travel over postMessage or
 * be JSON-serialized to disk/network.
 */

import type { VFS } from './vfs.js';
import type { IRModel } from './ir/model.js';
import type { Diagnostic } from './diagnostics.js';
import type { Dialect } from './dialects/types.js';
import { getDialect, detectDialect, listDialects } from './dialects/registry.js';
import { loadConfigViaVFS } from './loader.js';
import { analyze, type AnalysisReport } from './analyze/index.js';
import { validate, type ValidationReport, type ValidateOptions } from './validate/index.js';
import { simulate as runSimulate, type SimulationResult } from './simulate/evaluator.js';
import { loadLookupTables } from './lookups/load-via-vfs.js';
import type { LookupTableData } from './lookups/types.js';
import type { SyslogMessage } from './simulate/syslog-message.js';
import { NotFoundError, UnsupportedOperationError, OperationError } from './errors.js';

// -----------------------------------------------------------------------------
// Load
// -----------------------------------------------------------------------------

export interface LoadOptions {
  /** Dialect ID. If omitted, the kernel auto-detects from the entrypoint file. */
  dialect?: string;
  /** VFS path of the entrypoint, e.g. "/rsyslog.conf". */
  entrypoint?: string;
}

export interface LoadResult {
  dialect: string;
  model: IRModel;
  files: { path: string; content: string }[];
  lookupTables: Record<string, LookupTableData>;
  diagnostics: Diagnostic[];
}

export async function load(vfs: VFS, opts: LoadOptions = {}): Promise<LoadResult> {
  const entrypoint = opts.entrypoint ?? '/rsyslog.conf';
  const load = await loadConfigViaVFS({ vfs, entrypoint });
  const diagnostics: Diagnostic[] = [...load.diagnostics.items];

  let dialect: Dialect | undefined;
  if (opts.dialect) {
    dialect = getDialect(opts.dialect);
    if (!dialect) throw new NotFoundError(`Unknown dialect: ${opts.dialect}`, { requested: opts.dialect });
  } else {
    const detection = detectDialect(load.files);
    dialect =
      detection?.dialect ??
      // Fallback: assume rsyslog (the most common). Surface as info so the
      // caller knows we guessed.
      getDialect('rsyslog');
    if (!dialect) throw new OperationError('No dialects registered');
  }

  const result = dialect.parseFiles(
    load.files.map((f) => ({ path: f.path.replace(/^\/+/, ''), content: f.content }))
  );
  diagnostics.push(...result.diagnostics);

  const { data: lookupTables, diagnostics: ld } = await loadLookupTables(
    result.model.lookupTables,
    vfs
  );
  result.model.diagnostics.push(...ld);

  return {
    dialect: dialect.id,
    model: result.model,
    files: load.files.map((f) => ({ path: f.path.replace(/^\/+/, ''), content: f.content })),
    lookupTables,
    diagnostics
  };
}

// -----------------------------------------------------------------------------
// Analyze / Validate / Simulate
// -----------------------------------------------------------------------------

export interface SimulateInput {
  model: IRModel;
  lookupTables: Record<string, LookupTableData>;
  message: SyslogMessage;
  forceRuleset?: string;
}

export function simulate(input: SimulateInput): SimulationResult {
  return runSimulate({
    model: input.model,
    lookupTables: input.lookupTables,
    message: input.message,
    forceRuleset: input.forceRuleset
  });
}

// -----------------------------------------------------------------------------
// Convert (planned)
// -----------------------------------------------------------------------------

export interface ConvertResult {
  targetDialect: string;
  output: string;
  /** Multi-file output: main config + any sidecar files (lookups, etc.). */
  files: { path: string; content: string }[];
  diagnostics: Diagnostic[];
}

export interface ConvertOptions {
  /**
   * Loaded lookup-table data, keyed by table name. When supplied, the
   * emitter can rewrite lookup references into the target dialect's
   * native idiom and emit the actual key/value content as a sidecar.
   */
  lookupTables?: Record<string, LookupTableData>;
}

export function convert(
  model: IRModel,
  targetDialect: string,
  opts: ConvertOptions = {}
): ConvertResult {
  const dialect = getDialect(targetDialect);
  if (!dialect) {
    throw new NotFoundError(`Unknown target dialect: ${targetDialect}`, {
      requested: targetDialect
    });
  }
  if (!dialect.emit) {
    throw new UnsupportedOperationError(
      `Dialect "${targetDialect}" does not support emit yet — open an issue and we'll add it.`,
      { dialect: targetDialect }
    );
  }
  // Lookup-data is exposed to the emitter via a normalized EmitLookupData
  // shape so the dialect doesn't have to know about the loader's internal
  // LookupTableData type. Missing data is passed through as undefined.
  const emitLookups = opts.lookupTables
    ? Object.fromEntries(
        Object.entries(opts.lookupTables).map(([name, data]) => [
          name,
          {
            entries: data.loaded ? { ...data.entries } : undefined,
            nomatch: data.nomatch,
            filePath: data.filePath
          }
        ])
      )
    : undefined;
  const result = dialect.emit(model, { lookupTables: emitLookups });
  const files =
    result.files && result.files.length > 0
      ? result.files
      : [{ path: defaultFilenameFor(dialect.id), content: result.output }];
  return {
    targetDialect: dialect.id,
    output: result.output,
    files,
    diagnostics: result.diagnostics
  };
}

function defaultFilenameFor(dialectId: string): string {
  if (dialectId === 'rsyslog') return 'rsyslog.conf';
  if (dialectId === 'syslog-ng') return 'syslog-ng.conf';
  if (dialectId === 'fluent-bit') return 'fluent-bit.conf';
  if (dialectId === 'nxlog') return 'nxlog.conf';
  if (dialectId === 'logstash') return 'logstash.conf';
  if (dialectId === 'vector') return 'vector.toml';
  if (dialectId === 'otel') return 'otel-collector.yaml';
  return `${dialectId}.conf`;
}

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

export { analyze, validate, listDialects, getDialect, detectDialect };
export type { AnalysisReport, ValidationReport, ValidateOptions, SimulationResult, Dialect };
