import express from 'express';
import { getPipeline } from '../pipeline.js';
import { simulate } from '../../core/simulate/evaluator.js';
import { parseRawMessage } from '../../core/simulate/parse-rawmsg.js';
import type { SyslogMessage } from '../../core/simulate/syslog-message.js';
import { asyncHandler } from '../error-handler.js';
import { BadRequestError } from '../../core/errors.js';
import { getConfRoot, dialectFromQuery, safeHostname } from '../context.js';
import { toSimulateResponseDTO } from '../mappers.js';
import type { AppPaths } from '../context.js';
import type { SimulateRequestDTO, ParseRawmsgRequestDTO } from '../dto.js';

export function simulateRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.post('/parse-rawmsg', (req, res) => {
    const body = (req.body ?? {}) as ParseRawmsgRequestDTO;
    const raw = typeof body.rawmsg === 'string' ? body.rawmsg : '';
    res.json(parseRawMessage(raw));
  });

  r.post(
    '/simulate',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as SimulateRequestDTO;
      // A simulation needs at least *some* message-shape: either an explicit
      // field like rawmsg/msg/programname, or the transport/port to pick an
      // input. An empty object usually means the caller forgot the body —
      // be loud about it rather than silently picking a default input.
      if (!hasMeaningfulRequest(body)) {
        throw new BadRequestError(
          'Simulate body needs at least one of: rawmsg, msg, programname, hostname, fromhost, or transport/port.'
        );
      }
      const msg = buildMessage(body);
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const result = simulate({
        model: pipeline.model,
        lookupTables: pipeline.lookupTables,
        message: msg,
        forceRuleset: body.forceRuleset
      });
      // Auto-fill rawmsg-derived fields from the parsed header when the
      // caller didn't supply them explicitly. Useful when a user pastes
      // just a raw line.
      const parsedRaw =
        typeof body.rawmsg === 'string' && body.rawmsg.length > 0
          ? parseRawMessage(body.rawmsg)
          : undefined;
      res.json(toSimulateResponseDTO(result, parsedRaw));
    })
  );

  return r;
}

function hasMeaningfulRequest(body: SimulateRequestDTO): boolean {
  return Boolean(
    body.rawmsg ||
      body.msg ||
      body.programname ||
      body.hostname ||
      body.fromhost ||
      body.syslogtag ||
      body.transport ||
      body.port
  );
}

/**
 * Take the loose `SimulateRequestDTO` from the wire and produce the strict
 * `SyslogMessage` shape the evaluator expects. Defaults, fallbacks, and
 * rawmsg-derived autofill all live here so the route handler stays small.
 */
function buildMessage(body: SimulateRequestDTO): SyslogMessage {
  const parsedRaw =
    typeof body.rawmsg === 'string' && body.rawmsg.length > 0
      ? parseRawMessage(body.rawmsg)
      : undefined;
  const pick = <T>(explicit: T | undefined, fromRaw: T | undefined): T | undefined =>
    explicit !== undefined && explicit !== '' ? explicit : fromRaw;
  return {
    transport: body.transport === 'tcp' ? 'tcp' : 'udp',
    port:
      typeof body.port === 'number'
        ? body.port
        : parseInt(String(body.port ?? '514'), 10) || 514,
    fromhost: pick<string>(body.fromhost, parsedRaw?.hostname),
    fromhostIp: body.fromhostIp,
    hostname: pick<string>(body.hostname, parsedRaw?.hostname),
    programname: pick<string>(body.programname, parsedRaw?.programname),
    syslogtag: pick<string>(body.syslogtag, parsedRaw?.syslogtag),
    rawmsg: body.rawmsg,
    msg: pick<string>(body.msg, parsedRaw?.msg),
    inputname: body.inputname,
    structured:
      body.structured ?? (parsedRaw?.structured ? { ...parsedRaw.structured } : undefined),
    simTime: typeof body.simTime === 'number' ? body.simTime : undefined,
    myhostname:
      typeof body.myhostname === 'string'
        ? body.myhostname
        : process.env.RSYSLOG_MYHOSTNAME ?? safeHostname()
  };
}
