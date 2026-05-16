/**
 * Sigma YAML → SigmaRule[].
 *
 * `parseSigma()` is permissive: anything we don't understand becomes a
 * diagnostic rather than an exception, so a folder of mixed Sigma rules
 * loads cleanly even when a few are out-of-scope.
 */

import * as yaml from 'js-yaml';
import type { SigmaRule, SigmaSelection, SigmaField, SigmaModifier } from './types.js';

const KNOWN_MODIFIERS: SigmaModifier[] = ['contains', 'startswith', 'endswith', 're', 'all', 'i'];

export interface ParseSigmaResult {
  rules: SigmaRule[];
  diagnostics: { file?: string; message: string; severity: 'error' | 'warning' | 'info' }[];
}

export function parseSigma(file: { path: string; content: string }): ParseSigmaResult {
  const diagnostics: ParseSigmaResult['diagnostics'] = [];
  let parsed: unknown;
  try {
    parsed = yaml.load(file.content);
  } catch (e) {
    return {
      rules: [],
      diagnostics: [
        { file: file.path, severity: 'error', message: `YAML parse failed: ${(e as Error).message}` }
      ]
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      rules: [],
      diagnostics: [{ file: file.path, severity: 'error', message: 'Empty or non-object YAML' }]
    };
  }

  // The YAML can be a single rule OR multi-document with collection rules
  // — community feeds use both. Normalize to an array.
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  const rules: SigmaRule[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const obj = doc as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title : '';
    if (!title) {
      diagnostics.push({
        file: file.path,
        severity: 'warning',
        message: 'Sigma document missing `title` — skipped'
      });
      continue;
    }
    const detection = obj.detection;
    if (!detection || typeof detection !== 'object') {
      diagnostics.push({
        file: file.path,
        severity: 'warning',
        message: `Rule "${title}" has no \`detection\` block — skipped`
      });
      continue;
    }
    const detObj = detection as Record<string, unknown>;
    const condition = typeof detObj.condition === 'string' ? detObj.condition : 'selection';
    const selections: SigmaSelection[] = [];
    for (const [name, value] of Object.entries(detObj)) {
      if (name === 'condition' || name === 'timeframe') continue;
      const fields = collectFields(value);
      if (fields !== null) selections.push({ name, fields });
    }
    const logsourceRaw = (obj.logsource ?? {}) as Record<string, unknown>;
    rules.push({
      id: typeof obj.id === 'string' ? obj.id : undefined,
      title,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      logsource: {
        product: scalarString(logsourceRaw.product),
        service: scalarString(logsourceRaw.service),
        category: scalarString(logsourceRaw.category)
      },
      selections,
      condition,
      level: scalarString(obj.level),
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === 'string') : undefined,
      source: { file: file.path }
    });
  }
  return { rules, diagnostics };
}

function scalarString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * A selection value can be:
 *   - a map (field/value pairs, AND-joined)
 *   - a list of maps (each map AND-joined, lists OR-joined) — rare but
 *     used by some rules; we flatten conservatively
 *   - a scalar (very rare; treated as a single value-only field named `_`)
 *
 * Returns null when the value isn't a recognized shape so the caller can
 * skip the selection rather than panic.
 */
function collectFields(value: unknown): SigmaField[] | null {
  if (!value || (typeof value !== 'object' && !Array.isArray(value))) {
    return null;
  }
  const fields: SigmaField[] = [];
  const maps = Array.isArray(value)
    ? (value as Record<string, unknown>[])
    : [value as Record<string, unknown>];
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const [rawKey, rawVal] of Object.entries(map)) {
      const parts = rawKey.split('|');
      const name = parts[0];
      const modifiers: SigmaModifier[] = [];
      for (const part of parts.slice(1)) {
        if (KNOWN_MODIFIERS.includes(part as SigmaModifier)) {
          modifiers.push(part as SigmaModifier);
        }
      }
      const values = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v))
        : rawVal === null || rawVal === undefined
          ? []
          : [String(rawVal)];
      fields.push({ name, modifiers, values });
    }
  }
  return fields;
}
