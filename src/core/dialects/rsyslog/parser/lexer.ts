import type { SourceLoc } from '../../../source-map.js';
import { offsetToLineCol } from '../../../source-map.js';

export type TokenKind =
  | 'IDENT'
  | 'KEYWORD'
  | 'STRING'
  | 'NUMBER'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACK'
  | 'RBRACK'
  | 'EQ'
  | 'EQEQ'
  | 'NEQ'
  | 'COMMA'
  | 'SEMI'
  | 'DOT'
  | 'BANG'
  | 'PROP' // $name, $.local, $!struct, $msg, etc.
  | 'LEGACY_DIRECTIVE' // $DefaultRuleset foo (whole line)
  | 'NEWLINE'
  | 'COMMENT'
  | 'AMP' // & — string concatenation in expressions, legacy filter chain at top level
  | 'STAR'
  | 'SLASH'
  | 'PLUS'
  | 'MINUS'
  | 'PERCENT'
  | 'COLON'
  | 'QMARK'
  | 'LT'
  | 'LE'
  | 'GT'
  | 'GE'
  | 'REGEQ' // =~  (regex match)
  | 'REGNEQ' // !~ (regex non-match)
  | 'EOF'
  | 'UNKNOWN';

export interface Token {
  kind: TokenKind;
  text: string;
  /** For STRING: decoded value. For PROP: full property text incl. $. For KEYWORD/IDENT: identifier. */
  value: string;
  loc: SourceLoc;
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'and',
  'or',
  'not',
  'contains',
  'contains_i',
  'startswith',
  'startswith_i',
  // rsyslog also accepts `eq` / `ne` as keyword aliases for `==` / `!=`.
  'eq',
  'ne',
  'set',
  'reset',
  'unset',
  'stop',
  'call',
  'lookup',
  'ruleset',
  'input',
  'action',
  'template',
  'module',
  'global',
  'main_queue',
  'lookup_table',
  'reload_lookup_table',
  'include',
  'continue',
  'parser',
  'on',
  'off'
]);

/**
 * Modern rsyslog discourages legacy `$Directive` syntax, but the wild is full
 * of it. We recognize *any* line that starts with `$<ident>` as a legacy
 * directive and capture the rest of the line as opaque text — the IR builder
 * decides whether to do something specific (e.g. `$DefaultRuleset`) or just
 * keep it as a record. This is what real rsyslog does too: unknown legacy
 * directives are tolerated.
 *
 * The only exception is `$<prop>` references appearing INSIDE expressions —
 * but those are never at line start, so the line-start anchor in the lexer
 * already keeps the two cases apart.
 */

/**
 * Greedily consume rsyslog property modifier syntax starting at the colon
 * after a property reference. Returns the new scan index.
 *
 * Forms accepted (chainable):
 *   :N or :N,M           — substring (1-indexed)
 *   :::lowercase, etc.   — triple-colon modifier
 *   :R,ERE,N,STR:pat--end — regex-extract
 *
 * Stops at whitespace, comment start, statement terminator (`;`), block
 * delimiters, comma, or anything that's clearly the start of the next
 * token (operators, `=`, etc.).
 */
function consumePropertyModifiers(content: string, start: number): number {
  let j = start;
  const len = content.length;
  while (j < len && content.charCodeAt(j) === 0x3a /* : */) {
    // ":::name" — triple-colon: consume name until next non-ident char.
    if (
      content.charCodeAt(j + 1) === 0x3a &&
      content.charCodeAt(j + 2) === 0x3a
    ) {
      j += 3;
      while (j < len) {
        const c = content.charCodeAt(j);
        if (
          (c >= 0x41 && c <= 0x5a) || // A-Z
          (c >= 0x61 && c <= 0x7a) || // a-z
          (c >= 0x30 && c <= 0x39) || // 0-9
          c === 0x2d /* - */ ||
          c === 0x5f /* _ */
        ) j++;
        else break;
      }
      continue;
    }
    // ":R,..." — regex extract terminates at "--end".
    if (
      j + 2 < len &&
      (content.charCodeAt(j + 1) === 0x52 || content.charCodeAt(j + 1) === 0x72) /* R */ &&
      content.charCodeAt(j + 2) === 0x2c /* , */
    ) {
      const end = content.indexOf('--end', j);
      if (end === -1) return j; // unterminated — leave for parser error
      j = end + 5;
      continue;
    }
    // ":N" or ":N,M" — numeric substring modifier.
    if (j + 1 < len && content.charCodeAt(j + 1) >= 0x30 && content.charCodeAt(j + 1) <= 0x39) {
      j++;
      while (j < len) {
        const c = content.charCodeAt(j);
        if ((c >= 0x30 && c <= 0x39) || c === 0x2c /* , */) j++;
        else break;
      }
      continue;
    }
    // Unknown modifier shape — stop, let parser see the `:` as its own token.
    break;
  }
  return j;
}

export function tokenize(file: string, content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = content.length;

  function loc(offset: number, length: number): SourceLoc {
    const { line, col } = offsetToLineCol(content, offset);
    return { file, line, col, offset, length };
  }

  function isIdentStart(c: number): boolean {
    return (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f /* _ */
    );
  }
  function isIdentCont(c: number): boolean {
    return isIdentStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d /* - */;
  }

  let atLineStart = true;

  while (i < len) {
    const start = i;
    const c = content.charCodeAt(i);

    // Whitespace (not newline)
    if (c === 0x20 || c === 0x09 || c === 0x0d) {
      i++;
      continue;
    }
    // Line continuation: `\` followed (after optional whitespace) by newline.
    // The legacy multi-line selector form uses this to wrap long facspec
    // chains across lines. We swallow the backslash + the newline so the
    // parser sees one logical line.
    if (c === 0x5c /* \\ */) {
      let k = i + 1;
      while (k < len && (content.charCodeAt(k) === 0x20 || content.charCodeAt(k) === 0x09)) k++;
      if (k < len && content.charCodeAt(k) === 0x0a) {
        i = k + 1;
        continue;
      }
    }
    if (c === 0x0a) {
      tokens.push({ kind: 'NEWLINE', text: '\n', value: '\n', loc: loc(start, 1) });
      i++;
      atLineStart = true;
      continue;
    }

    // Comments: # ... to end of line, also // ...
    if (c === 0x23 /* # */ || (c === 0x2f && content.charCodeAt(i + 1) === 0x2f)) {
      let j = i;
      while (j < len && content.charCodeAt(j) !== 0x0a) j++;
      // Skip emitting a token for comments (parser doesn't need them) but advance.
      i = j;
      continue;
    }
    // /* ... */
    if (c === 0x2f && content.charCodeAt(i + 1) === 0x2a) {
      let j = i + 2;
      while (j < len - 1 && !(content.charCodeAt(j) === 0x2a && content.charCodeAt(j + 1) === 0x2f))
        j++;
      i = Math.min(len, j + 2);
      continue;
    }

    // Legacy directive at line start: $Ident ...rest-of-line
    //
    // Match against the shape `$<ident>` followed by either whitespace or
    // end-of-line. If that holds, the whole line is one LEGACY_DIRECTIVE
    // token. Properties in expressions (`$msg`, `$.var`, `$!field`) never
    // appear at line start in valid rsyslog config, so this is unambiguous.
    if (atLineStart && c === 0x24 /* $ */) {
      let j = i + 1;
      while (j < len && isIdentCont(content.charCodeAt(j))) j++;
      const nameLen = j - (i + 1);
      const nextChar = j < len ? content.charCodeAt(j) : 0x0a;
      const looksLikeDirective =
        nameLen > 0 &&
        (nextChar === 0x20 /* space */ ||
          nextChar === 0x09 /* tab */ ||
          nextChar === 0x0a /* nl */ ||
          nextChar === 0 /* eof */);
      if (looksLikeDirective) {
        // consume to end of line
        let k = j;
        while (k < len && content.charCodeAt(k) !== 0x0a) k++;
        const text = content.slice(i, k);
        tokens.push({
          kind: 'LEGACY_DIRECTIVE',
          text,
          value: text.trim(),
          loc: loc(i, k - i)
        });
        i = k;
        atLineStart = false;
        continue;
      }
      // else fall through to property handling
    }

    atLineStart = false;

    // Property reference: $name, $.local, $!struct, $$globalvar
    // rsyslog's structured-data tree supports hierarchical paths like
    // `$!event.identifier.sub`; we include dot-separated continuations as part
    // of the same PROP token so the parser sees the whole path atomically.
    if (c === 0x24 /* $ */) {
      let j = i + 1;
      // optional . or ! or another $
      if (
        content.charCodeAt(j) === 0x2e /* . */ ||
        content.charCodeAt(j) === 0x21 /* ! */ ||
        content.charCodeAt(j) === 0x24 /* $ */
      ) {
        j++;
      }
      while (j < len && isIdentCont(content.charCodeAt(j))) j++;
      // Allow dotted sub-paths: `.subkey` may repeat as long as the dot is
      // followed by an identifier start (otherwise it's the start of `.type=`
      // dotted-parameter syntax or something else).
      while (
        j < len &&
        content.charCodeAt(j) === 0x2e /* . */ &&
        j + 1 < len &&
        isIdentStart(content.charCodeAt(j + 1))
      ) {
        j++;
        while (j < len && isIdentCont(content.charCodeAt(j))) j++;
      }
      // Property modifiers in expressions: `$msg:1:10`, `$msg:::lowercase`,
      // `$msg:R,ERE,1,FIELD:pattern--end`. We greedily consume them onto the
      // PROP token so the parser/evaluator handles them transparently.
      if (j < len && content.charCodeAt(j) === 0x3a /* : */) {
        j = consumePropertyModifiers(content, j);
      }
      const text = content.slice(i, j);
      if (text.length > 1) {
        tokens.push({ kind: 'PROP', text, value: text, loc: loc(i, j - i) });
        i = j;
        continue;
      }
    }

    // Backtick-delimited "command substitution" (a docker-entrypoint convention
    // some real-world configs use, e.g. `broker=[\`echo $KAFKA_BROKER\`]`).
    // We treat the body as an opaque string so the parser doesn't choke on
    // it; the simulator can't evaluate the inner shell anyway.
    if (c === 0x60 /* ` */) {
      let j = i + 1;
      while (j < len && content.charCodeAt(j) !== 0x60 && content.charCodeAt(j) !== 0x0a) j++;
      const value = content.slice(i + 1, j);
      // Consume the closing backtick if present.
      if (j < len && content.charCodeAt(j) === 0x60) j++;
      const text = content.slice(i, j);
      tokens.push({ kind: 'STRING', text, value, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // String literal: "..." or '...' with backslash escapes
    if (c === 0x22 /* " */ || c === 0x27 /* ' */) {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < len) {
        const cc = content.charCodeAt(j);
        if (cc === 0x5c /* \ */ && j + 1 < len) {
          const nx = content.charCodeAt(j + 1);
          if (nx === quote) {
            value += String.fromCharCode(quote);
            j += 2;
            continue;
          }
          if (nx === 0x5c) {
            value += '\\';
            j += 2;
            continue;
          }
          if (nx === 0x6e) {
            value += '\n';
            j += 2;
            continue;
          }
          if (nx === 0x74) {
            value += '\t';
            j += 2;
            continue;
          }
          value += String.fromCharCode(nx);
          j += 2;
          continue;
        }
        if (cc === quote) {
          j++;
          break;
        }
        if (cc === 0x0a) break; // unterminated
        value += String.fromCharCode(cc);
        j++;
      }
      const text = content.slice(i, j);
      tokens.push({ kind: 'STRING', text, value, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // Number
    if (c >= 0x30 && c <= 0x39) {
      let j = i + 1;
      while (j < len && content.charCodeAt(j) >= 0x30 && content.charCodeAt(j) <= 0x39) j++;
      if (content.charCodeAt(j) === 0x2e) {
        j++;
        while (j < len && content.charCodeAt(j) >= 0x30 && content.charCodeAt(j) <= 0x39) j++;
      }
      const text = content.slice(i, j);
      tokens.push({ kind: 'NUMBER', text, value: text, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentCont(content.charCodeAt(j))) j++;
      const text = content.slice(i, j);
      const lower = text.toLowerCase();
      const kind: TokenKind = KEYWORDS.has(lower) ? 'KEYWORD' : 'IDENT';
      tokens.push({ kind, text, value: lower, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // Multi-char punctuation
    if (c === 0x3d && content.charCodeAt(i + 1) === 0x3d) {
      tokens.push({ kind: 'EQEQ', text: '==', value: '==', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    if (c === 0x21 && content.charCodeAt(i + 1) === 0x3d) {
      tokens.push({ kind: 'NEQ', text: '!=', value: '!=', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    // rsyslog accepts `<>` as a not-equal alias alongside `!=`.
    if (c === 0x3c /* < */ && content.charCodeAt(i + 1) === 0x3e /* > */) {
      tokens.push({ kind: 'NEQ', text: '<>', value: '!=', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    // Regex match operators: =~ (matches), !~ (does not match).
    if (c === 0x3d /* = */ && content.charCodeAt(i + 1) === 0x7e /* ~ */) {
      tokens.push({ kind: 'REGEQ', text: '=~', value: '=~', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    if (c === 0x21 /* ! */ && content.charCodeAt(i + 1) === 0x7e /* ~ */) {
      tokens.push({ kind: 'REGNEQ', text: '!~', value: '!~', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    if (c === 0x3c /* < */ && content.charCodeAt(i + 1) === 0x3d) {
      tokens.push({ kind: 'LE', text: '<=', value: '<=', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    if (c === 0x3e /* > */ && content.charCodeAt(i + 1) === 0x3d) {
      tokens.push({ kind: 'GE', text: '>=', value: '>=', loc: loc(i, 2) });
      i += 2;
      continue;
    }
    if (c === 0x3c /* < */) {
      tokens.push({ kind: 'LT', text: '<', value: '<', loc: loc(i, 1) });
      i++;
      continue;
    }
    if (c === 0x3e /* > */) {
      tokens.push({ kind: 'GT', text: '>', value: '>', loc: loc(i, 1) });
      i++;
      continue;
    }

    // Single-char punctuation
    const single: Record<number, TokenKind> = {
      0x28: 'LPAREN',
      0x29: 'RPAREN',
      0x7b: 'LBRACE',
      0x7d: 'RBRACE',
      0x5b: 'LBRACK',
      0x5d: 'RBRACK',
      0x3d: 'EQ',
      0x2c: 'COMMA',
      0x3b: 'SEMI',
      0x2e: 'DOT',
      0x21: 'BANG',
      0x26: 'AMP',
      0x2a: 'STAR',
      0x2f: 'SLASH',
      0x2b: 'PLUS',
      0x2d: 'MINUS',
      0x25: 'PERCENT',
      0x3a: 'COLON',
      0x3f: 'QMARK'
    };
    const kind = single[c];
    if (kind) {
      tokens.push({ kind, text: String.fromCharCode(c), value: String.fromCharCode(c), loc: loc(i, 1) });
      i++;
      continue;
    }

    // Unknown character: emit UNKNOWN token, advance one
    tokens.push({
      kind: 'UNKNOWN',
      text: String.fromCharCode(c),
      value: String.fromCharCode(c),
      loc: loc(i, 1)
    });
    i++;
  }

  tokens.push({ kind: 'EOF', text: '', value: '', loc: loc(len, 0) });
  return tokens;
}
