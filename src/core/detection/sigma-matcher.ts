/**
 * Sigma matcher — evaluates a SigmaRule against a SyslogMessage and the
 * runtime property map. Returns true iff the rule would fire on that
 * message.
 *
 * Field-name resolution: we accept the common Sigma names that map to
 * syslog properties:
 *
 *   programname / Image / ProcessName  → message.programname
 *   msg / Message / CommandLine        → message.msg
 *   hostname / Computer / Hostname     → message.hostname
 *   user / User / SubjectUserName      → string-search in msg as a heuristic
 *   facility                           → derived from <PRI>
 *   severity / level                   → derived from <PRI>
 *
 * Everything else is looked up in a generic `extra` map the engine can
 * inject (e.g. structured-data fields from RFC5424). Unknown fields
 * compare as "no value" — selections that require them simply don't fire.
 */

import type { SyslogMessage } from '../simulate/syslog-message.js';
import type { SigmaRule, SigmaField, SigmaSelection } from './types.js';
import { parseRawMessage } from '../simulate/parse-rawmsg.js';

export interface SigmaMatchContext {
  message: SyslogMessage;
  /** Extra fields (RFC5424 structured-data, derived facility/severity, etc.). */
  extra?: Record<string, string>;
}

/**
 * Decide whether `rule` would fire on `ctx`. The condition expression is
 * a small boolean DSL (`a and not b`, `1 of selection*`, etc.) — we
 * tokenize and evaluate it against the per-selection match results.
 */
export function matches(rule: SigmaRule, ctx: SigmaMatchContext): boolean {
  // Cheap logsource gate: rules tagged `product: windows` rarely apply to
  // syslog batches; skip them so we don't drown the report in false
  // positives caused by an absent field comparing as no-value.
  const product = rule.logsource.product?.toLowerCase();
  if (product && product !== 'linux' && product !== '' && product !== 'unix') {
    return false;
  }

  const selectionResults = new Map<string, boolean>();
  for (const sel of rule.selections) {
    selectionResults.set(sel.name, evalSelection(sel, ctx));
  }
  return evalCondition(rule.condition, selectionResults);
}

function evalSelection(sel: SigmaSelection, ctx: SigmaMatchContext): boolean {
  // All fields in a selection are AND-joined.
  for (const f of sel.fields) {
    if (!evalField(f, ctx)) return false;
  }
  return true;
}

function evalField(field: SigmaField, ctx: SigmaMatchContext): boolean {
  const fieldValue = resolveFieldValue(field.name, ctx);
  if (fieldValue === undefined) return false;
  const caseInsensitive = field.modifiers.includes('i');
  const requireAll = field.modifiers.includes('all');
  const op = pickOp(field.modifiers);

  const hay = caseInsensitive ? fieldValue.toLowerCase() : fieldValue;
  const needles = field.values.map((v) => (caseInsensitive ? v.toLowerCase() : v));

  const fn = (needle: string): boolean => {
    if (op === 'eq') return hay === needle;
    if (op === 'contains') return hay.includes(needle);
    if (op === 'startswith') return hay.startsWith(needle);
    if (op === 'endswith') return hay.endsWith(needle);
    if (op === 're') {
      try {
        return new RegExp(needle, caseInsensitive ? 'i' : '').test(fieldValue);
      } catch {
        return false;
      }
    }
    return false;
  };

  if (requireAll) return needles.every(fn);
  return needles.some(fn);
}

function pickOp(mods: SigmaField['modifiers']): 'eq' | 'contains' | 'startswith' | 'endswith' | 're' {
  if (mods.includes('contains')) return 'contains';
  if (mods.includes('startswith')) return 'startswith';
  if (mods.includes('endswith')) return 'endswith';
  if (mods.includes('re')) return 're';
  return 'eq';
}

const FIELD_ALIASES: Record<string, string> = {
  image: 'programname',
  processname: 'programname',
  process_name: 'programname',
  imagepath: 'programname',
  message: 'msg',
  commandline: 'msg',
  command_line: 'msg',
  computer: 'hostname',
  computername: 'hostname',
  host: 'hostname'
};

function resolveFieldValue(name: string, ctx: SigmaMatchContext): string | undefined {
  const lc = name.toLowerCase();
  const alias = FIELD_ALIASES[lc] ?? lc;

  if (alias === 'programname') return ctx.message.programname;
  if (alias === 'msg') return ctx.message.msg ?? ctx.message.rawmsg;
  if (alias === 'rawmsg') return ctx.message.rawmsg;
  if (alias === 'hostname') return ctx.message.hostname;
  if (alias === 'syslogtag') return ctx.message.syslogtag;
  if (alias === 'fromhost') return ctx.message.fromhost;
  if (alias === 'fromhostip' || alias === 'fromhost-ip') return ctx.message.fromhostIp;

  // `user`, `subjectusername`, etc. — common Sigma fields with no
  // structured equivalent in syslog. Best-effort heuristic: search the
  // message body for the value at match time (done by evalField), so we
  // return `msg` here so the comparison has something to chew on.
  if (alias === 'user' || alias === 'subjectusername' || alias === 'username') {
    return ctx.message.msg ?? ctx.message.rawmsg;
  }

  // Derived: facility / severity from <PRI>.
  if (alias === 'facility' || alias === 'severity' || alias === 'level') {
    const parsed = parseRawMessage(ctx.message.rawmsg ?? '');
    if (alias === 'facility' && parsed.facility !== undefined) return String(parsed.facility);
    if ((alias === 'severity' || alias === 'level') && parsed.severity !== undefined) {
      return String(parsed.severity);
    }
    return undefined;
  }

  return ctx.extra?.[name] ?? ctx.extra?.[lc];
}

// ---------------------------------------------------------------------------
// Condition expression — `selection`, `selection and not filter`, `1 of *`,
// `any of selection_*`, etc. Small recursive-descent so we don't drag in a
// dependency for a 30-line evaluator.
// ---------------------------------------------------------------------------

interface Token {
  type: 'name' | 'op' | 'lparen' | 'rparen';
  value: string;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(\(|\)|[A-Za-z_*][\w*]*)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tok = m[1];
    if (tok === '(') out.push({ type: 'lparen', value: tok });
    else if (tok === ')') out.push({ type: 'rparen', value: tok });
    else if (tok === 'and' || tok === 'or' || tok === 'not' || tok === 'of') {
      out.push({ type: 'op', value: tok });
    } else if (tok === '1' || tok === 'any' || tok === 'all') {
      out.push({ type: 'op', value: tok });
    } else {
      out.push({ type: 'name', value: tok });
    }
  }
  return out;
}

function evalCondition(condition: string, results: Map<string, boolean>): boolean {
  const tokens = tokenize(condition);
  if (tokens.length === 0) return false;
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }
  function consume(): Token | undefined {
    return tokens[pos++];
  }

  function expr(): boolean {
    let acc = orTerm();
    return acc;
  }
  function orTerm(): boolean {
    let acc = andTerm();
    while (peek()?.type === 'op' && peek()!.value === 'or') {
      consume();
      acc = andTerm() || acc;
    }
    return acc;
  }
  function andTerm(): boolean {
    let acc = notTerm();
    while (peek()?.type === 'op' && peek()!.value === 'and') {
      consume();
      acc = notTerm() && acc;
    }
    return acc;
  }
  function notTerm(): boolean {
    if (peek()?.type === 'op' && peek()!.value === 'not') {
      consume();
      return !notTerm();
    }
    return atom();
  }
  function atom(): boolean {
    const t = peek();
    if (!t) return false;
    if (t.type === 'lparen') {
      consume();
      const v = expr();
      if (peek()?.type === 'rparen') consume();
      return v;
    }
    if (t.type === 'op' && (t.value === '1' || t.value === 'any' || t.value === 'all')) {
      // `1 of selection_*`  /  `any of *`  /  `all of selection_*`
      const quantifier = consume()!.value;
      if (peek()?.type === 'op' && peek()!.value === 'of') consume();
      const target = consume();
      if (!target || target.type !== 'name') return false;
      const wildcard = target.value;
      const names = [...results.keys()].filter((n) => matchWildcard(n, wildcard));
      if (quantifier === 'all') return names.every((n) => results.get(n) === true);
      return names.some((n) => results.get(n) === true);
    }
    if (t.type === 'name') {
      consume();
      return results.get(t.value) === true;
    }
    return false;
  }

  return expr();
}

function matchWildcard(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return name === pattern;
  const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return re.test(name);
}
