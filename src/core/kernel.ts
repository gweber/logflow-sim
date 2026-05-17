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
import {
  getSIEMTarget,
  listSIEMTargets,
  detectSIEMTarget
} from './siem-targets/registry.js';
import type { SIEMTarget } from './siem-targets/types.js';
import { retagValue } from './siem-targets/pivot.js';
import { inferAll } from './siem-targets/infer.js';

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

  // Post-parse: tag lookup tables with their inferred value-taxonomy and
  // tag outputs with their inferred SIEM destination, based on driver
  // fingerprints + how downstream rulesets consume the lookups.
  inferAll(result.model);

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
  /** Source SIEM the kernel resolved (auto-detected or user-supplied). */
  sourceSiem?: string;
  /** Target SIEM, if one was requested. */
  targetSiem?: string;
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
  /**
   * Source SIEM destination ID. Defaults to the auto-detected one from
   * `detectSIEMTarget(model)`. Combined with `targetSiem`, drives value-
   * rewriting on taxonomy-tagged lookup tables and SIEM-aware fields in
   * outputs. When omitted *and* detection finds nothing, retag is skipped
   * (no-op for the value side; pipeline conversion still runs).
   */
  sourceSiem?: string;
  /**
   * Target SIEM destination ID. Required to trigger retag. When equal to
   * the source SIEM, retag is a no-op. When different, every lookup-table
   * value whose taxonomy is known to both plugins is rewritten through
   * the OCSF pivot before the dialect emitter sees it.
   */
  targetSiem?: string;
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

  // Resolve source/target SIEMs and rewrite taxonomy-tagged lookup values
  // through the OCSF pivot before handing the data to the dialect emitter.
  // Diagnostics surface every lossy translation so the operator knows what
  // to verify by hand.
  const retagOutcome = resolveAndRetagLookups(model, opts);

  // Lookup-data is exposed to the emitter via a normalized EmitLookupData
  // shape so the dialect doesn't have to know about the loader's internal
  // LookupTableData type. Missing data is passed through as undefined.
  const emitLookups = retagOutcome.lookupTables
    ? Object.fromEntries(
        Object.entries(retagOutcome.lookupTables).map(([name, data]) => [
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
    sourceSiem: retagOutcome.sourceSiem,
    targetSiem: retagOutcome.targetSiem,
    output: result.output,
    files,
    diagnostics: [...result.diagnostics, ...retagOutcome.diagnostics]
  };
}

/**
 * Standalone "retag" — same as convert() but keeps the source dialect.
 * Useful when the user only wants to translate destination-side
 * vocabulary (Splunk sourcetypes → ECS event.category) without changing
 * the pipeline syntax.
 */
export function retag(
  model: IRModel,
  opts: Omit<ConvertOptions, 'targetSiem'> & { targetSiem: string }
): ConvertResult {
  return convert(model, model.dialect, opts);
}

interface RetagOutcome {
  lookupTables?: Record<string, LookupTableData>;
  sourceSiem?: string;
  targetSiem?: string;
  diagnostics: Diagnostic[];
}

/**
 * Resolve the source/target SIEM pair (running detection when needed) and
 * return a new lookup-table map with taxonomy-tagged values rewritten via
 * the OCSF pivot. Pure: never mutates the input model or lookup data.
 */
function resolveAndRetagLookups(model: IRModel, opts: ConvertOptions): RetagOutcome {
  const diagnostics: Diagnostic[] = [];
  const input = opts.lookupTables;

  // No target SIEM → no retag; just hand back the originals.
  if (!opts.targetSiem) {
    if (opts.sourceSiem) {
      diagnostics.push({
        severity: 'warning',
        code: 'SIEM_SOURCE_WITHOUT_TARGET',
        message:
          `sourceSiem="${opts.sourceSiem}" was specified without targetSiem — ` +
          'value rewriting is a no-op. Set targetSiem to retag.',
        source: { file: '', line: 0, col: 0, offset: 0, length: 0 }
      });
    }
    return { lookupTables: input, diagnostics };
  }

  const target = getSIEMTarget(opts.targetSiem);
  if (!target) {
    throw new NotFoundError(`Unknown target SIEM: ${opts.targetSiem}`, {
      requested: opts.targetSiem
    });
  }

  let source: SIEMTarget | undefined;
  if (opts.sourceSiem) {
    source = getSIEMTarget(opts.sourceSiem);
    if (!source) {
      throw new NotFoundError(`Unknown source SIEM: ${opts.sourceSiem}`, {
        requested: opts.sourceSiem
      });
    }
  } else {
    const detected = detectSIEMTarget(model);
    if (detected && detected.confidence >= 0.6) {
      source = detected.target;
    } else {
      // Couldn't detect with confidence — fall back to generic and warn.
      source = getSIEMTarget('generic');
      diagnostics.push({
        severity: 'warning',
        code: 'SIEM_SOURCE_UNDETECTED',
        message:
          `Could not detect source SIEM with confidence ` +
          `(best guess: ${detected?.target.id ?? 'none'} @ ${(detected?.confidence ?? 0).toFixed(2)}). ` +
          `Falling back to "generic"; values will pass through unchanged. ` +
          `Pass sourceSiem explicitly for accurate retagging.`,
        source: { file: '', line: 0, col: 0, offset: 0, length: 0 }
      });
    }
  }

  // Same SIEM → fast path, no rewriting needed.
  if (!source || source.id === target.id) {
    return { lookupTables: input, sourceSiem: source?.id, targetSiem: target.id, diagnostics };
  }

  // Walk each taxonomy-tagged lookup table and rewrite its values through
  // the OCSF pivot. Untagged tables flow through unchanged.
  if (!input) {
    return { lookupTables: undefined, sourceSiem: source.id, targetSiem: target.id, diagnostics };
  }
  const rewritten: Record<string, LookupTableData> = {};
  for (const [name, data] of Object.entries(input)) {
    const tableMeta = model.lookupTableByName[name];
    const taxonomy = tableMeta?.taxonomy;
    if (!taxonomy || !data.loaded || !data.entries) {
      rewritten[name] = data;
      continue;
    }
    const newEntries: Record<string, string> = {};
    let lossyCount = 0;
    for (const [key, value] of Object.entries(data.entries)) {
      const r = retagValue(source, target, taxonomy, value);
      newEntries[key] = r.value;
      if (r.lossy) lossyCount++;
    }
    rewritten[name] = { ...data, entries: newEntries };
    if (lossyCount > 0) {
      diagnostics.push({
        severity: 'info',
        code: 'SIEM_VALUE_LOSSY',
        message:
          `Lookup table "${name}" (taxonomy: ${taxonomy}): ${lossyCount} of ` +
          `${Object.keys(data.entries).length} value(s) had no exact mapping from ` +
          `${source.id} to ${target.id} and were preserved verbatim. Review the ` +
          `output before deploying.`,
        source: tableMeta?.source ?? { file: '', line: 0, col: 0, offset: 0, length: 0 }
      });
    }
  }
  return {
    lookupTables: rewritten,
    sourceSiem: source.id,
    targetSiem: target.id,
    diagnostics
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

export {
  analyze,
  validate,
  listDialects,
  getDialect,
  detectDialect,
  listSIEMTargets,
  getSIEMTarget,
  detectSIEMTarget
};
export type {
  AnalysisReport,
  ValidationReport,
  ValidateOptions,
  SimulationResult,
  Dialect,
  SIEMTarget
};
