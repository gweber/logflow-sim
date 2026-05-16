import type {
  ConfigFile,
  TopStmt,
  DriverCall,
  DriverArg,
  FilterExpr,
  NamedBlock,
  LogBlock,
  LogItem
} from './ast.js';
import { tokenize, type Token, type TokenKind } from './lexer.js';
import { DiagnosticBag } from '../../../diagnostics.js';
import type { SourceLoc } from '../../../source-map.js';
import { spanLoc } from '../../../source-map.js';

class P {
  pos = 0;
  constructor(
    readonly tokens: Token[],
    readonly file: string,
    readonly content: string,
    readonly diags: DiagnosticBag
  ) {}
  peek(off = 0): Token {
    return this.tokens[Math.min(this.pos + off, this.tokens.length - 1)];
  }
  advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }
  skipNL(): void {
    while (this.peek().kind === 'NEWLINE') this.pos++;
  }
  expect(kind: TokenKind, msg?: string): Token {
    this.skipNL();
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
  const p = new P(tokens, file.path, file.content, diags);

  const statements: TopStmt[] = [];
  while (true) {
    p.skipNL();
    if (p.peek().kind === 'EOF') break;
    const stmt = parseTopStmt(p);
    if (stmt) statements.push(stmt);
  }

  return {
    ast: {
      kind: 'ConfigFile',
      path: file.path,
      statements,
      source: {
        file: file.path,
        line: 1,
        col: 1,
        offset: 0,
        length: file.content.length
      }
    },
    diagnostics: diags
  };
}

function parseTopStmt(p: P): TopStmt | null {
  p.skipNL();
  const t = p.peek();
  if (t.kind === 'EOF') return null;

  // Pragmas: @version: …  @include "…"  @define …
  if (t.kind === 'AT') return parsePragma(p);

  if (t.kind === 'KEYWORD') {
    switch (t.value) {
      case 'options':
        return parseOptions(p);
      case 'source':
      case 'destination':
      case 'filter':
      case 'template':
      case 'parser':
      case 'rewrite':
        return parseNamedBlock(p, t.value);
      case 'log':
        return parseLog(p);
      case 'block':
        return parseUserBlock(p);
    }
  }
  return swallowUnknown(p);
}

function parsePragma(p: P): TopStmt {
  const at = p.advance(); // @
  // Most pragmas are `@<ident>: <value>` or `@<ident> "value"`.
  const nameTok = p.advance();
  const name = nameTok.value;
  // optional `:`
  if (p.peek().kind === 'COLON') p.advance();
  // Read everything to end-of-line as the payload.
  const start = p.peek().loc.offset;
  let end = start;
  while (p.peek().kind !== 'NEWLINE' && p.peek().kind !== 'EOF' && p.peek().kind !== 'SEMI') {
    end = p.peek().loc.offset + p.peek().loc.length;
    p.advance();
  }
  if (p.peek().kind === 'SEMI') p.advance();
  const payload = p.content.slice(start, end).trim().replace(/^"(.*)"$/, '$1');
  const loc = spanLoc(at.loc, { ...at.loc, offset: end, length: 0 });
  if (name === 'version') return { kind: 'VersionPragma', version: payload, source: loc };
  if (name === 'include') return { kind: 'IncludePragma', spec: payload, source: loc };
  // Other @-pragmas (e.g. @define, @module) are accepted but not modelled further.
  return { kind: 'UnknownTop', raw: `@${name} ${payload}`, source: loc };
}

function parseOptions(p: P): TopStmt {
  const head = p.advance(); // 'options'
  p.expect('LBRACE');
  const calls: DriverCall[] = [];
  p.skipNL();
  while (p.peek().kind !== 'RBRACE' && p.peek().kind !== 'EOF') {
    const call = parseDriverCall(p);
    if (call) calls.push(call);
    p.skipNL();
    if (p.peek().kind === 'SEMI') p.advance();
    p.skipNL();
  }
  const rb = p.expect('RBRACE');
  // Optional trailing semicolon at top level.
  if (p.peek().kind === 'SEMI') p.advance();
  return { kind: 'OptionsBlock', calls, source: spanLoc(head.loc, rb.loc) };
}

function parseNamedBlock(p: P, kind: NamedBlock['blockKind']): TopStmt {
  const head = p.advance();
  p.skipNL();
  const nameTok = p.peek();
  let name = '';
  if (nameTok.kind === 'IDENT' || nameTok.kind === 'KEYWORD' || nameTok.kind === 'STRING') {
    name = nameTok.kind === 'STRING' ? nameTok.value : nameTok.text;
    p.advance();
  } else {
    // anonymous block (rare but legal for inline definitions)
  }
  p.expect('LBRACE');

  let body: DriverCall[] = [];
  let filterExpr: FilterExpr | undefined;
  if (kind === 'filter') {
    filterExpr = parseFilterExpr(p);
    // tolerate trailing `;`
    p.skipNL();
    if (p.peek().kind === 'SEMI') p.advance();
  } else {
    body = parseDriverBody(p);
  }
  const rb = p.expect('RBRACE');
  if (p.peek().kind === 'SEMI') p.advance();
  return {
    kind: 'NamedBlock',
    blockKind: kind,
    name,
    body,
    filter: filterExpr,
    source: spanLoc(head.loc, rb.loc)
  };
}

function parseDriverBody(p: P): DriverCall[] {
  const calls: DriverCall[] = [];
  p.skipNL();
  while (p.peek().kind !== 'RBRACE' && p.peek().kind !== 'EOF') {
    const before = p.pos;
    // Nested block like `channel { … }` or `filterx { … }` — eat the whole
    // nested block as opaque so we don't infinite-loop on unfamiliar syntax.
    if (p.peek().kind === 'LBRACE') {
      skipBalancedBlock(p);
      p.skipNL();
      if (p.peek().kind === 'SEMI') p.advance();
      continue;
    }
    const call = parseDriverCall(p);
    if (call) calls.push(call);
    p.skipNL();
    if (p.peek().kind === 'SEMI') p.advance();
    p.skipNL();
    if (p.pos === before) {
      // Defensive: never stall on an unexpected token. Advance one and try
      // the next statement.
      p.advance();
    }
  }
  return calls;
}

/**
 * Eat tokens from an opening `{` up to and including its matching `}`,
 * counting nesting so we don't terminate on inner braces. Used to skip
 * over syslog-ng v4-only blocks (filterx, channel, junction) that we don't
 * model in detail yet.
 */
function skipBalancedBlock(p: P): void {
  if (p.peek().kind !== 'LBRACE') return;
  p.advance();
  let depth = 1;
  while (p.peek().kind !== 'EOF' && depth > 0) {
    const k = p.peek().kind;
    if (k === 'LBRACE') depth++;
    else if (k === 'RBRACE') {
      depth--;
      if (depth === 0) {
        p.advance();
        return;
      }
    }
    p.advance();
  }
}

function parseDriverCall(p: P): DriverCall | null {
  p.skipNL();
  const t = p.peek();
  if (t.kind !== 'IDENT' && t.kind !== 'KEYWORD') {
    // unrecoverable token at this position — skip one and continue.
    p.diags.warning(
      `Skipping unexpected token "${t.text}" inside block body`,
      t.loc,
      'W_SNG_TOKEN'
    );
    p.advance();
    return null;
  }
  const head = p.advance();
  // Allow dotted/hyphenated driver names continuing through `-`/`.`.
  let name = head.text;
  while ((p.peek().kind === 'DASH' || p.peek().kind === 'DOT') && (p.peek(1).kind === 'IDENT' || p.peek(1).kind === 'KEYWORD')) {
    const sep = p.advance();
    const part = p.advance();
    name += sep.text + part.text;
  }
  if (p.peek().kind !== 'LPAREN') {
    // Bare identifier used as a flag-style argument.
    return {
      kind: 'DriverCall',
      name,
      args: [],
      source: head.loc
    };
  }
  p.advance(); // (
  const args: DriverArg[] = [];
  p.skipNL();
  while (p.peek().kind !== 'RPAREN' && p.peek().kind !== 'EOF') {
    const a = parseDriverArg(p);
    if (a) args.push(a);
    p.skipNL();
    if (p.peek().kind === 'COMMA') {
      p.advance();
      p.skipNL();
    }
  }
  const close = p.expect('RPAREN');
  return { kind: 'DriverCall', name, args, source: spanLoc(head.loc, close.loc) };
}

function parseDriverArg(p: P): DriverArg | null {
  p.skipNL();
  const t = p.peek();
  if (t.kind === 'STRING') {
    p.advance();
    return { kind: 'string', value: t.value, source: t.loc };
  }
  if (t.kind === 'NUMBER') {
    p.advance();
    return { kind: 'number', value: parseFloat(t.value), source: t.loc };
  }
  if (t.kind === 'IDENT' || t.kind === 'KEYWORD') {
    // Could be a nested driver call (next token `(`) or a bare ident.
    if (p.peek(1).kind === 'LPAREN' || p.peek(1).kind === 'DASH' || p.peek(1).kind === 'DOT') {
      const call = parseDriverCall(p);
      return call ? { kind: 'call', call } : null;
    }
    p.advance();
    return { kind: 'ident', value: t.text, source: t.loc };
  }
  if (t.kind === 'DASH' || t.kind === 'DOT') {
    p.advance();
    return null;
  }
  return null;
}

function parseFilterExpr(p: P): FilterExpr {
  return parseOr(p);
}

function parseOr(p: P): FilterExpr {
  let left = parseAnd(p);
  while (p.peek().kind === 'KEYWORD' && p.peek().value === 'or') {
    const t = p.advance();
    void t;
    const right = parseAnd(p);
    left = {
      kind: 'FilterBinary',
      op: 'or',
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

function parseAnd(p: P): FilterExpr {
  let left = parseNot(p);
  while (p.peek().kind === 'KEYWORD' && p.peek().value === 'and') {
    p.advance();
    const right = parseNot(p);
    left = {
      kind: 'FilterBinary',
      op: 'and',
      left,
      right,
      source: spanLoc(left.source, right.source)
    };
  }
  return left;
}

function parseNot(p: P): FilterExpr {
  if (p.peek().kind === 'KEYWORD' && p.peek().value === 'not') {
    const t = p.advance();
    const operand = parseNot(p);
    return { kind: 'FilterUnary', op: 'not', operand, source: spanLoc(t.loc, operand.source) };
  }
  return parseFilterPrimary(p);
}

function parseFilterPrimary(p: P): FilterExpr {
  p.skipNL();
  const t = p.peek();
  if (t.kind === 'LPAREN') {
    p.advance();
    const inner = parseFilterExpr(p);
    p.expect('RPAREN');
    return inner;
  }
  // Filter call: facility(mail), level(info..emerg), match("re" value("MSG")), …
  if (t.kind === 'IDENT' || t.kind === 'KEYWORD') {
    const call = parseDriverCall(p);
    if (call) {
      return { kind: 'FilterCall', name: call.name, args: call.args, source: call.source };
    }
  }
  // Empty/unexpected — return a placeholder.
  return { kind: 'FilterCall', name: '', args: [], source: t.loc };
}

function parseLog(p: P): TopStmt {
  const head = p.advance();
  p.expect('LBRACE');
  const items: LogItem[] = [];
  p.skipNL();
  while (p.peek().kind !== 'RBRACE' && p.peek().kind !== 'EOF') {
    const item = parseLogItem(p);
    if (item) items.push(item);
    p.skipNL();
    if (p.peek().kind === 'SEMI') p.advance();
    p.skipNL();
  }
  const rb = p.expect('RBRACE');
  if (p.peek().kind === 'SEMI') p.advance();
  return { kind: 'LogBlock', items, source: spanLoc(head.loc, rb.loc) };
}

function parseLogItem(p: P): LogItem | null {
  p.skipNL();
  const t = p.peek();
  if (t.kind === 'KEYWORD' && t.value === 'log') {
    const nested = parseLog(p) as LogBlock;
    return { kind: 'nestedLog', block: nested };
  }
  if (t.kind === 'KEYWORD' || t.kind === 'IDENT') {
    const name = t.value.toLowerCase();
    if (name === 'flags') {
      const head = p.advance();
      p.expect('LPAREN');
      const flags: string[] = [];
      while (p.peek().kind !== 'RPAREN' && p.peek().kind !== 'EOF') {
        const ft = p.peek();
        if (ft.kind === 'IDENT' || ft.kind === 'KEYWORD' || ft.kind === 'STRING') {
          flags.push(ft.kind === 'STRING' ? ft.value : ft.text);
        }
        p.advance();
        if (p.peek().kind === 'COMMA') p.advance();
      }
      const close = p.expect('RPAREN');
      return { kind: 'flags', flags, source: spanLoc(head.loc, close.loc) };
    }
    if (
      name === 'source' ||
      name === 'destination' ||
      name === 'filter' ||
      name === 'parser' ||
      name === 'rewrite'
    ) {
      const head = p.advance();
      p.expect('LPAREN');
      // First-argument name is the reference; ignore further args.
      let refName = '';
      while (p.peek().kind !== 'RPAREN' && p.peek().kind !== 'EOF') {
        const tt = p.peek();
        if ((tt.kind === 'IDENT' || tt.kind === 'KEYWORD') && !refName) {
          refName = tt.text;
        } else if (tt.kind === 'STRING' && !refName) {
          refName = tt.value;
        }
        p.advance();
      }
      const close = p.expect('RPAREN');
      return {
        kind: 'ref',
        kindOf: name as 'source' | 'filter' | 'destination' | 'parser' | 'rewrite',
        name: refName,
        source: spanLoc(head.loc, close.loc)
      };
    }
  }
  p.advance();
  return null;
}

function parseUserBlock(p: P): TopStmt {
  const head = p.advance(); // 'block'
  // Skip until matching RBRACE counting nesting.
  // Capture raw body text.
  const start = head.loc.offset;
  let depth = 0;
  let foundBrace = false;
  while (p.peek().kind !== 'EOF') {
    const tt = p.peek();
    if (tt.kind === 'LBRACE') {
      depth++;
      foundBrace = true;
    }
    if (tt.kind === 'RBRACE') {
      depth--;
      if (depth === 0) {
        p.advance();
        break;
      }
    }
    p.advance();
    if (!foundBrace && (tt.kind === 'NEWLINE' || tt.kind === 'EOF')) break;
  }
  const end = p.peek().loc.offset;
  const body = p.content.slice(start, end);
  return { kind: 'UserBlock', funcName: '', body, source: { ...head.loc, length: end - start } };
}

function swallowUnknown(p: P): TopStmt {
  const t = p.peek();
  if (t.kind === 'EOF') return { kind: 'UnknownTop', raw: '', source: t.loc };
  const start = t.loc.offset;
  // Consume to next semicolon, closing brace at depth-0, or newline.
  while (
    p.peek().kind !== 'EOF' &&
    p.peek().kind !== 'NEWLINE' &&
    p.peek().kind !== 'SEMI'
  ) {
    p.advance();
  }
  const end = p.peek().loc.offset;
  const raw = p.content.slice(start, end).trim();
  if (p.peek().kind === 'SEMI') p.advance();
  if (raw) {
    p.diags.warning(
      `Unrecognized statement preserved as UnknownTop: ${raw.slice(0, 80)}`,
      { ...t.loc, length: end - start },
      'W_UNKNOWN_STATEMENT'
    );
  }
  return { kind: 'UnknownTop', raw, source: { ...t.loc, length: end - start } };
}
