/**
 * Detection-impact endpoints — replay a message batch against a set of
 * Sigma rules and report how often each rule would fire. Optionally diff
 * those firing counts against an overlaid model variant so a PR-style
 * config change shows "this routing edit cuts Sigma rule X by 74%".
 *
 *   POST /api/detection/impact  body: { sigma | sigmaText[], text|pcapBase64, maxMessages? }
 *   POST /api/detection/diff    body: { sigma | sigmaText[], overlay, text|pcapBase64 }
 *
 * Sigma rules can be uploaded inline (`sigmaText` — array of YAML strings)
 * or referenced by repository path (`sigma` — relative to conf-root, for
 * teams that commit their Sigma rules next to their pipeline configs).
 */

import express from 'express';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { getPipeline } from '../pipeline.js';
import {
  parseSigma,
  detectionImpact,
  detectionDiff
} from '../../core/detection/index.js';
import type { SigmaRule } from '../../core/detection/index.js';
import {
  parseLine,
  parsePcap,
  buildOverlayedModel
} from '../../core/replay/index.js';
import type { OverlayBundle } from '../../core/replay/index.js';
import { simulate } from '../../core/simulate/evaluator.js';
import type { SyslogMessage } from '../../core/simulate/syslog-message.js';
import { asyncHandler } from '../error-handler.js';
import { BadRequestError } from '../../core/errors.js';
import { getConfRoot, dialectFromQuery } from '../context.js';
import { NodeVFS } from '../../vfs/node.js';
import type { AppPaths } from '../context.js';

interface DetectionBody {
  /** Inline Sigma YAML strings — each entry is a full rule document. */
  sigmaText?: string[];
  /** Repository-path references (relative to conf-root). */
  sigma?: string[];

  /** Same input shapes as /replay. */
  text?: string;
  lines?: string[];
  ndjson?: string;
  pcapBase64?: string;

  maxMessages?: number;
  samplesPerRule?: number;

  /** Diff-only: overlay file map. */
  overlay?: OverlayBundle;
}

export function detectionRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.post(
    '/detection/impact',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as DetectionBody;
      const { rules, ruleDiagnostics } = await loadSigmaRules(body, paths);
      if (rules.length === 0) {
        throw new BadRequestError(
          'No Sigma rules provided — pass `sigmaText: [yamlString, ...]` or `sigma: ["path/to/rule.yml"]`.'
        );
      }
      const messages = await collectMessages(body);
      if (messages.length === 0) {
        throw new BadRequestError(
          'No messages — provide `text`, `lines`, `ndjson`, or `pcapBase64`.'
        );
      }
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      // Run the messages through the live config first so the engine sees
      // post-routing properties (programname normalization, structured
      // fields injected by `set $!sourcetype = lookup(...)`, etc.). This
      // is the whole reason Sigma-impact-on-config is interesting: a
      // routing change that strips `programname` blinds the detection.
      const enriched = enrichThroughPipeline(messages, pipeline);
      const report = detectionImpact({
        rules,
        messages: enriched,
        options: { maxMessages: body.maxMessages, samplesPerRule: body.samplesPerRule }
      });
      res.json({
        dialect: pipeline.dialect,
        rulesLoaded: rules.length,
        ruleDiagnostics,
        report
      });
    })
  );

  r.post(
    '/detection/diff',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as DetectionBody;
      if (!body.overlay || Object.keys(body.overlay).length === 0) {
        throw new BadRequestError('`overlay` map of path → content is required for diff.');
      }
      const { rules, ruleDiagnostics } = await loadSigmaRules(body, paths);
      if (rules.length === 0) {
        throw new BadRequestError('No Sigma rules provided.');
      }
      const messages = await collectMessages(body);
      if (messages.length === 0) {
        throw new BadRequestError('No messages — provide `text`, `lines`, `ndjson`, or `pcapBase64`.');
      }

      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const confRoot = getConfRoot(paths);
      const entrypointVfs =
        '/' + path.relative(confRoot, pipeline.entrypoint).split(path.sep).join('/');
      const overlayed = await buildOverlayedModel(new NodeVFS(confRoot), body.overlay, {
        entrypoint: entrypointVfs,
        dialect: dialectFromQuery(req.query)
      });

      const baselineEnriched = enrichThroughPipeline(messages, pipeline);
      const overlayEnriched = enrichThroughPipeline(messages, overlayed);

      const diff = detectionDiff({
        rules,
        baselineMessages: baselineEnriched,
        overlayMessages: overlayEnriched,
        options: { maxMessages: body.maxMessages, samplesPerRule: body.samplesPerRule }
      });
      res.json({
        dialect: pipeline.dialect,
        rulesLoaded: rules.length,
        ruleDiagnostics,
        overlayDiagnostics: overlayed.diagnostics,
        overlayFiles: Object.keys(body.overlay),
        diff
      });
    })
  );

  return r;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSigmaRules(
  body: DetectionBody,
  paths: AppPaths
): Promise<{ rules: SigmaRule[]; ruleDiagnostics: { file?: string; severity: string; message: string }[] }> {
  const rules: SigmaRule[] = [];
  const ruleDiagnostics: { file?: string; severity: string; message: string }[] = [];
  if (Array.isArray(body.sigmaText)) {
    body.sigmaText.forEach((content, i) => {
      if (typeof content !== 'string') return;
      const r = parseSigma({ path: `inline-${i + 1}.yml`, content });
      rules.push(...r.rules);
      ruleDiagnostics.push(...r.diagnostics);
    });
  }
  if (Array.isArray(body.sigma)) {
    const confRoot = getConfRoot(paths);
    const vfs = new NodeVFS(confRoot);
    for (const rel of body.sigma) {
      if (typeof rel !== 'string') continue;
      try {
        const abs = '/' + rel.replace(/^\/+/, '');
        const content = await vfs.readFile(abs);
        const r = parseSigma({ path: rel, content });
        rules.push(...r.rules);
        ruleDiagnostics.push(...r.diagnostics);
      } catch (e) {
        ruleDiagnostics.push({
          file: rel,
          severity: 'error',
          message: `Failed to read Sigma rule: ${(e as Error).message}`
        });
      }
    }
  }
  return { rules, ruleDiagnostics };
}

async function collectMessages(body: DetectionBody): Promise<SyslogMessage[]> {
  const messages: SyslogMessage[] = [];
  if (typeof body.text === 'string' && body.text.length > 0) {
    for (const line of body.text.split(/\r?\n/)) {
      const m = parseLine(line);
      if (m) messages.push(m);
    }
  }
  if (Array.isArray(body.lines)) {
    for (const line of body.lines) {
      if (typeof line !== 'string') continue;
      const m = parseLine(line);
      if (m) messages.push(m);
    }
  }
  if (typeof body.ndjson === 'string' && body.ndjson.length > 0) {
    for (const line of body.ndjson.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as SyslogMessage);
      } catch {
        /* malformed ndjson skipped — same policy as /replay */
      }
    }
  }
  if (typeof body.pcapBase64 === 'string' && body.pcapBase64.length > 0) {
    const buf = Buffer.from(body.pcapBase64, 'base64');
    const parsed = parsePcap(new Uint8Array(buf));
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
  }
  return messages;
}

/**
 * Run each message through the pipeline so Sigma sees the post-routing
 * property shape (lookups applied, structured fields filled). Messages
 * that never reach a ruleset under the current model are kept verbatim
 * — they still count as candidate evidence even if not routed.
 */
function enrichThroughPipeline(
  messages: SyslogMessage[],
  pipeline: { model: import('../../core/ir/model.js').IRModel; lookupTables: Record<string, import('../../core/lookups/types.js').LookupTableData> }
): SyslogMessage[] {
  return messages.map((m) => {
    try {
      const res = simulate({ model: pipeline.model, lookupTables: pipeline.lookupTables, message: m });
      // Splice structured-data updates onto the message so Sigma rules
      // matching on $!sourcetype etc. see post-routing state. We don't
      // mutate the input array.
      const structured = { ...(m.structured ?? {}), ...res.finalState.structured };
      return { ...m, structured };
    } catch {
      return m;
    }
  });
}
