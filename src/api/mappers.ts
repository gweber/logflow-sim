/**
 * Mappers from internal kernel result shapes to outward-facing DTOs.
 *
 * These functions are the *only* place that knows both worlds. The route
 * handlers stay thin: they call the kernel, hand the result to a mapper,
 * and return the DTO. If the kernel's internal types change, only this
 * file moves.
 */

import type { IRModel, IRStatement } from '../core/ir/model.js';
import type { AnalysisReport, ValidationReport } from '../core/kernel.js';
import type { SimulationResult } from '../core/simulate/evaluator.js';
import type {
  ParseSummaryDTO,
  AnalysisSummaryDTO,
  ValidationSummaryDTO,
  SimulateResponseDTO,
  SimulationOutputDTO,
  TraceEventDTO
} from './dto.js';

export function toParseSummaryDTO(model: IRModel): ParseSummaryDTO {
  let omfileActions = 0;
  let omfwdActions = 0;
  let stopStatements = 0;
  let unknownStatements = 0;
  const walk = (stmts: IRStatement[]): void => {
    for (const s of stmts) {
      if (s.kind === 'Action') {
        if (s.actionKind === 'omfile') omfileActions++;
        else if (s.actionKind === 'omfwd') omfwdActions++;
      } else if (s.kind === 'Stop') stopStatements++;
      else if (s.kind === 'Unknown') unknownStatements++;
      else if (s.kind === 'If') {
        walk(s.then);
        if (s.else) walk(s.else);
      }
    }
  };
  for (const rs of model.rulesets) walk(rs.statements);
  return {
    files: model.files.length,
    inputs: model.inputs.length,
    rulesets: model.rulesets.length,
    templates: model.templates.length,
    lookupTables: model.lookupTables.length,
    modules: model.modules.length,
    outputs: model.outputs.length,
    filters: model.filters.length,
    routes: model.routes.length,
    omfileActions,
    omfwdActions,
    stopStatements,
    unknownStatements
  };
}

export function toAnalysisSummaryDTO(report: AnalysisReport): AnalysisSummaryDTO {
  return { ...report.summary };
}

export function toValidationSummaryDTO(report: ValidationReport): ValidationSummaryDTO {
  return { ...report.summary };
}

export function toSimulateResponseDTO(
  result: SimulationResult,
  parsedRawmsg?: unknown
): SimulateResponseDTO {
  return {
    selectedInput: result.selectedInput
      ? {
          id: result.selectedInput.id,
          type: result.selectedInput.type,
          port: result.selectedInput.port,
          ruleset: result.selectedInput.ruleset,
          source: pickLoc(result.selectedInput.source)
        }
      : null,
    selectedRuleset: result.selectedRuleset,
    finalState: {
      dropped: result.finalState.dropped,
      stopped: result.finalState.stopped,
      localVars: { ...result.finalState.localVars },
      structured: { ...result.finalState.structured },
      outputs: result.finalState.outputs.map(
        (o): SimulationOutputDTO => ({
          kind: o.kind,
          path: o.path,
          template: o.template,
          target: o.target,
          port: o.port,
          protocol: o.protocol,
          params: { ...o.params },
          source: pickLoc(o.source)
        })
      )
    },
    trace: result.trace.map(
      (e): TraceEventDTO => ({
        step: e.step,
        type: e.type,
        message: e.message,
        source: e.source ? pickLoc(e.source) : undefined,
        details: e.details
      })
    ),
    diagnostics: result.diagnostics,
    parsedRawmsg
  };
}

function pickLoc(loc: { file: string; line: number; col: number }): {
  file: string;
  line: number;
  col: number;
} {
  return { file: loc.file, line: loc.line, col: loc.col };
}
