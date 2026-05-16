/**
 * rsyslog property-modifier handling shared between templates (`%prop:mod%`)
 * and expressions (`if $prop:mod == "x"`).
 *
 * The modifier grammar is:
 *
 *   :::lowercase                          chain-style global modifier
 *   :A or :A,B                            substring (1-indexed, inclusive end)
 *   :R,ERE,N,FIELD:pattern--end           regex extract with on-error policy
 *
 * Multiple modifiers may chain. Anything we do not recognize is left
 * verbatim — silent corruption is worse than a no-op.
 */

import type { ScalarValue } from './expressions.js';

export interface Splitted {
  base: string;
  modifiers: string[];
}

/**
 * Split a property reference (with or without leading `$`/`$.`/`$!`/`!`)
 * into its base name and the ordered list of modifier tokens.
 *
 * Examples:
 *   "msg:1,5"                    → { base: "msg", modifiers: ["1,5"] }
 *   "msg:::lowercase"            → { base: "msg", modifiers: [":::lowercase"] }
 *   "msg:R,ERE,1,FIELD:foo--end" → { base: "msg", modifiers: ["R,ERE,1,FIELD:foo--end"] }
 *   "$!a.b.c"                    → { base: "$!a.b.c", modifiers: [] }
 */
export function splitProperty(raw: string): Splitted {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  // The first `:` separates base from first modifier — but inside a structured
  // reference like `$!a.b.c` the dots aren't separators, and `:` always is.
  while (i < raw.length && raw[i] !== ':') {
    buf += raw[i];
    i++;
  }
  const base = buf;
  buf = '';
  while (i < raw.length) {
    if (raw[i] === ':') {
      // Triple-colon prefix: `:::name`.
      if (raw[i + 1] === ':' && raw[i + 2] === ':') {
        if (buf) {
          out.push(buf);
          buf = '';
        }
        let j = i + 3;
        while (j < raw.length && raw[j] !== ':') j++;
        out.push(':::' + raw.slice(i + 3, j));
        i = j;
        continue;
      }
      // Regex extract: `R,...` consumes to end of string.
      if (raw.slice(i + 1, i + 3).toUpperCase() === 'R,') {
        if (buf) {
          out.push(buf);
          buf = '';
        }
        out.push(raw.slice(i + 1));
        i = raw.length;
        continue;
      }
      if (buf) {
        out.push(buf);
        buf = '';
      }
      i++;
      continue;
    }
    buf += raw[i];
    i++;
  }
  if (buf) out.push(buf);
  return { base, modifiers: out };
}

export function applyModifierChain(value: string, modifiers: string[]): string {
  let v = value;
  for (const m of modifiers) v = applyModifier(v, m);
  return v;
}

function applyModifier(value: string, mod: string): string {
  const trimmed = mod.trim();

  if (trimmed.startsWith(':::')) {
    const name = trimmed.slice(3).toLowerCase();
    switch (name) {
      case 'lowercase':
        return value.toLowerCase();
      case 'uppercase':
        return value.toUpperCase();
      case 'json':
        return JSON.stringify(value).slice(1, -1);
      case 'jsonf':
        return JSON.stringify(value);
      case 'escape-cc':
        return value.replace(/[\x00-\x1f]/g, (c) => `#${c.charCodeAt(0).toString(16)}`);
      case 'space-cc':
        return value.replace(/[\x00-\x1f]/g, ' ');
      case 'date-rfc3339':
      case 'date-rfc3164':
        return value;
      case 'date-unixtimestamp': {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return value;
        return String(Math.floor(d.getTime() / 1000));
      }
      case 'date-year':
        return dateField(value, (d) => String(d.getFullYear())) ?? value;
      case 'date-month':
        return dateField(value, (d) => pad2(d.getMonth() + 1)) ?? value;
      case 'date-day':
        return dateField(value, (d) => pad2(d.getDate())) ?? value;
      case 'date-hour':
        return dateField(value, (d) => pad2(d.getHours())) ?? value;
      default:
        return value;
    }
  }

  if (/^R,/i.test(trimmed)) return applyRegexExtract(value, trimmed);

  // Substring "A" or "A,B" — both forms are accepted, as is a `$` for
  // "from A to end-of-string".
  const numMatch = /^(\d+)(?:,(\d+|\$))?$/.exec(trimmed);
  if (numMatch) {
    const from = parseInt(numMatch[1], 10);
    if (!numMatch[2]) return value.slice(from - 1);
    if (numMatch[2] === '$') return value.slice(from - 1);
    const to = parseInt(numMatch[2], 10);
    return value.slice(from - 1, to);
  }

  return value;
}

function applyRegexExtract(value: string, mod: string): string {
  let body = mod.replace(/^R,/i, '');
  body = body.replace(/--end\s*$/i, '');
  const m = /^([A-Z]+),(\d+),([A-Z]+):(.*)$/i.exec(body);
  if (!m) return '';
  const submatch = parseInt(m[2], 10);
  const onerror = m[3].toUpperCase();
  const pattern = m[4];
  try {
    const re = new RegExp(pattern);
    const found = re.exec(value);
    if (!found) return onerrorValue(onerror);
    if (submatch < found.length) return found[submatch] ?? '';
    return onerrorValue(onerror);
  } catch {
    return onerrorValue(onerror);
  }
}

function onerrorValue(token: string): string {
  switch (token.toUpperCase()) {
    case 'DFLT':
      return '**NO MATCH**';
    case 'ZERO':
      return '0';
    case 'BLANK':
    case 'FIELD':
    default:
      return '';
  }
}

function dateField(value: string, fn: (d: Date) => string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return fn(d);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Convenience: coerce a ScalarValue to string and apply modifiers.
 */
export function applyToScalar(value: ScalarValue, modifiers: string[]): string {
  const s = Array.isArray(value) ? value.join(',') : String(value);
  return applyModifierChain(s, modifiers);
}
