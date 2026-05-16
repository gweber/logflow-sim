import type { IRModel, IRStatement, IRRuleset } from '../ir/model.js';

/**
 * Flow analysis — extract the routing graph of a parsed config so the UI can
 * draw "inputs → rulesets → outputs" and so the kernel can answer "what
 * actions could fire if a message arrives on input X?".
 *
 * Nodes: inputs, rulesets, outputs (omfile path / omfwd target / output name).
 * Edges:
 *   input  → ruleset    (via input.ruleset binding, or fallback to $DefaultRuleset)
 *   ruleset → ruleset   (via `call <name>`)
 *   ruleset → output    (via every Action / LegacySelector reachable within it)
 */

export interface FlowNode {
  id: string;
  kind: 'input' | 'ruleset' | 'output';
  label: string;
  /** Source location (file:line) — empty for synthetic nodes. */
  file?: string;
  line?: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** Why this edge exists: 'input', 'call', 'action', 'fallback'. */
  reason: 'input' | 'call' | 'action' | 'fallback';
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function buildFlowGraph(model: IRModel): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const outputIds = new Map<string, string>();

  function outputNodeId(label: string): string {
    let id = outputIds.get(label);
    if (id) return id;
    id = `output:${label}`;
    outputIds.set(label, id);
    nodes.push({ id, kind: 'output', label });
    return id;
  }

  // Input nodes
  for (const inp of model.inputs) {
    const id = inp.id;
    const label = `${inp.type}${inp.port !== undefined ? `:${inp.port}` : ''}`;
    nodes.push({
      id,
      kind: 'input',
      label,
      file: inp.source.file,
      line: inp.source.line
    });
    // Edge to bound ruleset (or fallback)
    const targetName = inp.ruleset ?? model.globals.defaultRuleset;
    if (targetName) {
      const targetRs = model.rulesetByName[targetName];
      if (targetRs) {
        edges.push({
          from: id,
          to: targetRs.id,
          reason: inp.ruleset ? 'input' : 'fallback'
        });
      }
    }
  }

  // Ruleset nodes + per-ruleset edges
  for (const rs of model.rulesets) {
    nodes.push({
      id: rs.id,
      kind: 'ruleset',
      label: rs.name,
      file: rs.source.file,
      line: rs.source.line
    });
  }

  for (const rs of model.rulesets) {
    walkStatements(rs.statements, rs);
  }

  function walkStatements(stmts: IRStatement[], rs: IRRuleset): void {
    for (const s of stmts) {
      switch (s.kind) {
        case 'If':
          walkStatements(s.then, rs);
          if (s.else) walkStatements(s.else, rs);
          break;
        case 'Call': {
          const target = model.rulesetByName[s.ruleset];
          if (target) edges.push({ from: rs.id, to: target.id, reason: 'call' });
          break;
        }
        case 'Action': {
          const label = actionLabel(s);
          if (label) {
            const outId = outputNodeId(label);
            edges.push({ from: rs.id, to: outId, reason: 'action' });
          }
          break;
        }
        case 'LegacySelector': {
          const label = `legacy:${s.target}`;
          const outId = outputNodeId(label);
          edges.push({ from: rs.id, to: outId, reason: 'action' });
          break;
        }
      }
    }
  }

  return { nodes, edges };
}

function actionLabel(a: import('../ir/model.js').IRAction): string | null {
  if (a.actionKind === 'omfile') {
    const file = a.params['file'];
    const dyna = a.params['dynafile'];
    if (typeof dyna === 'string') return `omfile:dyna(${dyna})`;
    if (typeof file === 'string') return `omfile:${file}`;
    return 'omfile:?';
  }
  if (a.actionKind === 'omfwd') {
    const target = a.params['target'];
    const port = a.params['port'];
    return `omfwd:${typeof target === 'string' ? target : '?'}:${
      typeof port === 'string' || typeof port === 'number' ? port : '?'
    }`;
  }
  return `${a.actionKind}`;
}
