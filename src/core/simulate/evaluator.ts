import type {
  IRModel,
  IRRuleset,
  IRStatement,
  IRAction,
  IRInput
} from '../ir/model.js';
import type { LookupTableData } from '../lookups/types.js';
import type { Diagnostic } from '../diagnostics.js';
import type { SyslogMessage } from './syslog-message.js';
import { makePropertyMap } from './syslog-message.js';
import { evalExpr, toStr, type EvalContext, type TraceEvent } from './expressions.js';
import { evalCondition } from './conditions.js';
import { renderTemplateByName, substituteTemplate } from './templates.js';

export interface SimulationOutput {
  kind: 'omfile' | 'omfwd' | 'omelasticsearch' | 'omkafka' | 'omhttp' | 'mmjsonparse' | 'unknown';
  /** For omfile: resolved filesystem path (DynaFile rendered or static File). */
  path?: string;
  template?: string;
  target?: string;
  port?: number;
  protocol?: string;
  /** Raw resolved action parameters. */
  params: Record<string, unknown>;
  source: IRAction['source'];
}

export interface SimulationResult {
  selectedInput: IRInput | null;
  selectedRuleset: string | null;
  finalState: {
    dropped: boolean;
    stopped: boolean;
    localVars: Record<string, string>;
    structured: Record<string, string>;
    outputs: SimulationOutput[];
  };
  trace: TraceEvent[];
  diagnostics: Diagnostic[];
}

export interface SimulationOptions {
  model: IRModel;
  lookupTables: Record<string, LookupTableData>;
  message: SyslogMessage;
  /** Optional override for which ruleset to enter (skips input selection). */
  forceRuleset?: string;
  /** Max ruleset depth for `call` to prevent infinite recursion. */
  maxCallDepth?: number;
}

export function simulate(opts: SimulationOptions): SimulationResult {
  const { model, lookupTables, message } = opts;
  const trace: TraceEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const stepCounter = { n: 0 };
  const outputs: SimulationOutput[] = [];

  const properties = makePropertyMap(message);
  const localVars: Record<string, string> = {};
  const structured: Record<string, string> = { ...(message.structured ?? {}) };

  const ctx: EvalContext = {
    properties,
    localVars,
    structured,
    lookupTables,
    model,
    renderTemplate: () => ({ value: '', missing: true }),
    emit: (e) => trace.push(e),
    stepCounter
  };
  ctx.renderTemplate = (name: string) => renderTemplateByName(model, name, ctx);

  let selectedInput: IRInput | null = null;
  let selectedRulesetName: string | null = null;

  if (opts.forceRuleset) {
    selectedRulesetName = opts.forceRuleset;
    ctx.emit({
      step: ++stepCounter.n,
      type: 'note',
      message: `Forced ruleset "${opts.forceRuleset}" — skipping input selection`
    });
  } else {
    selectedInput = selectInput(model, message);
    if (selectedInput) {
      ctx.emit({
        step: ++stepCounter.n,
        type: 'input_selected',
        message: `Matched input ${selectedInput.type} on port ${selectedInput.port}`,
        source: selectedInput.source,
        details: { type: selectedInput.type, port: selectedInput.port, ruleset: selectedInput.ruleset }
      });
      selectedRulesetName = selectedInput.ruleset ?? model.globals.defaultRuleset ?? null;
    } else {
      selectedRulesetName = model.globals.defaultRuleset ?? null;
      ctx.emit({
        step: ++stepCounter.n,
        type: 'note',
        message:
          `No input matched transport=${message.transport} port=${message.port}` +
          (selectedRulesetName ? `; falling back to $DefaultRuleset "${selectedRulesetName}"` : '')
      });
    }
  }

  let stopped = false;
  const dropped = !selectedRulesetName;

  if (selectedRulesetName) {
    const ruleset = model.rulesetByName[selectedRulesetName];
    if (!ruleset) {
      diagnostics.push({
        severity: 'warning',
        message: `Ruleset "${selectedRulesetName}" referenced but not defined`,
        source:
          selectedInput?.source ?? { file: '<runtime>', line: 0, col: 0, offset: 0, length: 0 },
        code: 'W_RULESET_MISSING'
      });
      ctx.emit({
        step: ++stepCounter.n,
        type: 'note',
        message: `Ruleset "${selectedRulesetName}" not defined; nothing to evaluate`
      });
    } else {
      runRuleset(ruleset, 0);
    }
  } else {
    ctx.emit({
      step: ++stepCounter.n,
      type: 'note',
      message: 'No ruleset to evaluate; message would be dropped'
    });
  }

  return {
    selectedInput,
    selectedRuleset: selectedRulesetName,
    finalState: {
      dropped,
      stopped,
      localVars: { ...localVars },
      structured: { ...structured },
      outputs
    },
    trace,
    diagnostics
  };

  function runRuleset(rs: IRRuleset, depth: number): void {
    const maxDepth = opts.maxCallDepth ?? 16;
    if (depth > maxDepth) {
      ctx.emit({
        step: ++stepCounter.n,
        type: 'note',
        message: `Maximum ruleset call depth (${maxDepth}) exceeded at "${rs.name}"`,
        source: rs.source
      });
      return;
    }
    ctx.emit({
      step: ++stepCounter.n,
      type: 'ruleset_entered',
      message: `Entering ruleset "${rs.name}"`,
      source: rs.source,
      details: { ruleset: rs.name, depth }
    });
    for (const s of rs.statements) {
      if (stopped) break;
      runStmt(s, depth);
    }
    ctx.emit({
      step: ++stepCounter.n,
      type: 'ruleset_exited',
      message: `Leaving ruleset "${rs.name}"${stopped ? ' (stopped)' : ''}`,
      source: rs.source,
      details: { ruleset: rs.name, stopped }
    });
  }

  function runStmt(s: IRStatement, depth: number): void {
    switch (s.kind) {
      case 'If': {
        const result = evalCondition(s.condition, ctx);
        ctx.emit({
          step: ++stepCounter.n,
          type: 'condition_eval',
          message: `if (...) → ${result}`,
          source: s.source,
          details: { result }
        });
        const branch = result ? s.then : s.else ?? [];
        for (const st of branch) {
          if (stopped) break;
          runStmt(st, depth);
        }
        return;
      }
      case 'Set':
      case 'Reset': {
        const newVal = toStr(evalExpr(s.value, ctx));
        const bag = s.targetKind === 'local' ? localVars : structured;
        const before = bag[s.targetName];
        bag[s.targetName] = newVal;
        ctx.emit({
          step: ++stepCounter.n,
          type: s.kind === 'Set' ? 'set' : 'reset',
          message: `${s.kind === 'Set' ? 'set' : 'reset'} ${
            s.targetKind === 'local' ? '$.' : '$!'
          }${s.targetName} = "${newVal}"`,
          source: s.source,
          details: {
            targetKind: s.targetKind,
            name: s.targetName,
            before: before ?? null,
            after: newVal
          }
        });
        return;
      }
      case 'Unset': {
        const bag = s.targetKind === 'local' ? localVars : structured;
        const before = bag[s.targetName];
        delete bag[s.targetName];
        ctx.emit({
          step: ++stepCounter.n,
          type: 'unset',
          message: `unset ${s.targetKind === 'local' ? '$.' : '$!'}${s.targetName}`,
          source: s.source,
          details: { targetKind: s.targetKind, name: s.targetName, before: before ?? null }
        });
        return;
      }
      case 'Stop': {
        stopped = true;
        ctx.emit({
          step: ++stepCounter.n,
          type: 'stop',
          message: 'stop — terminating ruleset evaluation',
          source: s.source
        });
        return;
      }
      case 'Continue': {
        // `continue` is a no-op in classic rsyslog flow: it terminates the current
        // statement but lets the ruleset proceed. We trace it for visibility.
        ctx.emit({
          step: ++stepCounter.n,
          type: 'note',
          message: 'continue',
          source: s.source
        });
        return;
      }
      case 'Call': {
        const target = model.rulesetByName[s.ruleset];
        ctx.emit({
          step: ++stepCounter.n,
          type: 'call',
          message: `call ${s.ruleset}`,
          source: s.source,
          details: { ruleset: s.ruleset, defined: !!target }
        });
        if (target) runRuleset(target, depth + 1);
        return;
      }
      case 'ReloadLookupTable': {
        ctx.emit({
          step: ++stepCounter.n,
          type: 'note',
          message: `reload_lookup_table("${s.table}") — no-op in simulator`,
          source: s.source
        });
        return;
      }
      case 'Action': {
        runAction(s);
        return;
      }
      case 'LegacySelector': {
        runLegacySelector(s);
        return;
      }
      case 'Unknown': {
        ctx.emit({
          step: ++stepCounter.n,
          type: 'unknown',
          message: `Unknown statement preserved: ${s.raw.slice(0, 80)}`,
          source: s.source
        });
        return;
      }
    }
  }

  function runAction(a: IRAction): void {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a.params)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        resolved[k] = v;
      } else if (Array.isArray(v)) {
        resolved[k] = v;
      } else {
        // It's an Expr — evaluate it.
        resolved[k] = toStr(evalExpr(v, ctx));
      }
    }

    const out: SimulationOutput = {
      kind: a.actionKind,
      params: resolved,
      source: a.source
    };

    if (a.actionKind === 'omfile') {
      const dyna = strOrUndef(resolved['dynafile']);
      const file = strOrUndef(resolved['file']);
      const tmpl = strOrUndef(resolved['template']);
      if (dyna) {
        const rendered = renderTemplateByName(model, dyna, ctx);
        out.template = dyna;
        out.path = rendered.value;
        if (rendered.missing) {
          diagnostics.push({
            severity: 'warning',
            message: `DynaFile template "${dyna}" not defined`,
            source: a.source,
            code: 'W_TEMPLATE_MISSING'
          });
        }
      } else if (file) {
        // file may itself be a template-style string with %props%
        out.path = substituteTemplate(file, ctx);
        out.template = tmpl;
      } else {
        out.path = '';
      }
    } else if (a.actionKind === 'omfwd') {
      out.target = strOrUndef(resolved['target']);
      const portVal = resolved['port'];
      out.port =
        typeof portVal === 'number'
          ? portVal
          : typeof portVal === 'string'
          ? parseInt(portVal, 10) || undefined
          : undefined;
      out.protocol = strOrUndef(resolved['protocol']);
      out.template = strOrUndef(resolved['template']);
    } else if (a.actionKind === 'mmjsonparse') {
      // mmjsonparse decodes a JSON payload from $msg (or a configured
      // field) and merges the result into $!structured. It does not emit
      // an output — the message continues through the ruleset with new
      // structured fields available.
      const sourceField = strOrUndef(resolved['container']) ?? 'msg';
      const cookie = strOrUndef(resolved['cookie']) ?? '@cee:';
      const raw =
        sourceField === 'msg' || sourceField === '$msg'
          ? ctx.properties.msg ?? ''
          : sourceField.startsWith('$!')
          ? ctx.structured[sourceField.slice(2)] ?? ''
          : ctx.properties[sourceField.toLowerCase()] ?? '';
      const body = raw.startsWith(cookie) ? raw.slice(cookie.length).trimStart() : raw.trimStart();
      let success = false;
      let count = 0;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            ctx.structured[k] =
              typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
            count++;
          }
          success = true;
        }
      } catch {
        // Stay quiet — rsyslog's mmjsonparse silently sets $parsesuccess=FAIL.
      }
      ctx.properties['parsesuccess'] = success ? 'OK' : 'FAIL';
      ctx.emit({
        step: ++stepCounter.n,
        type: 'note',
        message: `mmjsonparse → ${success ? `merged ${count} fields into $!` : 'parse failed'}`,
        source: a.source,
        details: { success, count, sourceField, cookie }
      });
      return; // No output to push.
    }

    outputs.push(out);

    ctx.emit({
      step: ++stepCounter.n,
      type: 'action',
      message: actionSummary(out, a.actionType),
      source: a.source,
      details: {
        actionType: a.actionType,
        actionKind: a.actionKind,
        params: resolved,
        path: out.path,
        target: out.target,
        port: out.port,
        protocol: out.protocol,
        template: out.template
      }
    });
  }

  /**
   * Evaluate a BSD-style legacy selector. Steps:
   *   1. Run `prifilt(facspec)` against the message's facility/severity.
   *   2. If the filter matches, perform the action implied by `target`.
   *   3. Always emit a trace event so the user can see why it did or didn't fire.
   */
  function runLegacySelector(s: import('../ir/model.js').IRLegacySelector): void {
    // Use the function-call evaluator path so the prifilt trace event is
    // consistent with explicit `if prifilt(...) then` usage. We synthesize a
    // CallExpr literal under the hood.
    const filterCall = {
      kind: 'CallExpr' as const,
      callee: 'prifilt',
      args: [{ kind: 'StringLit' as const, value: s.facspec, source: s.source }],
      source: s.source
    };
    const matched = !!evalExpr(filterCall, ctx);
    ctx.emit({
      step: ++stepCounter.n,
      type: 'condition_eval',
      message: `legacy selector ${s.facspec} → ${matched}`,
      source: s.source,
      details: { facspec: s.facspec, target: s.target, matched }
    });
    if (!matched) return;

    const target = s.target.trim();
    const out: SimulationOutput = {
      kind: 'unknown',
      params: { facspec: s.facspec, target },
      source: s.source
    };

    if (target === '~') {
      // Discard the message.
      ctx.emit({
        step: ++stepCounter.n,
        type: 'action',
        message: `legacy discard (~) — message dropped`,
        source: s.source
      });
      stopped = true;
      return;
    }
    if (target.startsWith('@@')) {
      const [host, port] = target.slice(2).split(':');
      out.kind = 'omfwd';
      out.target = host;
      out.port = port ? parseInt(port, 10) || undefined : undefined;
      out.protocol = 'tcp';
    } else if (target.startsWith('@')) {
      const [host, port] = target.slice(1).split(':');
      out.kind = 'omfwd';
      out.target = host;
      out.port = port ? parseInt(port, 10) || undefined : undefined;
      out.protocol = 'udp';
    } else if (target.startsWith(':omusrmsg:') || target.startsWith('*')) {
      // User notification — not simulated, just record.
      out.kind = 'unknown';
    } else if (target.startsWith('|')) {
      out.kind = 'omfile';
      out.path = target.slice(1);
    } else if (target.startsWith('?')) {
      // sysklogd dynaFile shorthand: `?<template-name>` resolves the named
      // template against the current message and uses the result as the file.
      const tplName = target.slice(1);
      const rendered = renderTemplateByName(model, tplName, ctx);
      out.kind = 'omfile';
      out.template = tplName;
      out.path = rendered.value;
      if (rendered.missing) {
        diagnostics.push({
          severity: 'warning',
          message: `Legacy ?-target references undefined template "${tplName}"`,
          source: s.source,
          code: 'W_TEMPLATE_MISSING'
        });
      }
    } else if (target.startsWith('-/') || target.startsWith('/')) {
      out.kind = 'omfile';
      out.path = target.replace(/^-/, '');
    } else {
      // Unknown legacy target form — keep the raw spec for visibility.
      out.kind = 'unknown';
    }

    outputs.push(out);
    ctx.emit({
      step: ++stepCounter.n,
      type: 'action',
      message:
        out.kind === 'omfile'
          ? `legacy omfile → ${out.path}`
          : out.kind === 'omfwd'
          ? `legacy omfwd → ${out.target}:${out.port ?? ''}/${out.protocol}`
          : `legacy ${target}`,
      source: s.source,
      details: { kind: out.kind, target }
    });
  }
}

function selectInput(model: IRModel, msg: SyslogMessage): IRInput | null {
  const expected = msg.transport === 'udp' ? ['imudp'] : ['imtcp', 'imptcp'];
  for (const inp of model.inputs) {
    if (expected.includes(inp.type) && inp.port === msg.port) return inp;
  }
  // fallback: same type, port unspecified
  for (const inp of model.inputs) {
    if (expected.includes(inp.type) && inp.port === undefined) return inp;
  }
  return null;
}

function strOrUndef(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function actionSummary(o: SimulationOutput, raw: string): string {
  if (o.kind === 'omfile') return `omfile → ${o.path || '(no path)'}`;
  if (o.kind === 'omfwd')
    return `omfwd → ${o.target || '(no target)'}:${o.port ?? '?'}/${o.protocol ?? 'tcp'}`;
  return `action ${raw || '(unknown)'}`;
}
