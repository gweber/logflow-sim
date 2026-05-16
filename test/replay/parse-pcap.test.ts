import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePcap } from '../../src/core/replay/parse-pcap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures/pcap');

describe('replay/parse-pcap', () => {
  it('parses pcapng (Wireshark default format) with mixed RFC3164/5424 syslog', () => {
    const buf = fs.readFileSync(path.join(FIXTURES, 'syslog_old_new2.pcap'));
    const out = parsePcap(new Uint8Array(buf));
    expect(out.diagnostics).toEqual([]);
    expect(out.packets).toHaveLength(2);
    expect(out.packets[0].payload).toContain('sshd[28785]');
    expect(out.packets[1].payload).toContain('sudo');
    expect(out.packets[0].dstPort).toBe(514);
  });

  it('parses pcapng with a single anonymized RFC3164 message', () => {
    const buf = fs.readFileSync(path.join(FIXTURES, 'syslog-udp2_anon.pcapng'));
    const out = parsePcap(new Uint8Array(buf));
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0].srcIp).toBe('172.22.140.49');
    expect(out.packets[0].payload).toContain('myprog[123]');
  });

  it('extracts UDP syslog payloads from a classic libpcap file', () => {
    // We need a classic libpcap file for this; build a minimal one in-memory.
    const buf = buildMinimalPcap([
      buildEthIpUdp('10.0.0.1', '10.0.0.2', 514, '<86>Mar 18 15:00:03 host sshd[1]: hello\n'),
      buildEthIpUdp('10.0.0.1', '10.0.0.2', 514, '<14>Mar 18 15:00:04 host app: world\n')
    ]);
    const out = parsePcap(buf);
    expect(out.packets).toHaveLength(2);
    expect(out.packets[0].srcIp).toBe('10.0.0.1');
    expect(out.packets[0].dstPort).toBe(514);
    expect(out.packets[0].payload).toContain('sshd[1]');
    expect(out.packets[1].payload).toContain('world');
  });

  it('reassembles TCP syslog with octet-counted framing across segments', () => {
    // Two segments: first carries "26 <34>Oct 11 22:14:1" (cut mid-message),
    // second carries "5 mymachine su: 'su root' failed" (continuation).
    const seg1 = buildEthIpTcp('10.0.0.1', 4096, '10.0.0.2', 514, '26 <34>Oct 11 22:14:1');
    const seg2 = buildEthIpTcp('10.0.0.1', 4096, '10.0.0.2', 514, '5 mymachine su: nope');
    const buf = buildMinimalPcap([seg1, seg2]);
    const out = parsePcap(buf);
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0].payload).toBe('<34>Oct 11 22:14:15 mymach');
    expect(out.packets[0].dstPort).toBe(514);
  });

  it('reassembles TCP syslog with non-transparent (newline) framing', () => {
    const seg1 = buildEthIpTcp('10.0.0.1', 4096, '10.0.0.2', 514, '<34>foo\n<35>b');
    const seg2 = buildEthIpTcp('10.0.0.1', 4096, '10.0.0.2', 514, 'ar\n<36>baz\n');
    const buf = buildMinimalPcap([seg1, seg2]);
    const out = parsePcap(buf);
    expect(out.packets.map((p) => p.payload)).toEqual(['<34>foo', '<35>bar', '<36>baz']);
  });
});

// ---- Test helpers: build minimal classic libpcap byte streams ------------

function buildMinimalPcap(frames: Uint8Array[]): Uint8Array {
  const HDR = 24;
  let size = HDR;
  for (const f of frames) size += 16 + f.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0xa1b2c3d4, true); // magic LE
  dv.setUint16(4, 2, true); // version major
  dv.setUint16(6, 4, true); // version minor
  dv.setInt32(8, 0, true); // thiszone
  dv.setUint32(12, 0, true); // sigfigs
  dv.setUint32(16, 65535, true); // snaplen
  dv.setUint32(20, 1, true); // LINKTYPE_ETHERNET
  let off = HDR;
  let ts = 0;
  for (const f of frames) {
    dv.setUint32(off, ts++, true);
    dv.setUint32(off + 4, 0, true);
    dv.setUint32(off + 8, f.length, true);
    dv.setUint32(off + 12, f.length, true);
    off += 16;
    out.set(f, off);
    off += f.length;
  }
  return out;
}

function buildEthIpTcp(
  srcIp: string,
  srcPort: number,
  dstIp: string,
  dstPort: number,
  payload: string
): Uint8Array {
  const enc = new TextEncoder().encode(payload);
  const tcpHdr = 20;
  const tcpLen = tcpHdr + enc.length;
  const ipLen = 20 + tcpLen;
  const total = 14 + ipLen;
  const buf = new Uint8Array(total);
  buf.set([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0x08, 0x00], 0);
  let i = 14;
  buf[i++] = 0x45;
  buf[i++] = 0;
  buf[i++] = (ipLen >> 8) & 0xff;
  buf[i++] = ipLen & 0xff;
  buf[i++] = 0;
  buf[i++] = 0;
  buf[i++] = 0x40;
  buf[i++] = 0;
  buf[i++] = 64;
  buf[i++] = 6; // TCP
  buf[i++] = 0;
  buf[i++] = 0;
  buf.set(srcIp.split('.').map((n) => parseInt(n, 10)), i);
  i += 4;
  buf.set(dstIp.split('.').map((n) => parseInt(n, 10)), i);
  i += 4;
  // TCP header (no options, dataOffset = 5*4 = 20)
  buf[i++] = (srcPort >> 8) & 0xff;
  buf[i++] = srcPort & 0xff;
  buf[i++] = (dstPort >> 8) & 0xff;
  buf[i++] = dstPort & 0xff;
  // seq, ack — zero is fine for the parser, it doesn't reorder
  for (let k = 0; k < 8; k++) buf[i++] = 0;
  buf[i++] = 5 << 4; // data offset
  buf[i++] = 0x18; // PSH + ACK
  buf[i++] = 0xff;
  buf[i++] = 0xff;
  buf[i++] = 0;
  buf[i++] = 0;
  buf[i++] = 0;
  buf[i++] = 0;
  buf.set(enc, i);
  return buf;
}

function buildEthIpUdp(
  srcIp: string,
  dstIp: string,
  dstPort: number,
  payload: string,
  proto = 17
): Uint8Array {
  const enc = new TextEncoder().encode(payload);
  const udpLen = 8 + enc.length;
  const ipLen = 20 + udpLen;
  const total = 14 + ipLen;
  const buf = new Uint8Array(total);
  // Ethernet: dst, src, ethertype 0x0800
  buf.set([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0x08, 0x00], 0);
  // IPv4 header
  let i = 14;
  buf[i++] = 0x45; // v4 + ihl=5
  buf[i++] = 0; // dscp
  buf[i++] = (ipLen >> 8) & 0xff;
  buf[i++] = ipLen & 0xff;
  buf[i++] = 0; // id
  buf[i++] = 0;
  buf[i++] = 0x40; // flags+frag
  buf[i++] = 0;
  buf[i++] = 64; // ttl
  buf[i++] = proto;
  buf[i++] = 0; // checksum (unchecked)
  buf[i++] = 0;
  const src = srcIp.split('.').map((n) => parseInt(n, 10));
  const dst = dstIp.split('.').map((n) => parseInt(n, 10));
  buf.set(src, i);
  i += 4;
  buf.set(dst, i);
  i += 4;
  // UDP header
  buf[i++] = 0; // src port hi
  buf[i++] = 12345 & 0xff;
  buf[i++] = (dstPort >> 8) & 0xff;
  buf[i++] = dstPort & 0xff;
  buf[i++] = (udpLen >> 8) & 0xff;
  buf[i++] = udpLen & 0xff;
  buf[i++] = 0; // checksum
  buf[i++] = 0;
  buf.set(enc, i);
  return buf;
}
