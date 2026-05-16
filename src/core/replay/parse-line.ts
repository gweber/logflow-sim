/**
 * Turn a single syslog text line into a SyslogMessage.
 *
 * Two shapes are accepted:
 *
 *   1. Wire form with <PRI>: `<86>Mar 18 15:00:03 host sshd[123]: msg`
 *      — handed straight to the existing parseRawMessage.
 *
 *   2. Post-receive form without <PRI>: `Jun  9 06:06:20 combo sshd: msg`
 *      — typical content of /var/log/messages on a Linux host (e.g. Loghub
 *      Linux dataset). We parse it locally and synthesize a plausible
 *      `rawmsg` for downstream property derivation.
 *
 * Anything else falls back to "treat the whole line as msg" — the replay
 * engine still gets to count it as an unmatched delivery attempt rather
 * than crashing.
 */

import type { SyslogMessage } from '../simulate/syslog-message.js';
import { parseRawMessage } from '../simulate/parse-rawmsg.js';

const POST_RECEIVE_HEAD =
  /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s:[]+)(?:\[(\d+)\])?:\s?(.*)$/s;

// Looser fallback for lines like "Jun  9 06:06:20 host syslogd 1.4.1: restart"
// where the tag contains spaces — captures everything up to the first ": ".
const POST_RECEIVE_HEAD_LOOSE =
  /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s?(.*)$/s;

/** Parse one line. Defaults: transport=udp, port=514. */
export function parseLine(line: string): SyslogMessage | null {
  const trimmed = line.replace(/\r?\n$/, '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('<')) {
    const parsed = parseRawMessage(trimmed);
    return {
      transport: 'udp',
      port: 514,
      fromhost: parsed.hostname,
      hostname: parsed.hostname,
      programname: parsed.programname,
      syslogtag: parsed.syslogtag,
      rawmsg: trimmed,
      msg: parsed.msg,
      structured: parsed.structured
    };
  }

  const m = POST_RECEIVE_HEAD.exec(trimmed);
  if (m) {
    const [, , hostname, programname, procid, msg] = m;
    const tag = procid ? `${programname}[${procid}]:` : `${programname}:`;
    // Synthesize a wire-shaped rawmsg with a default user.notice PRI (13)
    // so downstream %pri%/%syslogfacility% properties still resolve. This
    // is a reasonable default for post-receive logs that have lost the PRI.
    const rawmsg = `<13>${trimmed}`;
    return {
      transport: 'udp',
      port: 514,
      fromhost: hostname,
      hostname,
      programname,
      syslogtag: tag,
      rawmsg,
      msg
    };
  }

  // Looser fallback: same shape but the tag may contain spaces ("syslogd
  // 1.4.1:"). We treat the first whitespace-bounded token as the
  // programname so $programname-keyed routing still has something to chew
  // on, and keep the full tag in $syslogtag.
  const ml = POST_RECEIVE_HEAD_LOOSE.exec(trimmed);
  if (ml) {
    const [, , hostname, tagRaw, msg] = ml;
    const tag = `${tagRaw}:`;
    const programname = tagRaw.split(/\s+/)[0];
    return {
      transport: 'udp',
      port: 514,
      fromhost: hostname,
      hostname,
      programname,
      syslogtag: tag,
      rawmsg: `<13>${trimmed}`,
      msg
    };
  }

  return {
    transport: 'udp',
    port: 514,
    rawmsg: trimmed,
    msg: trimmed
  };
}

/** Parse a multi-line buffer. Empty lines are skipped. */
export function parseLines(text: string): SyslogMessage[] {
  const out: SyslogMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = parseLine(line);
    if (m) out.push(m);
  }
  return out;
}
