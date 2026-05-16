/**
 * HTTP API Data Transfer Objects.
 *
 * The shapes below define the *contract* the UI (and any other client)
 * relies on. They are intentionally separate from the kernel's internal
 * `IRModel` shape so we can refactor the IR freely without breaking the
 * API contract.
 *
 * Versioning convention: when an existing field must change shape in a
 * non-backwards-compatible way, prefix the endpoint path with `/api/v2/…`
 * rather than mutate the DTO. New optional fields are always allowed.
 *
 * Every DTO is pure JSON — no Date objects, no functions, no class
 * instances. Everything must survive `JSON.stringify` + `JSON.parse`
 * intact.
 */

import type { Diagnostic } from '../core/diagnostics.js';
import type { SyslogMessage } from '../core/simulate/syslog-message.js';

// ===== Common ===============================================================

export interface HealthDTO {
  ok: true;
  version: string;
}

export interface DialectSummaryDTO {
  id: string;
  displayName: string;
  fileExtensions: string[];
}

export interface DialectsListDTO {
  dialects: DialectSummaryDTO[];
}

// ===== Config / Parse =======================================================

export interface ParseSummaryDTO {
  files: number;
  inputs: number;
  rulesets: number;
  templates: number;
  lookupTables: number;
  modules: number;
  outputs: number;
  filters: number;
  routes: number;
  omfileActions: number;
  omfwdActions: number;
  stopStatements: number;
  unknownStatements: number;
}

export interface AnalysisSummaryDTO {
  inputs: number;
  rulesets: number;
  templates: number;
  lookupTables: number;
  outputs: number;
  edges: number;
  deadRulesets: number;
  unusedLookupTables: number;
  unusedTemplates: number;
}

export interface ValidationSummaryDTO {
  errors: number;
  warnings: number;
  info: number;
}

export interface ParseResponseDTO {
  dialect: string;
  diagnostics: Diagnostic[];
  summary: ParseSummaryDTO;
  defaultRuleset: string | null;
  analysis: AnalysisSummaryDTO;
  validation: ValidationSummaryDTO;
}

export interface ConfigTreeEntryDTO {
  path: string;
  size: number;
  referenced: boolean;
}

export interface ConfigTreeDTO {
  confRoot: string;
  entrypoint: string;
  files: ConfigTreeEntryDTO[];
}

export interface ConfigBundleDTO {
  dialect: string;
  entrypoint: string;
  files: Record<string, string>;
}

export interface SearchMatchDTO {
  file: string;
  line: number;
  col: number;
  snippet: string;
  matchStart: number;
  matchLen: number;
}

export interface SearchResponseDTO {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  total: number;
  truncated: boolean;
  matches: SearchMatchDTO[];
}

// ===== Simulate =============================================================

/**
 * The request body for POST /api/simulate. Mirrors the SyslogMessage shape
 * but every field is optional so the server can fall back to defaults +
 * rawmsg auto-parsing.
 */
export interface SimulateRequestDTO extends Partial<SyslogMessage> {
  forceRuleset?: string;
}

export interface SimulationOutputDTO {
  kind: string;
  path?: string;
  template?: string;
  target?: string;
  port?: number;
  protocol?: string;
  params: Record<string, unknown>;
  source: { file: string; line: number; col: number };
}

export interface TraceEventDTO {
  step: number;
  type: string;
  message: string;
  source?: { file: string; line: number; col: number };
  details?: Record<string, unknown>;
}

export interface SimulateResponseDTO {
  selectedInput: {
    id: string;
    type: string;
    port?: number;
    ruleset?: string;
    source: { file: string; line: number; col: number };
  } | null;
  selectedRuleset: string | null;
  finalState: {
    dropped: boolean;
    stopped: boolean;
    localVars: Record<string, string>;
    structured: Record<string, string>;
    outputs: SimulationOutputDTO[];
  };
  trace: TraceEventDTO[];
  diagnostics: Diagnostic[];
  parsedRawmsg?: unknown;
}

export interface ParseRawmsgRequestDTO {
  rawmsg: string;
}

// ===== Convert ==============================================================

export interface ConvertRequestDTO {
  /** Target dialect ID — must match an entry from /api/dialects. */
  target: string;
  /** Optional override of the source dialect (else server auto-detects). */
  dialect?: string;
}

export interface ConvertResponseDTO {
  sourceDialect: string;
  targetDialect: string;
  /**
   * Convenience shortcut equal to `files[0].content` — handy when the
   * caller only needs the primary file (the common case for a quick
   * preview). For a full migration write the entire `files` array;
   * lookup sidecars and dialect-specific extras live alongside the
   * primary file.
   */
  output: string;
  /**
   * Every emitted file (main config first, then sidecars such as converted
   * lookup tables). `files[0].content === output`.
   */
  files: { path: string; content: string }[];
  diagnostics: Diagnostic[];
}

// ===== Tests ================================================================

export interface TestCaseDTO {
  name: string;
  file: string;
  input: Record<string, unknown>;
  expect?: Record<string, unknown>;
}

export interface TestRunCheckDTO {
  name: string;
  passed: boolean;
  want?: unknown;
  got?: unknown;
}

export interface TestRunResultDTO {
  name: string;
  file: string;
  passed: boolean;
  checks: TestRunCheckDTO[];
  result: {
    selectedRuleset: string | null;
    finalState: SimulateResponseDTO['finalState'];
    trace: TraceEventDTO[];
  };
}

export interface TestRunResponseDTO {
  total: number;
  passed: number;
  failed: number;
  results: TestRunResultDTO[];
}

// ===== Error envelope =======================================================

/**
 * Uniform error response shape. Every 4xx/5xx body matches this — the UI
 * shows `message`, observability tooling indexes on `code`.
 */
export interface ErrorResponseDTO {
  error: {
    code: string;
    message: string;
    context?: Record<string, unknown>;
  };
}
