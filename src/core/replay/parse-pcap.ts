/**
 * Pcap parser for syslog replay. Accepts both wire formats:
 *
 *   • libpcap "classic" — magic 0xa1b2c3d4 / 0xd4c3b2a1, simple per-packet
 *     records after a 24-byte global header.
 *   • pcapng — section-header + interface-description + enhanced-packet
 *     blocks. Wireshark and tshark emit this by default since v3.
 *
 * Both formats funnel through the same link-layer → IPv4 → UDP/TCP path.
 *
 * TCP syslog is reassembled per (src,dst) flow with octet-counted framing
 * (RFC 6587 §3.4.1) and non-transparent newline framing (RFC 6587 §3.4.2),
 * the two real-world wire formats. The reassembler is best-effort: dropped
 * segments produce diagnostics, not exceptions.
 *
 * Link layers handled: Ethernet (1), LINUX_SLL (113), Raw IPv4 (12/101).
 * Address family: IPv4 only — IPv6 is rare for syslog and adds extraction
 * complexity without unblocking real users today.
 */

export interface PcapPacket {
  /** 1-based packet index within the pcap. */
  index: number;
  /** Capture timestamp, ms since epoch. */
  timestampMs: number;
  /** UDP source IP, dotted quad. */
  srcIp: string;
  /** UDP destination port. */
  dstPort: number;
  /** Raw UDP payload as UTF-8 string. */
  payload: string;
}

export interface PcapParseResult {
  packets: PcapPacket[];
  diagnostics: string[];
}

const MAGIC_LE = 0xa1b2c3d4;
const MAGIC_BE = 0xd4c3b2a1;
const PCAPNG_BLOCK_SHB = 0x0a0d0d0a;
const PCAPNG_BYTE_ORDER_MAGIC = 0x1a2b3c4d;
const PCAPNG_BLOCK_IDB = 1;
const PCAPNG_BLOCK_EPB = 6;
const PCAPNG_BLOCK_SPB = 3; // simple packet block (rare but cheap to support)

const LINKTYPE_ETHERNET = 1;
const LINKTYPE_RAW = 12;
const LINKTYPE_RAW_BSD = 101;
const LINKTYPE_LINUX_SLL = 113;

export function parsePcap(buf: Uint8Array): PcapParseResult {
  if (buf.length < 8) {
    return { packets: [], diagnostics: ['pcap too short'] };
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const first = dv.getUint32(0, true);
  if (first === PCAPNG_BLOCK_SHB) return parsePcapng(buf, dv);
  if (first === MAGIC_LE) return parsePcapClassic(buf, dv, true);
  if (first === MAGIC_BE) return parsePcapClassic(buf, dv, false);
  return { packets: [], diagnostics: [`unknown pcap magic 0x${first.toString(16)}`] };
}

function parsePcapClassic(
  buf: Uint8Array,
  dv: DataView,
  littleEndian: boolean
): PcapParseResult {
  const diagnostics: string[] = [];
  const ctx = new ExtractContext();
  if (buf.length < 24) return { packets: [], diagnostics: ['pcap classic header truncated'] };
  const linkType = dv.getUint32(20, littleEndian);
  let off = 24;
  let idx = 0;
  while (off + 16 <= buf.length) {
    const tsSec = dv.getUint32(off, littleEndian);
    const tsUsec = dv.getUint32(off + 4, littleEndian);
    const inclLen = dv.getUint32(off + 8, littleEndian);
    off += 16;
    if (inclLen === 0 || off + inclLen > buf.length) {
      diagnostics.push(`record ${idx + 1} truncated (incl_len=${inclLen})`);
      break;
    }
    idx++;
    extractFrame(
      ctx,
      buf.subarray(off, off + inclLen),
      linkType,
      idx,
      tsSec * 1000 + Math.floor(tsUsec / 1000),
      diagnostics
    );
    off += inclLen;
  }
  ctx.flushPendingTcp();
  diagnostics.push(...ctx.diagnostics);
  return { packets: ctx.packets, diagnostics };
}

function parsePcapng(buf: Uint8Array, dv: DataView): PcapParseResult {
  const diagnostics: string[] = [];
  const ctx = new ExtractContext();
  // Section may repeat; interface link-types are tracked per section in
  // the order IDBs appear (the spec calls this the "interface_id" index).
  let off = 0;
  let interfaces: number[] = [];
  let littleEndian = true;
  let idx = 0;

  while (off + 8 <= buf.length) {
    const blockType = dv.getUint32(off, littleEndian);
    const blockLen = dv.getUint32(off + 4, littleEndian);
    if (blockLen < 12 || off + blockLen > buf.length) {
      diagnostics.push(`pcapng: truncated block at offset ${off} (len=${blockLen})`);
      break;
    }
    const body = buf.subarray(off + 8, off + blockLen - 4);
    if (blockType === PCAPNG_BLOCK_SHB) {
      // Re-detect byte order from byte_order_magic; reset interfaces for
      // the new section.
      if (body.length < 16) {
        diagnostics.push('pcapng: SHB body too short');
        break;
      }
      const bom = dv.getUint32(off + 8, true);
      littleEndian = bom === PCAPNG_BYTE_ORDER_MAGIC;
      interfaces = [];
    } else if (blockType === PCAPNG_BLOCK_IDB) {
      if (body.length >= 4) {
        const linkType = readU16(body, 0, littleEndian);
        interfaces.push(linkType);
      }
    } else if (blockType === PCAPNG_BLOCK_EPB) {
      if (body.length < 20) {
        diagnostics.push(`pcapng: EPB body short at offset ${off}`);
      } else {
        const ifId = readU32(body, 0, littleEndian);
        const tsHigh = readU32(body, 4, littleEndian);
        const tsLow = readU32(body, 8, littleEndian);
        const captured = readU32(body, 12, littleEndian);
        if (20 + captured <= body.length && captured > 0) {
          const linkType = interfaces[ifId] ?? LINKTYPE_ETHERNET;
          // pcapng timestamps default to microsecond resolution unless an
          // IDB tsresol option overrides; we treat them as microseconds.
          const tsUs = tsHigh * 0x100000000 + tsLow;
          idx++;
          extractFrame(
            ctx,
            body.subarray(20, 20 + captured),
            linkType,
            idx,
            Math.floor(tsUs / 1000),
            diagnostics
          );
        }
      }
    } else if (blockType === PCAPNG_BLOCK_SPB) {
      if (body.length >= 4) {
        const origLen = readU32(body, 0, littleEndian);
        const captured = Math.min(origLen, body.length - 4);
        if (captured > 0) {
          const linkType = interfaces[0] ?? LINKTYPE_ETHERNET;
          idx++;
          extractFrame(ctx, body.subarray(4, 4 + captured), linkType, idx, 0, diagnostics);
        }
      }
    }
    // Other block types (Name Resolution, Interface Statistics, etc.) are
    // intentionally ignored — they carry metadata, not packets.
    off += blockLen;
  }
  ctx.flushPendingTcp();
  diagnostics.push(...ctx.diagnostics);
  return { packets: ctx.packets, diagnostics };
}

function readU32(b: Uint8Array, off: number, le: boolean): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return dv.getUint32(off, le);
}
function readU16(b: Uint8Array, off: number, le: boolean): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return dv.getUint16(off, le);
}

function extractFrame(
  ctx: ExtractContext,
  frame: Uint8Array,
  linkType: number,
  idx: number,
  timestampMs: number,
  diagnostics: string[]
): void {
  const ip = stripLinkLayer(frame, linkType, diagnostics, idx);
  if (!ip) return;
  if (ip.length < 20 || ip[0] >> 4 !== 4) return;
  const proto = ip[9];
  if (proto === 17) {
    const udp = parseIpv4Udp(ip, diagnostics, idx);
    if (udp) {
      ctx.packets.push({
        index: idx,
        timestampMs,
        srcIp: udp.srcIp,
        dstPort: udp.dstPort,
        payload: bytesToString(udp.payload)
      });
    }
  } else if (proto === 6) {
    parseIpv4Tcp(ip, ctx, idx, timestampMs, diagnostics);
  }
  // Other protocols (ICMP, GRE, etc.) are ignored — they don't carry syslog.
}

function stripLinkLayer(
  frame: Uint8Array,
  linkType: number,
  diags: string[],
  idx: number
): Uint8Array | null {
  if (linkType === LINKTYPE_ETHERNET) {
    if (frame.length < 14) return null;
    // VLAN tag 0x8100 → +4 bytes; chase one level deep
    let etherType = (frame[12] << 8) | frame[13];
    let l3 = 14;
    if (etherType === 0x8100 && frame.length >= 18) {
      etherType = (frame[16] << 8) | frame[17];
      l3 = 18;
    }
    if (etherType !== 0x0800) return null; // IPv4 only
    return frame.subarray(l3);
  }
  if (linkType === LINKTYPE_RAW || linkType === LINKTYPE_RAW_BSD) {
    return frame;
  }
  if (linkType === LINKTYPE_LINUX_SLL) {
    // 16-byte SLL header: pkttype(2) hatype(2) halen(2) addr(8) protocol(2)
    if (frame.length < 16) return null;
    const proto = (frame[14] << 8) | frame[15];
    if (proto !== 0x0800) return null;
    return frame.subarray(16);
  }
  diags.push(`packet ${idx}: unsupported link-type ${linkType}`);
  return null;
}

function parseIpv4Udp(
  ip: Uint8Array,
  diags: string[],
  idx: number
): { srcIp: string; dstPort: number; payload: Uint8Array } | null {
  if (ip.length < 20) return null;
  const vihl = ip[0];
  if (vihl >> 4 !== 4) return null;
  const ihl = (vihl & 0x0f) * 4;
  if (ihl < 20 || ihl > ip.length) return null;
  const proto = ip[9];
  if (proto !== 17) return null; // UDP only
  const totalLen = (ip[2] << 8) | ip[3];
  const ipEnd = Math.min(totalLen, ip.length);
  const srcIp = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
  const udp = ip.subarray(ihl, ipEnd);
  if (udp.length < 8) {
    diags.push(`packet ${idx}: UDP header truncated`);
    return null;
  }
  const dstPort = (udp[2] << 8) | udp[3];
  const udpLen = (udp[4] << 8) | udp[5];
  const payloadEnd = Math.min(udpLen, udp.length);
  return { srcIp, dstPort, payload: udp.subarray(8, payloadEnd) };
}

/**
 * TCP flow-state for syslog reassembly.
 *
 * Real-world TCP-syslog uses two framing modes:
 *   1. Octet-counted (RFC 6587 §3.4.1): "LEN BYTES" — the payload is prefixed
 *      with a decimal length and a space.
 *   2. Non-transparent (RFC 6587 §3.4.2): newline-terminated messages.
 *
 * We auto-detect on a per-message basis: a leading run of digits followed
 * by a space picks octet-counted, anything else falls back to newline-split.
 * This handles intermixed-style senders that aren't strict about either.
 */
class TcpFlow {
  buf = '';
  lastTsMs = 0;
  srcIp = '';
  dstPort = 0;
}

class ExtractContext {
  packets: PcapPacket[] = [];
  diagnostics: string[] = [];
  flows = new Map<string, TcpFlow>();
  flowCounter = 0;

  /** Drain any buffered TCP data as best-effort messages once the file ends. */
  flushPendingTcp(): void {
    for (const flow of this.flows.values()) {
      this.drainFlow(flow);
    }
  }

  drainFlow(flow: TcpFlow): void {
    while (flow.buf.length > 0) {
      const next = nextFramedMessage(flow);
      if (!next) break;
      if (next.payload.length > 0) {
        this.packets.push({
          index: ++this.flowCounter,
          timestampMs: flow.lastTsMs,
          srcIp: flow.srcIp,
          dstPort: flow.dstPort,
          payload: next.payload
        });
      }
    }
  }
}

function parseIpv4Tcp(
  ip: Uint8Array,
  ctx: ExtractContext,
  _idx: number,
  timestampMs: number,
  diags: string[]
): void {
  if (ip.length < 20) return;
  const ihl = (ip[0] & 0x0f) * 4;
  if (ihl < 20 || ihl > ip.length) return;
  const totalLen = (ip[2] << 8) | ip[3];
  const ipEnd = Math.min(totalLen, ip.length);
  const srcIp = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
  const dstIp = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
  const tcp = ip.subarray(ihl, ipEnd);
  if (tcp.length < 20) return;
  const srcPort = (tcp[0] << 8) | tcp[1];
  const dstPort = (tcp[2] << 8) | tcp[3];
  if (dstPort !== 514 && dstPort !== 6514 && dstPort !== 601) return;
  const dataOff = (tcp[12] >> 4) * 4;
  if (dataOff < 20 || dataOff > tcp.length) return;
  const payload = tcp.subarray(dataOff);
  if (payload.length === 0) return;

  const flowKey = `${srcIp}:${srcPort}->${dstIp}:${dstPort}`;
  let flow = ctx.flows.get(flowKey);
  if (!flow) {
    flow = new TcpFlow();
    flow.srcIp = srcIp;
    flow.dstPort = dstPort;
    ctx.flows.set(flowKey, flow);
  }
  flow.lastTsMs = timestampMs;
  flow.buf += bytesToString(payload);

  // Drain whatever complete messages are now framed.
  ctx.drainFlow(flow);
  // Guard against pathological flows that never frame: cap the buffer.
  if (flow.buf.length > 1_000_000) {
    diags.push(`tcp flow ${flowKey} exceeded 1MB without framing — dropping buffer`);
    flow.buf = '';
  }
}

/**
 * Pull the next complete message from a TCP buffer using octet-counted
 * framing if the buffer starts with `<digits> ` (the RFC-6587 §3.4.1
 * shape), otherwise newline-split (§3.4.2). Returns null if the buffer
 * doesn't yet hold a complete message.
 */
function nextFramedMessage(flow: TcpFlow): { payload: string } | null {
  const buf = flow.buf;
  // Octet-counted: "LEN MSG"
  const m = /^(\d+) /.exec(buf);
  if (m) {
    const len = parseInt(m[1], 10);
    const headerLen = m[0].length;
    if (buf.length < headerLen + len) return null;
    const payload = buf.slice(headerLen, headerLen + len);
    flow.buf = buf.slice(headerLen + len);
    return { payload };
  }
  // Non-transparent: split on \n
  const nl = buf.indexOf('\n');
  if (nl === -1) return null;
  const payload = buf.slice(0, nl);
  flow.buf = buf.slice(nl + 1);
  return { payload };
}

function bytesToString(bytes: Uint8Array): string {
  // Permissive UTF-8 decode — replace invalid sequences rather than throw.
  // syslog wire payloads on real networks include the occasional binary
  // garbage; we keep the packet so the engine can count it as an unparsable
  // delivery rather than aborting the whole replay.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
