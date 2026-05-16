import type {
  ConfigFile,
  Stmt,
  Expr,
  KVParam,
  IfStmt,
  ActionStmt,
  RulesetStmt,
  SetStmt,
  ResetStmt,
  UnsetStmt,
  LocalVarRef,
  StructuredRef,
  BinaryOperator,
  CallExpr,
  LookupCall
} from './ast.js';
import { tokenize, type Token } from './lexer.js';
import { DiagnosticBag } from '../../../diagnostics.js';
import type { SourceLoc } from '../../../source-map.js';
import { spanLoc } from '../../../source-map.js';

class ParserState {
  pos = 0;
  constructor(
    readonly tokens: Token[],
    readonly file: string,
    readonly content: string,
    readonly diags: DiagnosticBag
  ) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  /** Advance past any NEWLINE tokens. */
  skipNewlines(): void {
    while (this.peek().kind === 'NEWLINE') this.pos++;
  }

  /** True if next non-newline token matches. */
  atKeyword(...names: string[]): boolean {
    const t = this.peekNonNL();
    return t.kind === 'KEYWORD' && names.includes(t.value);
  }

  peekNonNL(): Token {
    let p = this.pos;
    while (p < this.tokens.length - 1 && this.tokens[p].kind === 'NEWLINE') p++;
    return this.tokens[p];
  }

  consumeNonNL(): Token {
    this.skipNewlines();
    return this.advance();
  }

  expect(kind: Token['kind'], msg?: string): Token {
    this.skipNewlines();
    const t = this.peek();
    if (t.kind !== kind) {
      this.diags.error(msg ?? `Expected ${kind}, got ${t.kind} "${t.text}"`, t.loc, 'E_EXPECT');
      return t;
    }
    return this.advance();
  }
}

export interface ParseResult {
  ast: ConfigFile;
  diagnostics: DiagnosticBag;
}

export function parse(file: { path: string; content: string }): ParseResult {
  const diags = new DiagnosticBag();
  const tokens = tokenize(file.path, file.content);
  const p = new ParserState(tokens, file.path, file.content, diags);

  const statements: Stmt[] = [];
  const fileLoc: SourceLoc = {
    file: file.path,
    line: 1,
    col: 1,
    offset: 0,
    length: file.content.length
  };

  while (true) {
    p.skipNewlines();
    if (p.peek().kind === 'EOF') break;
    const stmt = parseStmt(p);
    if (stmt) statements.push(stmt);
  }

  return {
    ast: { kind: 'ConfigFile', path: file.path, statements, source: fileLoc },
    diagnostics: diags
  };
}

function parseStmt(p: ParserState): Stmt | null {
  p.skipNewlines();
  const t = p.peek();

  if (t.kind === 'LEGACY_DIRECTIVE') {
    p.advance();
    const raw = t.text.trim();
    const m = /^\$(\w+)\s*(.*)$/.exec(raw);
    return {
      kind: 'LegacyDirective',
      name: m?.[1] ?? raw,
      rest: m?.[2]?.trim() ?? '',
      raw,
      source: t.loc
    };
  }

  if (t.kind === 'KEYWORD') {
    switch (t.value) {
      case 'module':
      case 'global':
      case 'main_queue':
      case 'input':
      case 'template':
      case 'lookup_table':
      case 'action':
        return parseCallLikeStmt(p);
      case 'reload_lookup_table':
        return parseReloadLookupTable(p);
      case 'ruleset':
        return parseRuleset(p);
      case 'if':
        return parseIf(p);
      case 'set':
        return parseSet(p, 'SetStmt');
      case 'reset':
        return parseSet(p, 'ResetStmt');
      case 'unset':
        return parseUnset(p);
      case 'stop':
        return parseStop(p);
      case 'continue':
        return parseContinue(p);
      case 'call':
        return parseCall(p);
      case 'include':
        return parseIncludeStmt(p);
    }
  }

  // BSD-style legacy selector lines like `mail.* /var/log/mail.log` are very
  // common in distro defaults; pick them up here before falling through to
  // UnknownNode so the simulator can actually run them.
  const legacy = tryParseLegacySelector(p);
  if (legacy) return legacy;

  // Hybrid form: `<facspec>  action(type="..." ...)` — BSD selector prefix
  // gating a modern action() call. Detect this BEFORE we give up to
  // UnknownNode so the simulator can evaluate it like an `if prifilt(...)`.
  const hybrid = tryParseLegacyActionPrefix(p);
  if (hybrid) return hybrid;

  // Property-based filter `:propname, op, "value"  <target>`.
  const propfilter = tryParsePropertyFilter(p);
  if (propfilter) return propfilter;

  return parseUnknownLine(p);
}

/**
 * Recognize `<facility.severity-spec>  action(...)` and wrap it as
 * `if prifilt("<facspec>") then action(...)`. Handles the multi-line case
 * (action body may span several lines) by delegating to the regular action
 * statement parser once the facspec tokens have been consumed.
 */
function tryParseLegacyActionPrefix(p: ParserState): Stmt | null {
  const t = p.peek();
  if (t.kind === 'EOF' || t.kind === 'NEWLINE') return null;

  const lineStart = t.loc.offset;
  let lineEnd = lineStart;
  lineEnd = followLineContinuations(p.content, lineEnd);
  const line = logicalLine(p.content, lineStart, lineEnd);

  // `<facspec>  action(...` — capture the facspec part up to `action(`.
  const m =
    /^\s*([A-Za-z*][\w,*]*\.(?:!=?[\w*]+|=?[\w*]+|none)(?:\s*;\s*[A-Za-z*][\w,*]*\.(?:!=?[\w*]+|=?[\w*]+|none))*)\s+(action\s*\()/.exec(
      line
    );
  if (!m) return null;
  const firstFac = m[1].split(/[,.]/)[0].trim().toLowerCase();
  const FAC = [
    '*', 'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
    'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'security', 'console',
    'local0','local1','local2','local3','local4','local5','local6','local7'
  ];
  if (!FAC.includes(firstFac)) return null;

  // Consume tokens covering the facspec (everything up to the `action` keyword).
  const facspecEndOffset = lineStart + m[1].length;
  const facspecLoc: SourceLoc = {
    file: p.file,
    line: t.loc.line,
    col: t.loc.col,
    offset: lineStart,
    length: m[1].length
  };
  while (p.peek().kind !== 'EOF' && p.peek().loc.offset < facspecEndOffset) p.advance();
  p.skipNewlines();

  // Now the next token should be the `action` keyword. Parse it via the
  // regular call-like parser so multi-line bodies work transparently.
  const next = p.peek();
  if (!(next.kind === 'KEYWORD' && next.value === 'action')) return null;
  const action = parseCallLikeStmt(p);

  // Build a synthetic IfStmt: if prifilt(facspec) then [action].
  const condition: Expr = {
    kind: 'CallExpr',
    callee: 'prifilt',
    args: [
      {
        kind: 'StringLit',
        value: m[1].trim(),
        source: facspecLoc
      }
    ],
    source: facspecLoc
  };
  return {
    kind: 'IfStmt',
    condition,
    then: [action],
    source: spanLoc(facspecLoc, action.source)
  };
}

/**
 * Walk `content` from `start` to the first real end-of-line, transparently
 * following backslash-newline continuations as a single logical line. The
 * returned offset points at the terminating `\n` (or `content.length`).
 *
 * Used by the legacy-selector matcher so multi-line selectors like
 *   *.=debug;\
 *       auth,authpriv.none;\
 *       news.none;mail.none      -/var/log/debug
 * are recognized as one statement.
 */
function followLineContinuations(content: string, start: number): number {
  let i = start;
  while (i < content.length) {
    if (content.charCodeAt(i) === 0x0a) return i;
    if (content.charCodeAt(i) === 0x5c) {
      let j = i + 1;
      while (j < content.length && (content.charCodeAt(j) === 0x20 || content.charCodeAt(j) === 0x09))
        j++;
      if (j < content.length && content.charCodeAt(j) === 0x0a) {
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return i;
}

/**
 * Return the logical line text from `start` to the first un-continued newline,
 * with each `\<newline>` sequence collapsed to a single space so a regex
 * matcher can treat the whole thing as one line.
 */
function logicalLine(content: string, start: number, end: number): string {
  return content.slice(start, end).replace(/\\\s*\n[ \t]*/g, ' ');
}

const LEGACY_SELECTOR_RE =
  // `<facspec>  <target>`  where target may also begin with `?<template-name>`
  // (sysklogd dynaFile shorthand) in addition to the usual `/`, `@`, `~`, …
  /^\s*([A-Za-z*][\w,*]*\.(?:!=?[\w*]+|=?[\w*]+|none)(?:\s*;\s*[A-Za-z*][\w,*]*\.(?:!=?[\w*]+|=?[\w*]+|none))*)[ \t]+([-/@~|:&*?][^\s#]*(?:\s+[^\s#]+)?)\s*(?:#.*)?$/;

/**
 * Property-based legacy filter, sysklogd-style:
 *   :propname, op, "value"  <target>
 * where `op` is one of isequal / startswith / contains / regex / ereregex
 * (plus the negated `!isequal` etc. variants).
 *
 * Captures: 1=property, 2=op (possibly with !), 3=value, 4=target.
 */
const LEGACY_PROPFILTER_RE =
  /^\s*:([A-Za-z][\w-]*)\s*,\s*(!?(?:isequal|startswith|contains|regex|ereregex))\s*,\s*"((?:\\.|[^"\\])*)"\s+([-/@~|:&*?][^\s#]*(?:\s+[^\s#]+)?)\s*(?:#.*)?$/;

function tryParseLegacySelector(p: ParserState): Stmt | null {
  const t = p.peek();
  if (t.kind === 'EOF' || t.kind === 'NEWLINE') return null;
  // Slice the current line from the source content.
  const lineStart = t.loc.offset;
  let lineEnd = lineStart;
  lineEnd = followLineContinuations(p.content, lineEnd);
  const line = logicalLine(p.content, lineStart, lineEnd);
  const m = LEGACY_SELECTOR_RE.exec(line);
  if (!m) return null;
  // Bail out if the captured "facspec" looks like an action — for instance
  // `if $x ...` would match the pattern superficially. The first token must
  // be an IDENT/KEYWORD that is itself a valid facility name or `*`.
  const firstFac = m[1].split(/[,.]/)[0].trim().toLowerCase();
  const FACILITIES = [
    '*', 'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
    'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'security', 'console',
    'local0','local1','local2','local3','local4','local5','local6','local7'
  ];
  if (!FACILITIES.includes(firstFac)) return null;

  // Consume tokens covering the line.
  while (
    p.peek().kind !== 'NEWLINE' &&
    p.peek().kind !== 'EOF' &&
    p.peek().loc.offset < lineEnd
  ) {
    p.advance();
  }
  const loc: SourceLoc = {
    file: p.file,
    line: t.loc.line,
    col: t.loc.col,
    offset: lineStart,
    length: lineEnd - lineStart
  };
  return {
    kind: 'LegacySelectorStmt',
    facspec: m[1].trim(),
    target: m[2].trim(),
    source: loc
  };
}

/**
 * Recognize the property-based filter form
 *   :propname, op, "value"  <target>
 * and surface it as an `if <expr> then <legacy-action>` equivalent so the
 * simulator can evaluate it like any other condition.
 */
function tryParsePropertyFilter(p: ParserState): Stmt | null {
  const t = p.peek();
  if (t.kind === 'EOF' || t.kind === 'NEWLINE') return null;
  if (t.kind !== 'COLON') return null;
  const lineStart = t.loc.offset;
  const lineEnd = followLineContinuations(p.content, lineStart);
  const line = logicalLine(p.content, lineStart, lineEnd);
  const m = LEGACY_PROPFILTER_RE.exec(line);
  if (!m) return null;

  // Consume tokens covering the entire line.
  while (
    p.peek().kind !== 'NEWLINE' &&
    p.peek().kind !== 'EOF' &&
    p.peek().loc.offset < lineEnd
  ) {
    p.advance();
  }
  const loc: SourceLoc = {
    file: p.file,
    line: t.loc.line,
    col: t.loc.col,
    offset: lineStart,
    length: lineEnd - lineStart
  };
  const propName = m[1];
  const opRaw = m[2].toLowerCase();
  const negate = opRaw.startsWith('!');
  const op = negate ? opRaw.slice(1) : opRaw;
  const value = m[3];
  const target = m[4].trim();

  // Build the equivalent expression: <op>($<prop>, "value") (possibly negated).
  const propExpr: Expr = {
    kind: 'PropertyRef',
    name: propName,
    source: loc
  };
  const valueLit: Expr = { kind: 'StringLit', value, source: loc };
  let condition: Expr;
  if (op === 'isequal') {
    condition = {
      kind: 'BinaryOp',
      op: '==',
      left: propExpr,
      right: valueLit,
      source: loc
    };
  } else if (op === 'startswith') {
    condition = {
      kind: 'BinaryOp',
      op: 'startswith',
      left: propExpr,
      right: valueLit,
      source: loc
    };
  } else if (op === 'contains') {
    condition = {
      kind: 'BinaryOp',
      op: 'contains',
      left: propExpr,
      right: valueLit,
      source: loc
    };
  } else {
    // regex / ereregex
    condition = {
      kind: 'BinaryOp',
      op: '=~',
      left: propExpr,
      right: valueLit,
      source: loc
    };
  }
  if (negate) {
    condition = { kind: 'UnaryOp', op: 'not', operand: condition, source: loc };
  }

  // Synthesize the body: a single LegacySelectorStmt with `*.*` facspec and
  // the captured target. That reuses the legacy-target evaluator we already
  // have (file paths, @host, ~, ?template, …).
  const bodyTarget: Stmt = {
    kind: 'LegacySelectorStmt',
    facspec: '*.*',
    target,
    source: loc
  };
  return {
    kind: 'IfStmt',
    condition,
    then: [bodyTarget],
    source: loc
  };
}

function parseCallLikeStmt(p: ParserState): Stmt {
  const head = p.advance(); // module/global/...
  const lparen = p.expect('LPAREN');
  const params = parseParams(p);
  const rparen = p.expect('RPAREN');
  let endLoc = rparen.loc;
  const kindMap: Record<string, Stmt['kind']> = {
    module: 'ModuleStmt',
    global: 'GlobalStmt',
    main_queue: 'MainQueueStmt',
    input: 'InputStmt',
    template: 'TemplateStmt',
    lookup_table: 'LookupTableStmt',
    action: 'ActionStmt'
  };
  const kind = kindMap[head.value] as Stmt['kind'];
  void lparen;

  // `template(...) { constant(...) property(...) ... }` — list-template body.
  if (kind === 'TemplateStmt') {
    p.skipNewlines();
    if (p.peek().kind === 'LBRACE') {
      p.advance();
      const body: NonNullable<import('./ast.js').TemplateStmt['body']> = [];
      p.skipNewlines();
      while (p.peek().kind !== 'RBRACE' && p.peek().kind !== 'EOF') {
        const t = p.peek();
        if (t.kind === 'IDENT' || t.kind === 'KEYWORD') {
          const name = t.value.toLowerCase();
          if (name === 'constant' || name === 'property') {
            const partHead = p.advance();
            p.expect('LPAREN');
            const partParams = parseParams(p);
            const partEnd = p.expect('RPAREN');
            body.push({
              kind: name as 'constant' | 'property',
              params: partParams,
              source: spanLoc(partHead.loc, partEnd.loc)
            });
            p.skipNewlines();
            continue;
          }
        }
        // Unknown content inside template body — consume to the next safe boundary.
        p.advance();
        p.skipNewlines();
      }
      const rb = p.expect('RBRACE');
      endLoc = rb.loc;
      return {
        kind: 'TemplateStmt',
        params,
        body,
        source: spanLoc(head.loc, endLoc)
      };
    }
  }

  return { kind, params, source: spanLoc(head.loc, endLoc) } as Stmt;
}

function parseReloadLookupTable(p: ParserState): Stmt {
  const head = p.advance();
  p.expect('LPAREN');
  let table = '';
  const t = p.peek();
  if (t.kind === 'STRING') {
    table = t.value;
    p.advance();
  } else {
    p.diags.error('Expected string table name', t.loc, 'E_RELOAD_LOOKUP');
  }
  // Optional second argument: stub/return value (e.g. reload_lookup_table("t", "none"))
  p.skipNewlines();
  if (p.peek().kind === 'COMMA') {
    p.advance();
    p.skipNewlines();
    if (p.peek().kind === 'STRING') p.advance();
  }
  const rparen = p.expect('RPAREN');
  return { kind: 'ReloadLookupTableStmt', table, source: spanLoc(head.loc, rparen.loc) };
}

function parseParams(p: ParserState): KVParam[] {
  const params: KVParam[] = [];
  p.skipNewlines();
  while (p.peek().kind !== 'RPAREN' && p.peek().kind !== 'EOF') {
    const nameTok = p.peek();
    if (nameTok.kind !== 'IDENT' && nameTok.kind !== 'KEYWORD') {
      p.diags.error(`Expected parameter name, got "${nameTok.text}"`, nameTok.loc, 'E_PARAM_NAME');
      // recover: consume one token
      p.advance();
      continue;
    }
    p.advance();
    // Accept dotted parameter names: queue.type, parser.escapeControlCharactersOnReceive, log.file, ...
    let fullName = nameTok.text;
    let endLoc = nameTok.loc;
    while (
      p.peek().kind === 'DOT' &&
      (p.peek(1).kind === 'IDENT' || p.peek(1).kind === 'KEYWORD')
    ) {
      p.advance(); // .
      const part = p.advance();
      fullName += '.' + part.text;
      endLoc = part.loc;
    }
    p.skipNewlines();
    p.expect('EQ', 'Expected = after parameter name');
    p.skipNewlines();
    const value = parsePrimary(p);
    if (value) {
      params.push({
        name: fullName,
        value,
        source: spanLoc(nameTok.loc, value.source)
      });
    }
    p.skipNewlines();
    if (p.peek().kind === 'COMMA') {
      p.advance();
      p.skipNewlines();
      continue;
    }
    // Real rsyslog allows whitespace-separated params; accept that too.
    if (p.peek().kind === 'IDENT' || p.peek().kind === 'KEYWORD') continue;
    break;
  }
  return params;
}

function parseRuleset(p: ParserState): Stmt {
  const head = p.advance(); // ruleset
  p.expect('LPAREN');
  const params = parseParams(p);
  const rparen = p.expect('RPAREN');
  p.skipNewlines();

  const body: Stmt[] = [];
  let endLoc: SourceLoc = rparen.loc;
  if (p.peek().kind === 'LBRACE') {
    p.advance();
    p.skipNewlines();
    while (p.peek().kind !== 'RBRACE' && p.peek().kind !== 'EOF') {
      const s = parseStmt(p);
      if (s) body.push(s);
      p.skipNewlines();
    }
    const rb = p.expect('RBRACE');
    endLoc = rb.loc;
  }
  const stmt: RulesetStmt = {
    kind: 'RulesetStmt',
    params,
    body,
    source: spanLoc(head.loc, endLoc)
  };
  return stmt;
}

function parseIf(p: ParserState): Stmt {
  const ifTok = p.advance(); // if
  const condition = parseExpr(p);
  p.skipNewlines();
  // optional `then`
  if (p.atKeyword('then')) p.consumeNonNL();
  const thenBlock = parseBlockOrSingle(p);
  let elseBlock: Stmt[] | undefined;
  p.skipNewlines();
  if (p.atKeyword('else')) {
    p.consumeNonNL();
    p.skipNewlines();
    if (p.atKeyword('if')) {
      const nested = parseIf(p);
      elseBlock = [nested];
    } else {
      elseBlock = parseBlockOrSingle(p);
    }
  }
  const stmt: IfStmt = {
    kind: 'IfStmt',
    condition,
    then: thenBlock,
    else: elseBlock,
    source: spanLoc(ifTok.loc, condition.source)
  };
  return stmt;
}

function parseBlockOrSingle(p: ParserState): Stmt[] {
  p.skipNewlines();
  if (p.peek().kind === 'LBRACE') {
    p.advance();
    const body: Stmt[] = [];
    p.skipNewlines();
    while (p.peek().kind !== 'RBRACE' && p.peek().kind !== 'EOF') {
      const s = parseStmt(p);
      if (s) body.push(s);
      p.skipNewlines();
    }
    p.expect('RBRACE');
    return body;
  }
  const s = parseStmt(p);
  return s ? [s] : [];
}

function parseSet(p: ParserState, kind: 'SetStmt' | 'ResetStmt'): Stmt {
  const head = p.advance();
  const target = parsePropTarget(p);
  p.expect('EQ');
  const value = parseExpr(p);
  p.skipNewlines();
  let endLoc = value.source;
  if (p.peek().kind === 'SEMI') {
    endLoc = p.advance().loc;
  }
  if (kind === 'SetStmt') {
    const s: SetStmt = { kind, target, value, source: spanLoc(head.loc, endLoc) };
    return s;
  }
  const s: ResetStmt = { kind, target, value, source: spanLoc(head.loc, endLoc) };
  return s;
}

function parseUnset(p: ParserState): Stmt {
  const head = p.advance();
  const target = parsePropTarget(p);
  let endLoc = target.source;
  if (p.peek().kind === 'SEMI') endLoc = p.advance().loc;
  const s: UnsetStmt = { kind: 'UnsetStmt', target, source: spanLoc(head.loc, endLoc) };
  return s;
}

function parseStop(p: ParserState): Stmt {
  const head = p.advance();
  let endLoc = head.loc;
  if (p.peek().kind === 'SEMI') endLoc = p.advance().loc;
  return { kind: 'StopStmt', source: spanLoc(head.loc, endLoc) };
}

function parseContinue(p: ParserState): Stmt {
  const head = p.advance();
  let endLoc = head.loc;
  if (p.peek().kind === 'SEMI') endLoc = p.advance().loc;
  return { kind: 'ContinueStmt', source: spanLoc(head.loc, endLoc) };
}

function parseCall(p: ParserState): Stmt {
  const head = p.advance();
  const t = p.peek();
  let name = '';
  let endLoc = head.loc;
  if (t.kind === 'IDENT' || t.kind === 'STRING') {
    name = t.kind === 'STRING' ? t.value : t.text;
    endLoc = t.loc;
    p.advance();
  } else {
    p.diags.error('Expected ruleset name after call', t.loc, 'E_CALL_NAME');
  }
  if (p.peek().kind === 'SEMI') endLoc = p.advance().loc;
  return { kind: 'CallStmt', ruleset: name, source: spanLoc(head.loc, endLoc) };
}

function parsePropTarget(p: ParserState): LocalVarRef | StructuredRef {
  const t = p.peek();
  if (t.kind !== 'PROP') {
    p.diags.error('Expected property reference', t.loc, 'E_PROP_REF');
    p.advance();
    return { kind: 'LocalVarRef', name: 'INVALID', source: t.loc };
  }
  p.advance();
  if (t.value.startsWith('$.')) {
    return { kind: 'LocalVarRef', name: t.value.slice(2), source: t.loc };
  }
  if (t.value.startsWith('$!')) {
    return { kind: 'StructuredRef', name: t.value.slice(2), source: t.loc };
  }
  p.diags.warning(
    `Assignment to non-local property "${t.value}" is unusual; treating as local`,
    t.loc,
    'W_NONLOCAL_ASSIGN'
  );
  return { kind: 'LocalVarRef', name: t.value.replace(/^\$/, ''), source: t.loc };
}

/**
 * Parse `include(file="...")` as a no-op at the parser level — the loader has
 * already pre-scanned and resolved includes. We still keep it as a LegacyDirective
 * for visibility and source-location tracking.
 */
function parseIncludeStmt(p: ParserState): Stmt {
  const head = p.advance();
  p.expect('LPAREN');
  const params = parseParams(p);
  const rparen = p.expect('RPAREN');
  const file = params.find((kv) => kv.name.toLowerCase() === 'file');
  const value = file && file.value.kind === 'StringLit' ? file.value.value : '';
  return {
    kind: 'LegacyDirective',
    name: 'include',
    rest: value,
    raw: `include(file="${value}")`,
    source: spanLoc(head.loc, rparen.loc)
  };
}

function parseUnknownLine(p: ParserState): Stmt {
  const start = p.peek();
  if (start.kind === 'EOF') return { kind: 'UnknownNode', raw: '', source: start.loc };
  // consume until newline or EOF or semi
  let end = start;
  const offset = start.loc.offset;
  while (
    p.peek().kind !== 'NEWLINE' &&
    p.peek().kind !== 'EOF' &&
    p.peek().kind !== 'SEMI'
  ) {
    end = p.advance();
  }
  const length = end.loc.offset + end.loc.length - offset;
  const raw = p.content.slice(offset, offset + length);
  const loc: SourceLoc = {
    file: p.file,
    line: start.loc.line,
    col: start.loc.col,
    offset,
    length
  };
  if (raw.trim().length > 0) {
    p.diags.warning(
      `Unrecognized statement preserved as UnknownNode: ${raw.trim().slice(0, 80)}`,
      loc,
      'W_UNKNOWN_STATEMENT'
    );
  }
  if (p.peek().kind === 'SEMI') p.advance();
  return { kind: 'UnknownNode', raw, source: loc };
}

// ---------- Expressions ----------
//
// Precedence (lowest → highest):
//   or
//   and
//   not (unary)
//   comparison: == != contains contains_i startswith startswith_i
//   primary

function parseExpr(p: ParserState): Expr {
  return parseOr(p);
}

function parseOr(p: ParserState): Expr {
  let left = parseAnd(p);
  while (p.atKeyword('or')) {
    const op = p.consumeNonNL();
    const right = parseAnd(p);
    left = {
      kind: 'BinaryOp',
      op: op.value as BinaryOperator,
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

function parseAnd(p: ParserState): Expr {
  let left = parseNot(p);
  while (p.atKeyword('and')) {
    const op = p.consumeNonNL();
    const right = parseNot(p);
    left = {
      kind: 'BinaryOp',
      op: op.value as BinaryOperator,
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

function parseNot(p: ParserState): Expr {
  if (p.atKeyword('not')) {
    const op = p.consumeNonNL();
    const operand = parseNot(p);
    return {
      kind: 'UnaryOp',
      op: 'not',
      operand,
      source: spanLoc(op.loc, operand.source)
    };
  }
  return parseComparison(p);
}

function parseComparison(p: ParserState): Expr {
  const left = parseConcat(p);
  p.skipNewlines();
  const t = p.peek();
  if (t.kind === 'EQEQ' || t.kind === 'NEQ') {
    p.advance();
    const right = parseConcat(p);
    return {
      kind: 'BinaryOp',
      op: t.kind === 'EQEQ' ? '==' : '!=',
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  if (t.kind === 'LT' || t.kind === 'LE' || t.kind === 'GT' || t.kind === 'GE') {
    p.advance();
    const right = parseConcat(p);
    const opMap: Record<string, BinaryOperator> = {
      LT: '<',
      LE: '<=',
      GT: '>',
      GE: '>='
    };
    return {
      kind: 'BinaryOp',
      op: opMap[t.kind],
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  if (t.kind === 'REGEQ' || t.kind === 'REGNEQ') {
    p.advance();
    const right = parseConcat(p);
    return {
      kind: 'BinaryOp',
      op: t.kind === 'REGEQ' ? '=~' : '!~',
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  if (
    t.kind === 'KEYWORD' &&
    (t.value === 'contains' ||
      t.value === 'contains_i' ||
      t.value === 'startswith' ||
      t.value === 'startswith_i' ||
      t.value === 'eq' ||
      t.value === 'ne')
  ) {
    p.advance();
    const right = parseConcat(p);
    // Normalize `eq`/`ne` keyword aliases to their punctuation form so the
    // evaluator only needs one BinaryOp.op shape per relation.
    const op: BinaryOperator =
      t.value === 'eq' ? '==' : t.value === 'ne' ? '!=' : (t.value as BinaryOperator);
    return {
      kind: 'BinaryOp',
      op,
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

/** String concatenation: `a & b & c` — left-associative, above comparison. */
function parseConcat(p: ParserState): Expr {
  let left = parseAdditive(p);
  while (p.peek().kind === 'AMP') {
    p.advance();
    const right = parseAdditive(p);
    left = {
      kind: 'BinaryOp',
      op: '&',
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

/** Additive arithmetic: `a + b - c`, left-associative. */
function parseAdditive(p: ParserState): Expr {
  let left = parseMultiplicative(p);
  while (p.peek().kind === 'PLUS' || p.peek().kind === 'MINUS') {
    const op = p.advance();
    const right = parseMultiplicative(p);
    left = {
      kind: 'BinaryOp',
      op: op.kind === 'PLUS' ? '+' : '-',
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

/** Multiplicative arithmetic: `a * b / c % d`, left-associative. */
function parseMultiplicative(p: ParserState): Expr {
  let left = parsePrimaryRequired(p);
  while (
    p.peek().kind === 'STAR' ||
    p.peek().kind === 'SLASH' ||
    p.peek().kind === 'PERCENT'
  ) {
    const op = p.advance();
    const right = parsePrimaryRequired(p);
    const oo: BinaryOperator =
      op.kind === 'STAR' ? '*' : op.kind === 'SLASH' ? '/' : '%';
    left = {
      kind: 'BinaryOp',
      op: oo,
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

function parsePrimaryRequired(p: ParserState): Expr {
  const e = parsePrimary(p);
  if (e) return e;
  const t = p.peek();
  p.diags.error(`Expected expression, got "${t.text}"`, t.loc, 'E_EXPECT_EXPR');
  return { kind: 'StringLit', value: '', source: t.loc };
}

function parsePrimary(p: ParserState): Expr | null {
  p.skipNewlines();
  const t = p.peek();

  if (t.kind === 'STRING') {
    p.advance();
    return { kind: 'StringLit', value: t.value, source: t.loc };
  }
  if (t.kind === 'NUMBER') {
    p.advance();
    return { kind: 'NumberLit', value: parseFloat(t.value), source: t.loc };
  }
  if (t.kind === 'PROP') {
    p.advance();
    if (t.value.startsWith('$.')) {
      return { kind: 'LocalVarRef', name: t.value.slice(2), source: t.loc };
    }
    if (t.value.startsWith('$!')) {
      return { kind: 'StructuredRef', name: t.value.slice(2), source: t.loc };
    }
    return { kind: 'PropertyRef', name: t.value.slice(1), source: t.loc };
  }
  if (t.kind === 'LPAREN') {
    p.advance();
    const inner = parseExpr(p);
    const r = p.expect('RPAREN');
    return { kind: 'ParenExpr', inner, source: spanLoc(t.loc, r.loc) };
  }
  if (t.kind === 'LBRACK') {
    p.advance();
    const elements: Expr[] = [];
    p.skipNewlines();
    while (p.peek().kind !== 'RBRACK' && p.peek().kind !== 'EOF') {
      const e = parsePrimary(p);
      if (e) elements.push(e);
      p.skipNewlines();
      if (p.peek().kind === 'COMMA') {
        p.advance();
        p.skipNewlines();
      } else {
        break;
      }
    }
    const r = p.expect('RBRACK');
    return { kind: 'ArrayLit', elements, source: spanLoc(t.loc, r.loc) };
  }
  if (t.kind === 'KEYWORD' && t.value === 'lookup') {
    p.advance();
    p.expect('LPAREN');
    const table = parseExpr(p);
    p.expect('COMMA');
    const key = parseExpr(p);
    const r = p.expect('RPAREN');
    const node: LookupCall = {
      kind: 'LookupCall',
      table,
      key,
      source: spanLoc(t.loc, r.loc)
    };
    return node;
  }
  // Generic function-call form: ident(args,...) used for things like `exec_template`
  if ((t.kind === 'IDENT' || t.kind === 'KEYWORD') && p.peek(1).kind === 'LPAREN') {
    p.advance();
    p.advance(); // (
    const args: Expr[] = [];
    p.skipNewlines();
    while (p.peek().kind !== 'RPAREN' && p.peek().kind !== 'EOF') {
      const e = parseExpr(p);
      args.push(e);
      p.skipNewlines();
      if (p.peek().kind === 'COMMA') {
        p.advance();
        p.skipNewlines();
        continue;
      }
      break;
    }
    const r = p.expect('RPAREN');
    const c: CallExpr = {
      kind: 'CallExpr',
      callee: t.text,
      args,
      source: spanLoc(t.loc, r.loc)
    };
    return c;
  }
  if (t.kind === 'IDENT') {
    p.advance();
    return { kind: 'StringLit', value: t.text, source: t.loc };
  }
  return null;
}
