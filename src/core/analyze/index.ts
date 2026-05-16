import type { IRModel } from '../ir/model.js';
import { buildFlowGraph, type FlowGraph } from './flow.js';
import { analyzeReachability, type ReachabilityReport } from './reachability.js';

export interface AnalysisReport {
  /** "inputs → rulesets → outputs" graph for visualization and reasoning. */
  flow: FlowGraph;
  /** Reachability + dead-code findings. */
  reachability: ReachabilityReport;
  /** Convenience counts the UI / CLI can render without re-walking the IR. */
  summary: {
    inputs: number;
    rulesets: number;
    templates: number;
    lookupTables: number;
    outputs: number;
    edges: number;
    deadRulesets: number;
    unusedLookupTables: number;
    unusedTemplates: number;
  };
}

export function analyze(model: IRModel): AnalysisReport {
  const flow = buildFlowGraph(model);
  const reach = analyzeReachability(model);
  return {
    flow,
    reachability: reach,
    summary: {
      inputs: model.inputs.length,
      rulesets: model.rulesets.length,
      templates: model.templates.length,
      lookupTables: model.lookupTables.length,
      outputs: flow.nodes.filter((n) => n.kind === 'output').length,
      edges: flow.edges.length,
      deadRulesets: reach.deadRulesets.length,
      unusedLookupTables: reach.unusedLookupTables.length,
      unusedTemplates: reach.unusedTemplates.length
    }
  };
}

export type { FlowGraph, FlowNode, FlowEdge } from './flow.js';
export type { ReachabilityReport } from './reachability.js';
