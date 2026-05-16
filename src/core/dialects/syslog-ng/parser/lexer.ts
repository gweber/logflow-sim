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
  | 'SEMI'
  | 'COLON'
  | 'COMMA'
  | 'DOT'
  | 'DASH'
  | 'AT' // @ pragma prefix
  | 'NEWLINE'
  | 'UNKNOWN'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  text: string;
  value: string;
  loc: SourceLoc;
}

const KEYWORDS = new Set([
  'source',
  'destination',
  'filter',
  'log',
  'options',
  'template',
  'parser',
  'rewrite',
  'block',
  'junction',
  'channel',
  'and',
  'or',
  'not',
  'yes',
  'no'
]);

export function tokenize(file: string, content: string): Token[] {
  const tokens: Token[] = [];
  const len = content.length;
  let i = 0;

  function loc(offset: number, length: number): SourceLoc {
    const { line, col } = offsetToLineCol(content, offset);
    return { file, line, col, offset, length };
  }
  const isIdentStart = (c: number) =>
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
  const isIdentCont = (c: number) =>
    isIdentStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d /* - */;

  while (i < len) {
    const c = content.charCodeAt(i);
    const start = i;

    // Whitespace + line continuation
    if (c === 0x20 || c === 0x09 || c === 0x0d) {
      i++;
      continue;
    }
    if (c === 0x5c /* \ */ && content.charCodeAt(i + 1) === 0x0a) {
      i += 2;
      continue;
    }
    if (c === 0x0a) {
      tokens.push({ kind: 'NEWLINE', text: '\n', value: '\n', loc: loc(start, 1) });
      i++;
      continue;
    }
    // Comments
    if (c === 0x23 /* # */) {
      while (i < len && content.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    if (c === 0x2f && content.charCodeAt(i + 1) === 0x2a) {
      let j = i + 2;
      while (j < len - 1 && !(content.charCodeAt(j) === 0x2a && content.charCodeAt(j + 1) === 0x2f)) j++;
      i = Math.min(len, j + 2);
      continue;
    }
    if (c === 0x2f && content.charCodeAt(i + 1) === 0x2f) {
      while (i < len && content.charCodeAt(i) !== 0x0a) i++;
      continue;
    }

    // String literals
    if (c === 0x22 /* " */ || c === 0x27 /* ' */) {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < len) {
        const cc = content.charCodeAt(j);
        if (cc === 0x5c && j + 1 < len) {
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
        if (cc === 0x0a) break;
        value += String.fromCharCode(cc);
        j++;
      }
      tokens.push({ kind: 'STRING', text: content.slice(i, j), value, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // Backquoted strings — `command` interpolation, treated as opaque.
    if (c === 0x60 /* ` */) {
      let j = i + 1;
      while (j < len && content.charCodeAt(j) !== 0x60 && content.charCodeAt(j) !== 0x0a) j++;
      const value = content.slice(i + 1, j);
      if (j < len && content.charCodeAt(j) === 0x60) j++;
      tokens.push({ kind: 'STRING', text: content.slice(i, j), value, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // Number — allow CIDR-like 10.0.0.0/8 as a single token by reading
    // through dots and slashes when the run starts with a digit.
    if (c >= 0x30 && c <= 0x39) {
      let j = i + 1;
      while (
        j < len &&
        ((content.charCodeAt(j) >= 0x30 && content.charCodeAt(j) <= 0x39) ||
          content.charCodeAt(j) === 0x2e ||
          content.charCodeAt(j) === 0x2f)
      ) j++;
      const text = content.slice(i, j);
      tokens.push({ kind: 'NUMBER', text, value: text, loc: loc(i, j - i) });
      i = j;
      continue;
    }

    // @pragma (version/include/define)
    if (c === 0x40 /* @ */) {
      tokens.push({ kind: 'AT', text: '@', value: '@', loc: loc(i, 1) });
      i++;
      continue;
    }

    // Identifier / keyword (allow `-` in the middle; common in driver names like `unix-dgram`)
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentCont(content.charCodeAt(j))) j++;
      const text = content.slice(i, j);
      const lower = text.toLowerCase();
      tokens.push({
        kind: KEYWORDS.has(lower) ? 'KEYWORD' : 'IDENT',
        text,
        value: lower,
        loc: loc(i, j - i)
      });
      i = j;
      continue;
    }

    const single: Record<number, TokenKind> = {
      0x28: 'LPAREN',
      0x29: 'RPAREN',
      0x7b: 'LBRACE',
      0x7d: 'RBRACE',
      0x3b: 'SEMI',
      0x3a: 'COLON',
      0x2c: 'COMMA',
      0x2e: 'DOT',
      0x2d: 'DASH'
    };
    const k = single[c];
    if (k) {
      tokens.push({
        kind: k,
        text: String.fromCharCode(c),
        value: String.fromCharCode(c),
        loc: loc(i, 1)
      });
      i++;
      continue;
    }

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
