/**
 * RFC 3164 (legacy BSD) and RFC 5424 (modern) syslog message parser.
 *
 * Decodes the wire-format bytes a syslog sender would put on the network
 * into the field-set the simulator uses (`fromhost`, `hostname`,
 * `programname`, `syslogtag`, `msg`, plus PRI-derived facility/severity
 * and any RFC 5424 structured-data blocks).
 *
 * This is the same job rsyslog's parser modules ("pmrfc3164", "pmrfc5424")
 * do internally — implemented here as a pure function so users can paste a
 * raw line and have the simulator pre-populate the form for them.
 *
 * The parser is permissive: malformed input never throws. Anything it
 * cannot decode is left blank on the result, with the original `rawmsg`
 * always preserved.
 */

export interface ParsedRawMessage {
  /** Which RFC the parser matched. "unknown" means heuristic fallback. */
  format: 'rfc3164' | 'rfc5424' | 'unknown';
  /** Original wire bytes, unchanged. */
  rawmsg: string;

  /** Combined PRI value (facility*8 + severity), if present. */
  pri?: number;
  facility?: number;
  severity?: number;

  /** RFC 5424 VERSION (always 1 today). */
  version?: number;

  /** Timestamp as parsed; format-dependent (no year in 3164). */
  timestamp?: string;

  hostname?: string;

  /** RFC 5424 calls this APP-NAME; we expose it as programname for parity. */
  programname?: string;

  /** Process ID inside [brackets] in 3164; explicit field in 5424. */
  procid?: string;

  /** RFC 5424 MSGID. */
  msgid?: string;

  /** Full "TAG[PID]:" reconstruction (matches rsyslog's $syslogtag). */
  syslogtag?: string;

  /** Decoded application message body. */
  msg?: string;

  /**
   * RFC 5424 structured data, flattened into key→value pairs.
   * Keys are formatted as `<sd-id>_<param>` for collision safety
   * (mirrors rsyslog's "$!" structured-data property naming).
   */
  structured?: Record<string, string>;

  /** Diagnostic strings collected during parsing — never thrown. */
  notes: string[];
}

const RFC5424_HEAD = /^<(\d{1,3})>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/s;
const RFC3164_HEAD = /^<(\d{1,3})>([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s:[]+)(?:\[(\d+)\])?:\s?(.*)$/s;
const RFC3164_NOTAG = /^<(\d{1,3})>([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/s;

export function parseRawMessage(rawmsg: string): ParsedRawMessage {
  const out: ParsedRawMessage = { format: 'unknown', rawmsg, notes: [] };
  if (!rawmsg) return out;

  // RFC 5424: `<PRI>1 TS HOST APP PROCID MSGID [SD] MSG`
  const m5 = RFC5424_HEAD.exec(rawmsg);
  if (m5 && m5[2] === '1') {
    out.format = 'rfc5424';
    fillPri(out, m5[1]);
    out.version = 1;
    out.timestamp = nilOrValue(m5[3]);
    out.hostname = nilOrValue(m5[4]);
    out.programname = nilOrValue(m5[5]);
    out.procid = nilOrValue(m5[6]);
    out.msgid = nilOrValue(m5[7]);
    const rest = m5[8] ?? '';
    const { sd, msg } = splitStructuredAndMsg(rest);
    if (sd) out.structured = sd;
    if (msg !== undefined) out.msg = stripBom(msg);
    out.syslogtag = composeTag(out.programname, out.procid);
    return out;
  }

  // RFC 3164 with explicit TAG[PID]:
  const m3 = RFC3164_HEAD.exec(rawmsg);
  if (m3) {
    out.format = 'rfc3164';
    fillPri(out, m3[1]);
    out.timestamp = m3[2];
    out.hostname = m3[3];
    out.programname = m3[4];
    if (m3[5]) out.procid = m3[5];
    out.msg = m3[6] ?? '';
    out.syslogtag = composeTag(out.programname, out.procid);
    return out;
  }

  // RFC 3164 without a TAG — fall back to "everything after hostname is msg".
  const m3b = RFC3164_NOTAG.exec(rawmsg);
  if (m3b) {
    out.format = 'rfc3164';
    fillPri(out, m3b[1]);
    out.timestamp = m3b[2];
    out.hostname = m3b[3];
    out.msg = m3b[4] ?? '';
    return out;
  }

  // Last resort: only the PRI is recognizable, treat the rest as msg.
  const mp = /^<(\d{1,3})>(.*)$/s.exec(rawmsg);
  if (mp) {
    fillPri(out, mp[1]);
    out.msg = mp[2] ?? '';
    out.notes.push('Only PRI recognized; remaining content treated as msg');
    return out;
  }

  // No recognizable framing — message is the whole input.
  out.msg = rawmsg;
  out.notes.push('No <PRI> prefix; treating entire input as msg');
  return out;
}

function fillPri(out: ParsedRawMessage, raw: string): void {
  const pri = parseInt(raw, 10);
  if (Number.isNaN(pri)) return;
  out.pri = pri;
  out.facility = pri >> 3;
  out.severity = pri & 0x07;
}

function nilOrValue(token: string | undefined): string | undefined {
  if (!token || token === '-') return undefined;
  return token;
}

function composeTag(prog?: string, pid?: string): string | undefined {
  if (!prog) return undefined;
  return pid ? `${prog}[${pid}]:` : `${prog}:`;
}

function stripBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

/**
 * Split a 5424 message-tail into structured-data blocks and the body. SD
 * is "[sd-id k=\"v\" k=\"v\"]" — possibly multiple in sequence — or "-".
 * The body follows, separated by a single space.
 */
function splitStructuredAndMsg(tail: string): { sd?: Record<string, string>; msg?: string } {
  if (!tail) return {};
  // NILVALUE for structured data
  if (tail.startsWith('- ')) return { msg: tail.slice(2) };
  if (tail === '-') return { msg: '' };
  if (!tail.startsWith('[')) return { msg: tail };

  const sd: Record<string, string> = {};
  let i = 0;
  while (i < tail.length && tail[i] === '[') {
    const end = findSdEnd(tail, i);
    if (end === -1) break;
    parseSdBlock(tail.slice(i + 1, end), sd);
    i = end + 1;
  }
  const body = tail.slice(i).replace(/^\s+/, '');
  return { sd: Object.keys(sd).length ? sd : undefined, msg: body };
}

function findSdEnd(s: string, start: number): number {
  // Walks forward respecting quoted values that may contain `]`.
  let i = start + 1;
  let inQuote = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ']' && !inQuote) return i;
    i++;
  }
  return -1;
}

function parseSdBlock(body: string, into: Record<string, string>): void {
  // First token: sd-id (no `=`)
  const idEnd = body.search(/\s/);
  if (idEnd === -1) return;
  const sdId = body.slice(0, idEnd);
  let rest = body.slice(idEnd).trimStart();

  // Then zero-or-more KEY="VALUE" pairs.
  const pairRe = /([A-Za-z0-9._-]+)="((?:\\.|[^"\\])*)"\s*/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(rest)) !== null) {
    const key = `${sdId}_${m[1]}`;
    into[key] = m[2].replace(/\\(["\\\]])/g, '$1');
  }
}
