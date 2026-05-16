#!/usr/bin/env node
/**
 * logflow-sim MCP server (stdio transport).
 *
 * Speaks the Model Context Protocol over stdin/stdout so any MCP-aware
 * client (Claude Desktop, Continue, etc.) can use the simulator as a tool.
 *
 * Why no SDK: the wire protocol is JSON-RPC 2.0 with a small set of
 * method names. A 200-line implementation keeps the install footprint
 * the same as the rest of the project (zero extra deps) and lets
 * contributors read the code end-to-end without chasing an upstream
 * library's documentation. If we ever need server-sent-events or HTTP
 * transport we can add `@modelcontextprotocol/sdk` then.
 *
 * Run:
 *   node dist/mcp/main.js
 * Or wire it into Claude Desktop's `claude_desktop_config.json`:
 *   {
 *     "mcpServers": {
 *       "logflow-sim": {
 *         "command": "node",
 *         "args": ["/path/to/logflow-sim/dist/mcp/main.js"]
 *       }
 *     }
 *   }
 *
 * All exposed tools operate on inline config text — no filesystem access.
 * Callers paste configs (and optionally Sigma rules / replay corpora)
 * directly into the tool arguments.
 */

import { Buffer } from 'node:buffer';
import { MemoryVFS } from '../core/vfs/memory.js';
import { load, convert as runConvert } from '../core/kernel.js';
import { simulate } from '../core/simulate/evaluator.js';
import { validate } from '../core/validate/index.js';
import {
  replay,
  parseLine,
  parsePcap,
  buildOverlayedModel,
  replayDiff
} from '../core/replay/index.js';
import {
  parseSigma,
  detectionImpact
} from '../core/detection/index.js';
import type { SyslogMessage } from '../core/simulate/syslog-message.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'logflow-sim',
  version: '0.1.0'
};

// ---------------------------------------------------------------------------
// Tool registry — each tool declares its JSON Schema and an async handler.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'logflow_parse',
    description:
      'Parse a log-pipeline config and return the normalized model + diagnostics. Accepts rsyslog/syslog-ng/Vector/OTel-collector/Fluent-Bit/NXLog/Logstash/Filebeat/Promtail/Fluentd. Use this first when reasoning about a config you have only seen as text.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Map of path → text for every file in the config tree. The entrypoint is the file named `rsyslog.conf` or whichever path is the natural root.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content']
          }
        },
        entrypoint: { type: 'string', description: 'Optional VFS-relative entrypoint path. Default: /rsyslog.conf' },
        dialect: { type: 'string', description: 'Force a dialect ID. Auto-detected if omitted.' }
      },
      required: ['files']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      const validation = validate(ctx.model);
      return {
        dialect: ctx.model.dialect,
        summary: {
          files: ctx.model.files.length,
          inputs: ctx.model.inputs.length,
          rulesets: ctx.model.rulesets.length,
          templates: ctx.model.templates.length,
          lookupTables: ctx.model.lookupTables.length
        },
        diagnostics: ctx.model.diagnostics,
        validation: validation.findings
      };
    }
  },
  {
    name: 'logflow_simulate',
    description:
      'Simulate a single syslog message through a parsed config and return the step-by-step trace (input selected, ruleset entered, conditions evaluated, lookups, set/unset, outputs). Use this to explain why a specific message did or did not route to where the operator expected.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        entrypoint: { type: 'string' },
        dialect: { type: 'string' },
        message: {
          type: 'object',
          description: 'SyslogMessage shape: { transport, port, programname, hostname, fromhost, rawmsg, msg, ... }'
        }
      },
      required: ['files', 'message']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      const msg = args.message as SyslogMessage;
      return simulate({ model: ctx.model, lookupTables: ctx.lookupTables, message: msg });
    }
  },
  {
    name: 'logflow_replay',
    description:
      'Replay a batch of real syslog (text lines or base64 pcap) through a parsed config and return the aggregate report: per-ruleset volume, per-output-target volume, top programs, unmatched/error samples. Use to answer "what does my real traffic do in this config".',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        entrypoint: { type: 'string' },
        text: { type: 'string', description: 'Newline-separated syslog lines.' },
        pcapBase64: { type: 'string', description: 'Base64-encoded libpcap / pcapng file.' },
        maxMessages: { type: 'number', description: 'Cap. Default 50000.' }
      },
      required: ['files']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      const messages = collectMessages(args);
      return replay({
        model: ctx.model,
        lookupTables: ctx.lookupTables,
        messages,
        options: { maxMessages: args.maxMessages as number | undefined }
      });
    }
  },
  {
    name: 'logflow_diff',
    description:
      'Replay the same corpus through baseline + overlay variants of a config and report per-output and per-ruleset routing deltas plus per-message route-change samples. The single most useful tool for "what changes if I merge this PR".',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        entrypoint: { type: 'string' },
        overlay: {
          type: 'object',
          description: 'Map of vfs-path → replacement content for the overlaid model.',
          additionalProperties: { type: 'string' }
        },
        text: { type: 'string' },
        pcapBase64: { type: 'string' },
        maxMessages: { type: 'number' }
      },
      required: ['files', 'overlay']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      const overlay = args.overlay as Record<string, string>;
      const overlayed = await buildOverlayedModel(ctx.vfs, overlay, {
        entrypoint: ctx.entrypoint,
        dialect: ctx.model.dialect
      });
      const messages = collectMessages(args);
      return replayDiff({
        baseline: { model: ctx.model, lookupTables: ctx.lookupTables },
        overlay: overlayed,
        messages,
        options: { maxMessages: args.maxMessages as number | undefined }
      });
    }
  },
  {
    name: 'logflow_convert',
    description:
      'Emit a parsed config in another dialect (rsyslog → otel, vector → syslog-ng, etc.) including lookup tables in the target dialect\'s native form. Use for migration planning.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        entrypoint: { type: 'string' },
        target: { type: 'string', description: 'Target dialect ID.' }
      },
      required: ['files', 'target']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      return runConvert(ctx.model, String(args.target), { lookupTables: ctx.lookupTables });
    }
  },
  {
    name: 'logflow_detect',
    description:
      'Run Sigma detection rules against a replay corpus through the parsed config and report per-rule firing counts. Answers "how often does each rule fire under this config + traffic shape".',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        entrypoint: { type: 'string' },
        sigma: { type: 'array', items: { type: 'string' }, description: 'Inline Sigma YAML strings.' },
        text: { type: 'string' },
        pcapBase64: { type: 'string' },
        maxMessages: { type: 'number' }
      },
      required: ['files', 'sigma']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      const rules = [];
      for (const yaml of args.sigma as string[]) {
        const r = parseSigma({ path: 'inline.yml', content: yaml });
        rules.push(...r.rules);
      }
      const messages = collectMessages(args);
      // Enrich messages through the live model so post-routing properties
      // (e.g. `set $!sourcetype = lookup(...)`) reach the matcher.
      const enriched = messages.map((m) => {
        try {
          const res = simulate({ model: ctx.model, lookupTables: ctx.lookupTables, message: m });
          return { ...m, structured: { ...(m.structured ?? {}), ...res.finalState.structured } };
        } catch {
          return m;
        }
      });
      return detectionImpact({ rules, messages: enriched });
    }
  },
  {
    name: 'logflow_validate',
    description:
      'Run the full validator-rule suite (silent drops, undefined refs, missing modules, orphan sources/destinations, …) and return all findings. Use for static analysis without running anything.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        entrypoint: { type: 'string' }
      },
      required: ['files']
    },
    handler: async (args) => {
      const ctx = await modelFromArgs(args);
      return validate(ctx.model);
    }
  }
];

// ---------------------------------------------------------------------------
// Argument-shaping helpers
// ---------------------------------------------------------------------------

async function modelFromArgs(args: Record<string, unknown>) {
  const files = (args.files as { path: string; content: string }[]) ?? [];
  if (files.length === 0) throw new Error('`files` array is required and must be non-empty.');
  const vfs = new MemoryVFS();
  for (const f of files) vfs.write(f.path.startsWith('/') ? f.path : '/' + f.path, f.content);
  const entrypoint = String(args.entrypoint ?? '/rsyslog.conf');
  const loaded = await load(vfs, {
    entrypoint,
    dialect: args.dialect as string | undefined
  });
  return {
    vfs,
    entrypoint,
    model: loaded.model,
    lookupTables: loaded.lookupTables
  };
}

function collectMessages(args: Record<string, unknown>): SyslogMessage[] {
  const messages: SyslogMessage[] = [];
  if (typeof args.text === 'string' && args.text) {
    for (const line of args.text.split(/\r?\n/)) {
      const m = parseLine(line);
      if (m) messages.push(m);
    }
  }
  if (typeof args.pcapBase64 === 'string' && args.pcapBase64) {
    const buf = Buffer.from(args.pcapBase64, 'base64');
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

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio — minimal MCP protocol surface
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}
interface RpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function write(msg: RpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req: RpcRequest): Promise<void> {
  if (!('id' in req)) return; // notifications get no reply
  try {
    const result = await dispatch(req);
    write({ jsonrpc: '2.0', id: req.id, result });
  } catch (e) {
    write({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32603, message: (e as Error).message }
    });
  }
}

async function dispatch(req: RpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      };
    case 'tools/list':
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      };
    case 'tools/call': {
      const params = req.params ?? {};
      const name = params.name as string;
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      const out = await tool.handler(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }]
      };
    }
    case 'ping':
      return {};
    default:
      throw new Error(`unknown method: ${req.method}`);
  }
}

// stdin line-delimited JSON-RPC reader.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  // Newline-delimited — MCP clients always emit one request per line.
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line) as RpcRequest;
      void handle(req);
    } catch {
      // Malformed JSON — drop. A stricter implementation would write a
      // -32700 parse error response, but the spec accepts silence too.
    }
  }
});
process.stdin.on('end', () => process.exit(0));
