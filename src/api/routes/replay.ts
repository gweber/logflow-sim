/**
 * Replay endpoints — drive the simulator with a batch of real syslog
 * messages and return an aggregate verdict.
 *
 *   POST /api/replay/lines  body: { lines | text | ndjson, maxMessages? }
 *   POST /api/replay/pcap   body: { pcapBase64, maxMessages? }
 *
 * Both routes share the same engine; they differ only in how messages are
 * decoded from the wire. The response is the aggregate `ReplayReport` —
 * no per-message traces, see core/replay/types.ts for the rationale.
 */

import express from 'express';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { getPipeline } from '../pipeline.js';
import {
  replay,
  parseLine,
  parsePcap,
  replayDiff,
  buildOverlayedModel
} from '../../core/replay/index.js';
import type { OverlayBundle } from '../../core/replay/index.js';
import type { SyslogMessage } from '../../core/simulate/syslog-message.js';
import { asyncHandler } from '../error-handler.js';
import { BadRequestError } from '../../core/errors.js';
import { getConfRoot, dialectFromQuery } from '../context.js';
import { NodeVFS } from '../../vfs/node.js';
import type { AppPaths } from '../context.js';

interface ReplayLinesBody {
  /** Newline-separated raw syslog text, one message per line. */
  text?: string;
  /** Pre-split array of lines, one message per element. */
  lines?: string[];
  /**
   * NDJSON: each line is a JSON object matching SyslogMessage shape.
   * Lets callers bypass the line parser when they already have structured
   * input (e.g. from a separate ETL).
   */
  ndjson?: string;
  maxMessages?: number;
  samplesPerBucket?: number;
}

interface ReplayPcapBody {
  pcapBase64?: string;
  maxMessages?: number;
  samplesPerBucket?: number;
}

export function replayRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.post(
    '/replay/lines',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as ReplayLinesBody;
      const { messages, diagnostics: inputDiagnostics } = collectMessagesFromBody(body);
      if (messages.length === 0) {
        // Mention the input-level diagnostics in the error so a user pasting
        // garbage NDJSON sees specifically WHAT went wrong, not just
        // "no messages".
        const hint =
          inputDiagnostics.length > 0
            ? ` (${inputDiagnostics.length} row${inputDiagnostics.length === 1 ? '' : 's'} could not be parsed)`
            : '';
        throw new BadRequestError(
          `No messages to replay${hint} — provide \`lines\`, \`text\`, or \`ndjson\`.`
        );
      }
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const report = replay({
        model: pipeline.model,
        lookupTables: pipeline.lookupTables,
        messages,
        options: {
          maxMessages: body.maxMessages,
          samplesPerBucket: body.samplesPerBucket
        }
      });
      res.json({ source: 'lines', dialect: pipeline.dialect, report, inputDiagnostics });
    })
  );

  r.post(
    '/replay/pcap',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as ReplayPcapBody;
      if (typeof body.pcapBase64 !== 'string' || body.pcapBase64.length === 0) {
        throw new BadRequestError('Missing `pcapBase64` (base64-encoded libpcap classic file).');
      }
      const buf = Buffer.from(body.pcapBase64, 'base64');
      const parsed = parsePcap(new Uint8Array(buf));
      const messages: SyslogMessage[] = [];
      for (const pkt of parsed.packets) {
        if (pkt.dstPort !== 514 && pkt.dstPort !== 6514 && pkt.dstPort !== 601) continue;
        const m = parseLine(pkt.payload);
        if (!m) continue;
        m.transport = 'udp';
        m.port = pkt.dstPort;
        m.fromhostIp = pkt.srcIp;
        if (!m.fromhost) m.fromhost = pkt.srcIp;
        messages.push(m);
      }
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const report = replay({
        model: pipeline.model,
        lookupTables: pipeline.lookupTables,
        messages,
        options: {
          maxMessages: body.maxMessages,
          samplesPerBucket: body.samplesPerBucket
        }
      });
      res.json({
        source: 'pcap',
        dialect: pipeline.dialect,
        pcap: {
          packetsTotal: parsed.packets.length,
          packetsOnSyslogPorts: messages.length,
          diagnostics: parsed.diagnostics
        },
        report
      });
    })
  );

  r.post(
    '/replay/diff',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as ReplayDiffBody;
      if (!body.overlay || typeof body.overlay !== 'object' || Object.keys(body.overlay).length === 0) {
        throw new BadRequestError('`overlay` map of path → content is required.');
      }
      let messages: SyslogMessage[];
      let inputDiagnostics: InputDiagnostic[];
      if (body.pcapBase64) {
        messages = messagesFromPcap(body.pcapBase64);
        inputDiagnostics = [];
      } else {
        const collected = collectMessagesFromBody(body);
        messages = collected.messages;
        inputDiagnostics = collected.diagnostics;
      }
      if (messages.length === 0) {
        const hint =
          inputDiagnostics.length > 0
            ? ` (${inputDiagnostics.length} row${inputDiagnostics.length === 1 ? '' : 's'} could not be parsed)`
            : '';
        throw new BadRequestError(
          `No replay messages${hint} — provide \`lines\`, \`text\`, \`ndjson\`, or \`pcapBase64\`.`
        );
      }

      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      // The pipeline tracks the entrypoint as a host filesystem path; the
      // overlay loader needs the VFS-relative form (matches the bundled
      // file map). We derive it from confRoot + entrypoint.
      const confRoot = getConfRoot(paths);
      const entrypointVfs =
        '/' + path.relative(confRoot, pipeline.entrypoint).split(path.sep).join('/');
      const overlayed = await buildOverlayedModel(new NodeVFS(confRoot), body.overlay, {
        entrypoint: entrypointVfs,
        dialect: dialectFromQuery(req.query)
      });
      // Surface overlay-side parse diagnostics so a user whose overlay was
      // syntactically broken doesn't see a misleading "everything routes
      // identically" diff verdict (broken-config parses to an empty model
      // which silently routes nothing → unmatched, not what they wanted).
      const overlayDiagnostics = overlayed.diagnostics ?? [];
      const overlayHasErrors = overlayDiagnostics.some((d) => d.severity === 'error');
      const diff = replayDiff({
        baseline: { model: pipeline.model, lookupTables: pipeline.lookupTables },
        overlay: overlayed,
        messages,
        options: {
          maxMessages: body.maxMessages,
          samplesPerBucket: body.samplesPerBucket
        }
      });
      res.json({
        dialect: pipeline.dialect,
        overlayFiles: Object.keys(body.overlay),
        overlayDiagnostics,
        overlayHasErrors,
        inputDiagnostics,
        diff
      });
    })
  );

  return r;
}

interface ReplayDiffBody extends ReplayLinesBody {
  /** Map of vfs-path → replacement content for the overlaid model. */
  overlay?: OverlayBundle;
  /** Pcap source (alternative to lines/text/ndjson). */
  pcapBase64?: string;
}

function messagesFromPcap(pcapBase64: string): SyslogMessage[] {
  const buf = Buffer.from(pcapBase64, 'base64');
  const parsed = parsePcap(new Uint8Array(buf));
  const out: SyslogMessage[] = [];
  for (const pkt of parsed.packets) {
    if (pkt.dstPort !== 514 && pkt.dstPort !== 6514 && pkt.dstPort !== 601) continue;
    const m = parseLine(pkt.payload);
    if (!m) continue;
    m.transport = 'udp';
    m.port = pkt.dstPort;
    m.fromhostIp = pkt.srcIp;
    if (!m.fromhost) m.fromhost = pkt.srcIp;
    out.push(m);
  }
  return out;
}

interface InputDiagnostic {
  source: 'lines' | 'text' | 'ndjson';
  /** 1-based row index in the originating field. */
  row: number;
  message: string;
}

interface CollectedInput {
  messages: SyslogMessage[];
  diagnostics: InputDiagnostic[];
}

/**
 * Decode the line-shaped inputs and collect any per-row parse errors.
 *
 * The previous implementation silently dropped malformed NDJSON rows. That
 * was easy on big production dumps but hostile to operators who pasted a
 * "valid" file and saw only some of it processed — they had no signal
 * about which rows were bad. Now: rows are still skipped (the alternative
 * — failing the whole replay — is worse), but each skip is reported back
 * to the caller so the UI can surface a "X rows could not be parsed" hint.
 */
function collectMessagesFromBody(body: ReplayLinesBody): CollectedInput {
  const messages: SyslogMessage[] = [];
  const diagnostics: InputDiagnostic[] = [];
  if (Array.isArray(body.lines)) {
    body.lines.forEach((line, idx) => {
      if (typeof line !== 'string') {
        diagnostics.push({
          source: 'lines',
          row: idx + 1,
          message: 'non-string entry in `lines` array — ignored'
        });
        return;
      }
      const m = parseLine(line);
      if (m) messages.push(m);
    });
  }
  if (typeof body.text === 'string' && body.text.length > 0) {
    for (const line of body.text.split(/\r?\n/)) {
      const m = parseLine(line);
      if (m) messages.push(m);
    }
  }
  if (typeof body.ndjson === 'string' && body.ndjson.length > 0) {
    const rows = body.ndjson.split(/\r?\n/);
    rows.forEach((line, idx) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line) as Partial<SyslogMessage>;
        messages.push(normalizeNdjsonMessage(obj));
      } catch (e) {
        diagnostics.push({
          source: 'ndjson',
          row: idx + 1,
          message: `JSON parse failed: ${(e as Error).message}`
        });
      }
    });
  }
  return { messages, diagnostics };
}

function normalizeNdjsonMessage(obj: Partial<SyslogMessage>): SyslogMessage {
  return {
    transport: obj.transport === 'tcp' ? 'tcp' : 'udp',
    port: typeof obj.port === 'number' ? obj.port : 514,
    fromhost: obj.fromhost,
    fromhostIp: obj.fromhostIp,
    hostname: obj.hostname,
    programname: obj.programname,
    syslogtag: obj.syslogtag,
    rawmsg: obj.rawmsg,
    msg: obj.msg,
    inputname: obj.inputname,
    structured: obj.structured,
    simTime: typeof obj.simTime === 'number' ? obj.simTime : undefined,
    myhostname: obj.myhostname
  };
}
