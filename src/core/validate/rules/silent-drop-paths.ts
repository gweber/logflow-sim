import type { ValidationRule } from '../types.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { IRStatement, IRRuleset } from '../../ir/model.js';

/**
 * Silent-drop path detection.
 *
 * For every ruleset, walk the statement tree and emit a finding for every
 * branch that ends without producing an output AND without an explicit
 * `stop`. Messages that take such a path are silently dropped by the
 * default discard-after-ruleset behavior — they never reach the wire, and
 * the operator gets no signal that they didn't.
 *
 * This is the headline diagnostic of the validator: it tells you, in
 * human-readable form, *which* branch reaches a dead end and what shape
 * of message would land there.
 *
 * Heuristics:
 *   - A "terminal" statement is anything that produces a side effect that
 *     persists past the ruleset: an `Action`, a `Call` into another
 *     ruleset, or an explicit `Stop`. Set/unset/reset are NOT terminal —
 *     they mutate state but a message that only hits a `set` and then
 *     falls off the end is still dropped.
 *   - An `If` with both `then` and `else` is terminal iff BOTH branches
 *     are terminal. An `If` with only `then` is never terminal (the
 *     implicit else falls through to whatever follows). An `If` without
 *     either branch — possible in malformed parses — is never terminal.
 *   - A ruleset body that ends without a terminal statement is reported
 *     once per ruleset (not once per leaf branch) to avoid finding-spam.
 *
 * Scope kept tight on purpose: we don't try to model exhaustiveness of
 * if-chains (would need symbolic execution). Examples:
 *   if $x == "a" then { action(...) }
 *   if $x == "b" then { action(...) }
 *   # ← silent drop for any $x not in {a, b}
 *
 * That falls under our rule because the ruleset's last statement is an
 * `If` without an `else` branch, and so the implicit fall-through ends
 * without a terminal — exactly the dead-end we want to surface.
 */
export const silentDropPathsRule: ValidationRule = {
  id: 'silent-drop-paths',
  description:
    'Ruleset branches that end without an action or stop — messages on that path are silently discarded',
  defaultSeverity: 'warning',

  run(model): Diagnostic[] {
    const findings: Diagnostic[] = [];
    // A ruleset that is `call`-target from another ruleset is allowed to
    // end without a terminal — control returns to the caller, which is
    // where the action chain continues. Collect those names so we can
    // skip them in the tail check.
    const callTargets = collectCallTargets(model.rulesets);
    for (const rs of model.rulesets) {
      // Synthetic legacy default ruleset is fine — it's not user-authored.
      if (rs.name === '_default_legacy') continue;
      // Helper-style ruleset that exists purely as a `call` target — its
      // tail behavior is the caller's concern, not its own.
      const isHelper = callTargets.has(rs.name);
      if (!isHelper && !hasTerminalStatement(rs.statements)) {
        findings.push(diagnoseRulesetTail(rs));
      }
      // Always walk into if-branches and surface any specific branch that
      // is itself non-terminal — branch-level findings are info-level and
      // surface a likely fall-through even in helper rulesets.
      collectBranchFindings(rs.statements, rs.name, findings);
    }
    return findings;
  }
};

function collectCallTargets(rulesets: IRRuleset[]): Set<string> {
  const out = new Set<string>();
  function visit(stmts: IRStatement[]): void {
    for (const s of stmts) {
      if (s.kind === 'Call' && typeof s.ruleset === 'string') out.add(s.ruleset);
      else if (s.kind === 'If') {
        visit(s.then);
        if (s.else) visit(s.else);
      }
    }
  }
  for (const rs of rulesets) visit(rs.statements);
  return out;
}

function isAction(s: IRStatement): boolean {
  return s.kind === 'Action';
}
function isStop(s: IRStatement): boolean {
  return s.kind === 'Stop';
}
function isCall(s: IRStatement): boolean {
  return s.kind === 'Call';
}

/** Does the statement guarantee message handling reaches a terminal? */
function isTerminalStatement(s: IRStatement): boolean {
  if (isAction(s) || isStop(s) || isCall(s)) return true;
  if (s.kind === 'If') {
    const thenTerm = hasTerminalStatement(s.then);
    const elseTerm = s.else ? hasTerminalStatement(s.else) : false;
    return thenTerm && elseTerm;
  }
  return false;
}

/** Does the block end with — or contain on every path — a terminal? */
function hasTerminalStatement(block: IRStatement[]): boolean {
  for (let i = block.length - 1; i >= 0; i--) {
    if (isTerminalStatement(block[i])) return true;
    // Stop scanning past the LAST statement: only the tail can be terminal
    // for the block as a whole. If the last statement is non-terminal,
    // earlier ones don't save it.
    break;
  }
  return false;
}

function diagnoseRulesetTail(rs: IRRuleset): Diagnostic {
  const lastSource = rs.statements.length > 0 ? rs.statements[rs.statements.length - 1].source : rs.source;
  // Build a short narrative: which path reaches the dead end?
  const narrative = describeRulesetTail(rs);
  return {
    severity: 'warning',
    message:
      `Ruleset "${rs.name}" can drop messages silently: ${narrative}. ` +
      `Either add a catch-all action at the bottom, or end the ruleset with an explicit \`stop\` ` +
      `to make the intent of "do nothing" reviewable.`,
    source: lastSource,
    code: 'V_SILENT_DROP'
  };
}

function describeRulesetTail(rs: IRRuleset): string {
  if (rs.statements.length === 0) {
    return `the ruleset is empty, so every message entering it ends without any action`;
  }
  const last = rs.statements[rs.statements.length - 1];
  if (last.kind === 'If') {
    if (!last.else) {
      return (
        `the last statement is an \`if\` without an \`else\`, so messages for which the condition is ` +
        `false fall off the end and produce no output`
      );
    }
    return (
      `the last \`if/else\` has a branch that does not lead to an action or stop, so a subset of ` +
      `messages will silently drop off the end`
    );
  }
  if (last.kind === 'Set' || last.kind === 'Reset' || last.kind === 'Unset') {
    return (
      `the last statement is a \`${last.kind.toLowerCase()}\` — it mutates state but emits nothing, ` +
      `so the message has no action attached when the ruleset returns`
    );
  }
  return `the last statement (\`${last.kind}\`) doesn't produce an output or stop`;
}

function collectBranchFindings(
  block: IRStatement[],
  rulesetName: string,
  findings: Diagnostic[]
): void {
  for (const s of block) {
    if (s.kind !== 'If') continue;
    if (s.then && !hasTerminalStatement(s.then) && s.then.length > 0) {
      const tail = s.then[s.then.length - 1];
      findings.push({
        severity: 'info',
        message:
          `Ruleset "${rulesetName}": the \`then\` branch at this location ends without an action ` +
          `or stop. If the surrounding ruleset's tail is also non-terminal, messages that match ` +
          `this condition can silently drop.`,
        source: tail.source,
        code: 'V_SILENT_DROP_BRANCH'
      });
    }
    if (s.else && !hasTerminalStatement(s.else) && s.else.length > 0) {
      const tail = s.else[s.else.length - 1];
      findings.push({
        severity: 'info',
        message:
          `Ruleset "${rulesetName}": the \`else\` branch at this location ends without an action ` +
          `or stop. Messages reaching the implicit fall-through can drop unless something later in ` +
          `the ruleset catches them.`,
        source: tail.source,
        code: 'V_SILENT_DROP_BRANCH'
      });
    }
    // Recurse — nested ifs deserve their own narrative findings.
    if (s.then) collectBranchFindings(s.then, rulesetName, findings);
    if (s.else) collectBranchFindings(s.else, rulesetName, findings);
  }
}

