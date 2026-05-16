import type { Expr } from '../dialects/rsyslog/parser/ast.js';
import type { SourceLoc } from '../source-map.js';
import { performLookup } from '../lookups/parse-table.js';
import type { LookupTableData } from '../lookups/types.js';
import type { IRModel } from '../ir/model.js';
import { splitProperty, applyModifierChain } from './property-modifiers.js';

export type ScalarValue = string | number | boolean | string[];

export interface EvalContext {
  properties: Record<string, string>; // $fromhost, $msg, ...
  localVars: Record<string, string>; // $.var
  structured: Record<string, string>; // $!field
  lookupTables: Record<string, LookupTableData>;
  /** The full IR model — needed for exec_template and call. */
  model: IRModel;
  /** Renders a template by name. Injected by the evaluator to avoid a circular import. */
  renderTemplate: (name: string) => { value: string; missing?: boolean };
  emit: (event: TraceEvent) => void;
  stepCounter: { n: number };
}

export interface TraceEvent {
  step: number;
  type:
    | 'input_selected'
    | 'ruleset_entered'
    | 'ruleset_exited'
    | 'condition_eval'
    | 'set'
    | 'reset'
    | 'unset'
    | 'lookup'
    | 'action'
    | 'stop'
    | 'call'
    | 'unknown'
    | 'note';
  message: string;
  source?: SourceLoc;
  details?: Record<string, unknown>;
}

export function toBool(v: ScalarValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== '0';
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

export function toStr(v: ScalarValue): string {
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

export function evalExpr(e: Expr, ctx: EvalContext): ScalarValue {
  switch (e.kind) {
    case 'StringLit':
      return e.value;
    case 'NumberLit':
      return e.value;
    case 'ArrayLit':
      return e.elements.map((el) => toStr(evalExpr(el, ctx)));
    case 'PropertyRef': {
      const { base, modifiers } = splitProperty(e.name);
      const raw = ctx.properties[base.toLowerCase()] ?? '';
      return modifiers.length ? applyModifierChain(raw, modifiers) : raw;
    }
    case 'LocalVarRef': {
      const { base, modifiers } = splitProperty(e.name);
      const raw = ctx.localVars[base] ?? '';
      return modifiers.length ? applyModifierChain(raw, modifiers) : raw;
    }
    case 'StructuredRef': {
      const { base, modifiers } = splitProperty(e.name);
      const raw = ctx.structured[base] ?? '';
      return modifiers.length ? applyModifierChain(raw, modifiers) : raw;
    }
    case 'ParenExpr':
      return evalExpr(e.inner, ctx);
    case 'UnaryOp':
      return !toBool(evalExpr(e.operand, ctx));
    case 'LookupCall': {
      const tableName = toStr(evalExpr(e.table, ctx));
      const keyVal = toStr(evalExpr(e.key, ctx));
      const t = ctx.lookupTables[tableName];
      const result = performLookup(t, keyVal);
      ctx.emit({
        step: ++ctx.stepCounter.n,
        type: 'lookup',
        message: `lookup("${tableName}", "${keyVal}") → "${result.value}"${
          result.isDefault ? ' (nomatch default)' : result.hit ? '' : ' (miss)'
        }`,
        source: e.source,
        details: {
          table: tableName,
          key: keyVal,
          hit: result.hit,
          isDefault: result.isDefault,
          tableLoaded: result.tableLoaded,
          format: result.format,
          value: result.value
        }
      });
      return result.value;
    }
    case 'CallExpr':
      return evalCall(e.callee, e.args, e.source, ctx);
    case 'BinaryOp': {
      switch (e.op) {
        case 'and':
          return toBool(evalExpr(e.left, ctx)) && toBool(evalExpr(e.right, ctx));
        case 'or':
          return toBool(evalExpr(e.left, ctx)) || toBool(evalExpr(e.right, ctx));
        case '==':
          return scalarEq(evalExpr(e.left, ctx), evalExpr(e.right, ctx));
        case '!=':
          return !scalarEq(evalExpr(e.left, ctx), evalExpr(e.right, ctx));
        case 'contains':
          return containsOp(evalExpr(e.left, ctx), evalExpr(e.right, ctx), false);
        case 'contains_i':
          return containsOp(evalExpr(e.left, ctx), evalExpr(e.right, ctx), true);
        case 'startswith':
          return startswithOp(evalExpr(e.left, ctx), evalExpr(e.right, ctx), false);
        case 'startswith_i':
          return startswithOp(evalExpr(e.left, ctx), evalExpr(e.right, ctx), true);
        case '<':
          return numCompare(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '<');
        case '<=':
          return numCompare(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '<=');
        case '>':
          return numCompare(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '>');
        case '>=':
          return numCompare(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '>=');
        case '&':
          return toStr(evalExpr(e.left, ctx)) + toStr(evalExpr(e.right, ctx));
        case '+':
          return arith(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '+');
        case '-':
          return arith(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '-');
        case '*':
          return arith(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '*');
        case '/':
          return arith(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '/');
        case '%':
          return arith(evalExpr(e.left, ctx), evalExpr(e.right, ctx), '%');
        case '=~':
          return regexMatch(evalExpr(e.left, ctx), evalExpr(e.right, ctx));
        case '!~':
          return !regexMatch(evalExpr(e.left, ctx), evalExpr(e.right, ctx));
      }
    }
  }
}

// ----------------------------------------------------------------------------
// prifilt — facility.severity filter spec parser/matcher.
//
// rsyslog's PRI filter grammar (a direct port of BSD syslog selector syntax):
//
//   spec    := clause [ ";" clause ]*
//   clause  := facilities "." severity
//   facilities := facility [ "," facility ]*
//   facility   := <facility-name> | "*"
//   severity   := <severity-name> | "*" | "none"
//                 | "=" <severity-name>    (exact, not "≥")
//                 | "!" <severity-name>    (negate "≥")
//                 | "!=" <severity-name>   (negate exact)
//
// Semantics: a clause matches if the message's facility is in the clause's
// facility set AND its severity satisfies the severity test. Clauses combine
// LEFT-TO-RIGHT: later clauses can disable earlier matches via "none".
// We implement the standard interpretation:
//   - "*.info" → any facility at info-or-higher
//   - "mail.*" → mail facility, any severity
//   - "mail.none" → exclude mail entirely
//   - "*.info;mail.none" → all info+ except mail
//
// Returns true if the current message matches the spec.
// ----------------------------------------------------------------------------
const FACILITIES = [
  'kern','user','mail','daemon','auth','syslog','lpr','news',
  'uucp','cron','authpriv','ftp','ntp','security','console','solaris-cron',
  'local0','local1','local2','local3','local4','local5','local6','local7'
];
const SEVERITIES = ['emerg','alert','crit','err','warning','notice','info','debug'];
const SEVERITY_ALIASES: Record<string, string> = {
  panic: 'emerg',
  error: 'err',
  warn: 'warning'
};

function facilityIndex(name: string): number {
  return FACILITIES.indexOf(name.toLowerCase());
}
function severityIndex(name: string): number {
  const norm = SEVERITY_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return SEVERITIES.indexOf(norm);
}

function matchPrifilt(spec: string, ctx: EvalContext): boolean {
  const facStr = ctx.properties['syslogfacility'] ?? '';
  const sevStr = ctx.properties['syslogseverity'] ?? '';
  const fac = parseInt(facStr, 10);
  const sev = parseInt(sevStr, 10);
  if (Number.isNaN(fac) || Number.isNaN(sev)) return false;

  // Track allow/deny per clause; later clauses can override earlier ones.
  let result = false;
  for (const clauseRaw of spec.split(';')) {
    const clause = clauseRaw.trim();
    if (!clause) continue;
    const dot = clause.lastIndexOf('.');
    if (dot < 0) continue;
    const facsPart = clause.slice(0, dot).trim();
    const sevPart = clause.slice(dot + 1).trim();

    // Match against this clause's facility set.
    let facMatch = false;
    for (const f of facsPart.split(',')) {
      const name = f.trim();
      if (name === '*') {
        facMatch = true;
        break;
      }
      const idx = facilityIndex(name);
      if (idx === fac) {
        facMatch = true;
        break;
      }
    }
    if (!facMatch) continue;

    // Match severity. `none` is a special "disable" marker.
    if (sevPart === 'none') {
      result = false;
      continue;
    }
    if (sevPart === '*') {
      result = true;
      continue;
    }
    let negate = false;
    let exact = false;
    let sevName = sevPart;
    if (sevName.startsWith('!=')) {
      negate = true;
      exact = true;
      sevName = sevName.slice(2);
    } else if (sevName.startsWith('!')) {
      negate = true;
      sevName = sevName.slice(1);
    } else if (sevName.startsWith('=')) {
      exact = true;
      sevName = sevName.slice(1);
    }
    const sevIdx = severityIndex(sevName);
    if (sevIdx < 0) continue;
    let match: boolean;
    if (exact) match = sev === sevIdx;
    else match = sev <= sevIdx; // smaller numeric = more severe; "≥ threshold"
    if (negate) match = !match;
    if (match) result = true;
  }
  return result;
}

function arith(a: ScalarValue, b: ScalarValue, op: '+' | '-' | '*' | '/' | '%'): number {
  const na = typeof a === 'number' ? a : parseFloat(toStr(a));
  const nb = typeof b === 'number' ? b : parseFloat(toStr(b));
  const x = Number.isNaN(na) ? 0 : na;
  const y = Number.isNaN(nb) ? 0 : nb;
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y === 0 ? 0 : x / y;
    case '%':
      return y === 0 ? 0 : x % y;
  }
}

function regexMatch(subject: ScalarValue, pattern: ScalarValue): boolean {
  const s = toStr(subject);
  const p = toStr(pattern);
  if (!p) return false;
  try {
    return new RegExp(p).test(s);
  } catch {
    // Invalid regex — rsyslog would return false; mirror that quietly.
    return false;
  }
}

function numCompare(a: ScalarValue, b: ScalarValue, op: '<' | '<=' | '>' | '>='): boolean {
  const na = typeof a === 'number' ? a : parseFloat(toStr(a));
  const nb = typeof b === 'number' ? b : parseFloat(toStr(b));
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    // Fall back to string compare to remain deterministic.
    const sa = toStr(a);
    const sb = toStr(b);
    if (op === '<') return sa < sb;
    if (op === '<=') return sa <= sb;
    if (op === '>') return sa > sb;
    return sa >= sb;
  }
  if (op === '<') return na < nb;
  if (op === '<=') return na <= nb;
  if (op === '>') return na > nb;
  return na >= nb;
}

function evalCall(callee: string, args: Expr[], source: SourceLoc, ctx: EvalContext): ScalarValue {
  const name = callee.toLowerCase();
  switch (name) {
    case 'tolower':
      return toStr(args[0] ? evalExpr(args[0], ctx) : '').toLowerCase();
    case 'toupper':
      return toStr(args[0] ? evalExpr(args[0], ctx) : '').toUpperCase();
    case 'strlen':
      return toStr(args[0] ? evalExpr(args[0], ctx) : '').length;
    case 'cnum': {
      const v = parseFloat(toStr(args[0] ? evalExpr(args[0], ctx) : ''));
      return Number.isNaN(v) ? 0 : v;
    }
    case 'cstr':
      return toStr(args[0] ? evalExpr(args[0], ctx) : '');
    case 'substring': {
      const s = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      const start = args[1] ? Number(toStr(evalExpr(args[1], ctx))) : 0;
      const len = args[2] ? Number(toStr(evalExpr(args[2], ctx))) : undefined;
      return len === undefined ? s.slice(start) : s.slice(start, start + len);
    }
    case 'getenv': {
      const k = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      return process.env[k] ?? '';
    }
    case 're_match': {
      const subject = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      const pattern = toStr(args[1] ? evalExpr(args[1], ctx) : '');
      if (!pattern) return false;
      try {
        return new RegExp(pattern).test(subject);
      } catch {
        return false;
      }
    }
    case 're_extract': {
      // Signature: re_extract(subject, pattern, matchnum, submatch, default)
      // For our scope `matchnum` (which of several disjoint matches) is
      // collapsed onto 0 — we use the first match. `submatch` selects the
      // capture group; `default` is returned when there is no match.
      const subject = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      const pattern = toStr(args[1] ? evalExpr(args[1], ctx) : '');
      // args[2] = matchnum (unused; we return the first match)
      const submatch = args[3]
        ? parseInt(toStr(evalExpr(args[3], ctx)), 10) || 0
        : 0;
      const fallback = args[4] ? toStr(evalExpr(args[4], ctx)) : '';
      try {
        const m = new RegExp(pattern).exec(subject);
        if (!m) return fallback;
        return m[submatch] ?? fallback;
      } catch {
        return fallback;
      }
    }
    case 'replace': {
      const subject = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      const search = toStr(args[1] ? evalExpr(args[1], ctx) : '');
      const replacement = toStr(args[2] ? evalExpr(args[2], ctx) : '');
      return subject.split(search).join(replacement);
    }
    case 'wrap': {
      // wrap(str, prefix, suffix) — wraps str only if non-empty.
      const s = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      if (!s) return '';
      const prefix = toStr(args[1] ? evalExpr(args[1], ctx) : '');
      const suffix = toStr(args[2] ? evalExpr(args[2], ctx) : '');
      return prefix + s + suffix;
    }
    case 'field': {
      // field(str, delim, fieldno) — split on delim, return 1-indexed field.
      const s = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      const delim = toStr(args[1] ? evalExpr(args[1], ctx) : '');
      const n = args[2] ? parseInt(toStr(evalExpr(args[2], ctx)), 10) || 1 : 1;
      if (!delim) return s;
      const parts = s.split(delim);
      return parts[n - 1] ?? '';
    }
    case 'prifilt': {
      // prifilt("mail.warn") — facility/priority filter, evaluated against
      // the current message's $syslogfacility / $syslogseverity.
      const spec = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      return matchPrifilt(spec, ctx);
    }
    case 'exec_template': {
      const tplName = toStr(args[0] ? evalExpr(args[0], ctx) : '');
      const tpl = ctx.model.templateByName[tplName];
      const r = ctx.renderTemplate(tplName);
      if (!tpl || r.missing) {
        ctx.emit({
          step: ++ctx.stepCounter.n,
          type: 'note',
          message: `exec_template("${tplName}") — template not defined; returning ""`,
          source
        });
        return '';
      }
      ctx.emit({
        step: ++ctx.stepCounter.n,
        type: 'note',
        message: `exec_template("${tplName}") → ${JSON.stringify(r.value).slice(0, 80)}`,
        source: tpl.source,
        details: { template: tplName, value: r.value }
      });
      return r.value;
    }
    default:
      ctx.emit({
        step: ++ctx.stepCounter.n,
        type: 'note',
        message: `Function ${callee}(...) not implemented; returning ""`,
        source
      });
      return '';
  }
}

function scalarEq(a: ScalarValue, b: ScalarValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return toStr(a) === toStr(b);
  return toStr(a) === toStr(b);
}

function containsOp(haystack: ScalarValue, needle: ScalarValue, ci: boolean): boolean {
  const hs = ci ? toStr(haystack).toLowerCase() : toStr(haystack);
  if (Array.isArray(needle)) {
    return needle.some((n) => hs.includes(ci ? String(n).toLowerCase() : String(n)));
  }
  const n = ci ? toStr(needle).toLowerCase() : toStr(needle);
  return hs.includes(n);
}

function startswithOp(haystack: ScalarValue, needle: ScalarValue, ci: boolean): boolean {
  const hs = ci ? toStr(haystack).toLowerCase() : toStr(haystack);
  if (Array.isArray(needle)) {
    return needle.some((n) => hs.startsWith(ci ? String(n).toLowerCase() : String(n)));
  }
  const n = ci ? toStr(needle).toLowerCase() : toStr(needle);
  return hs.startsWith(n);
}
