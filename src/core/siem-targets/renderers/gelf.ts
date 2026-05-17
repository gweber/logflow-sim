/**
 * Graylog GELF 1.1 renderer.
 *
 * GELF (Graylog Extended Log Format) is a structured JSON shape with
 * a small set of mandatory top-level fields and a convention that any
 * additional field name must be prefixed with an underscore.
 *
 * Mandatory fields:
 *   - `version`         "1.1" string literal
 *   - `host`            originating host
 *   - `short_message`   short descriptive text
 *
 * Optional standard fields:
 *   - `timestamp`       UNIX seconds with optional decimal places
 *   - `level`           syslog severity 0..7
 *   - `facility`        syslog facility (string in GELF 1.1)
 *   - `full_message`    longer body
 *
 * Custom fields:
 *   - any other key MUST start with `_` (underscore). Letters, digits,
 *     `_`, `-`, `.` allowed in the rest.
 *
 * Source: https://go2docs.graylog.org/current/getting_in_log_data/gelf_format.html
 */

import type { SIEMTarget } from '../types.js';
import type { LogicalEvent } from './json.js';

/**
 * GELF 1.1 reserved top-level keys. Anything else needs an `_` prefix.
 */
const GELF_RESERVED = new Set([
  'version',
  'host',
  'short_message',
  'full_message',
  'timestamp',
  'level',
  'facility'
]);

/**
 * Render a logical event into a GELF 1.1 message body. Mandatory fields
 * get sensible defaults when the caller didn't supply them — the
 * resulting payload is always a syntactically valid GELF message even
 * if the source event was sparse.
 */
export function renderGELF(target: SIEMTarget, event: LogicalEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { version: '1.1' };
  const unmapped: Record<string, unknown> = {};

  for (const [ocsfPath, value] of Object.entries(event)) {
    const nativePath = target.fieldMap.toNative[ocsfPath];
    const key = nativePath ?? ocsfPath;
    if (GELF_RESERVED.has(key)) {
      out[key] = value;
    } else if (target.passthroughFields?.includes(ocsfPath)) {
      // Passthrough fields still need the underscore prefix in GELF.
      out[ensurePrefix(key)] = value;
    } else if (nativePath) {
      out[ensurePrefix(key)] = value;
    } else {
      unmapped[ocsfPath] = value;
    }
  }

  // Sensible defaults for the mandatory subset.
  if (!('host' in out)) out.host = '_unknown';
  if (!('short_message' in out)) out.short_message = '';

  if (Object.keys(unmapped).length > 0) {
    out._unmapped = JSON.stringify(unmapped);
  }
  return out;
}

function ensurePrefix(key: string): string {
  if (key.startsWith('_')) return key;
  // Replace dots with underscores (GELF allows them but most clients
  // treat dotted custom keys as deep paths; collapsing avoids surprises).
  return '_' + key.replace(/\./g, '_');
}
