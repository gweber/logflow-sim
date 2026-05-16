export interface SyslogMessage {
  transport: 'udp' | 'tcp';
  port: number;
  fromhost?: string;
  fromhostIp?: string;
  hostname?: string;
  programname?: string;
  syslogtag?: string;
  rawmsg?: string;
  msg?: string;
  inputname?: string;
  /** Optional pre-parsed structured data ($!field) at message entry. */
  structured?: Record<string, string>;
  /** Simulation time in ms-since-epoch. Defaults to Date.now(). */
  simTime?: number;
  /**
   * Value for $MYHOSTNAME. The core has no notion of the host's hostname —
   * callers (NodeVFS-backed server, browser UI) inject it. Empty string if
   * unset.
   */
  myhostname?: string;
}

const FACILITIES = [
  'kern','user','mail','daemon','auth','syslog','lpr','news',
  'uucp','cron','authpriv','ftp','ntp','security','console','solaris-cron',
  'local0','local1','local2','local3','local4','local5','local6','local7'
];
const SEVERITIES = ['emerg','alert','crit','err','warning','notice','info','debug'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function rfc3339(d: Date): string {
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const tzh = pad2(Math.floor(Math.abs(tz) / 60));
  const tzm = pad2(Math.abs(tz) % 60);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${tzh}:${tzm}`
  );
}

function parsePriFromRaw(rawmsg: string): { pri?: number; rest: string } {
  const m = /^<(\d{1,3})>(.*)$/s.exec(rawmsg);
  if (!m) return { rest: rawmsg };
  const pri = parseInt(m[1], 10);
  if (Number.isNaN(pri)) return { rest: rawmsg };
  return { pri, rest: m[2] };
}

export function makePropertyMap(m: SyslogMessage): Record<string, string> {
  const rawmsg = m.rawmsg ?? m.msg ?? '';
  const { pri } = parsePriFromRaw(rawmsg);

  const facilityNum = pri !== undefined ? pri >> 3 : undefined;
  const severityNum = pri !== undefined ? pri & 0x07 : undefined;

  const simDate = new Date(m.simTime ?? Date.now());
  const tsRfc3339 = rfc3339(simDate);
  // Core does not query the host environment; whoever constructs the message
  // (Node server, browser UI, CLI) injects the value for $MYHOSTNAME.
  const myhost = m.myhostname ?? '';

  return {
    // Core message properties
    fromhost: m.fromhost ?? '',
    'fromhost-ip': m.fromhostIp ?? '',
    hostname: m.hostname ?? m.fromhost ?? '',
    programname: m.programname ?? '',
    syslogtag: m.syslogtag ?? (m.programname ? `${m.programname}:` : ''),
    msg: m.msg ?? '',
    rawmsg,
    inputname: m.inputname ?? `im${m.transport}`,

    // PRI / facility / severity
    pri: pri !== undefined ? String(pri) : '',
    'pri-text':
      facilityNum !== undefined && severityNum !== undefined
        ? `${FACILITIES[facilityNum] ?? 'local0'}.${SEVERITIES[severityNum] ?? 'info'}<${pri}>`
        : '',
    syslogfacility: facilityNum !== undefined ? String(facilityNum) : '',
    'syslogfacility-text': facilityNum !== undefined ? FACILITIES[facilityNum] ?? '' : '',
    syslogseverity: severityNum !== undefined ? String(severityNum) : '',
    'syslogseverity-text': severityNum !== undefined ? SEVERITIES[severityNum] ?? '' : '',
    'syslogpriority-text': severityNum !== undefined ? SEVERITIES[severityNum] ?? '' : '',
    syslogpriority: severityNum !== undefined ? String(severityNum) : '',

    // Timestamp properties — populated from sim time
    timestamp: tsRfc3339,
    timegenerated: tsRfc3339,
    timereported: tsRfc3339,

    // System property variables ($... when used as %$NAME%)
    $year: String(simDate.getFullYear()),
    $month: pad2(simDate.getMonth() + 1),
    $day: pad2(simDate.getDate()),
    $hour: pad2(simDate.getHours()),
    $minute: pad2(simDate.getMinutes()),
    $second: pad2(simDate.getSeconds()),
    $now: `${simDate.getFullYear()}-${pad2(simDate.getMonth() + 1)}-${pad2(simDate.getDate())}`,
    $now_utc: `${simDate.getUTCFullYear()}-${pad2(simDate.getUTCMonth() + 1)}-${pad2(simDate.getUTCDate())}`,
    $myhostname: myhost,
    $bom: '﻿'
  };
}

