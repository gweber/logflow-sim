#!/usr/bin/env node
/**
 * logflow-sim CLI.
 *
 * Designed to be the engine behind the GitHub Action and any local
 * pre-commit hook. No external CLI library — kept hand-written so the
 * install footprint stays tiny.
 *
 * Subcommands:
 *   parse <conf-dir>      Parse the config, emit diagnostics, exit non-zero
 *                         if errors (or warnings, with --fail-on=warnings).
 *   test <conf-dir>       Same as parse, then run conf/tests/*.json cases.
 *   simulate <conf-dir>   Run one simulation, print trace as JSON.
 *
 * Output modes:
 *   --format=human        Default; readable for local terminals.
 *   --format=github       GitHub Actions annotations
 *                         (::error file=...,line=...,title=...::message).
 *   --format=json         Machine-readable for piping to jq.
 *
 * Exit codes:
 *   0  success
 *   1  diagnostics threshold breached (--fail-on)
 *   2  test cases failed
 *   3  bad invocation (missing args, unreadable config, etc.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeVFS } from '../vfs/node.js';
import { loadConfig } from '../config/loader.js';
import { rsyslogDialect } from '../core/dialects/rsyslog/index.js';
import { simulate } from '../core/simulate/evaluator.js';
import { loadLookupTables } from '../lookups/loader.js';
import {
  replay as runReplay,
  replayDiff,
  buildOverlayedModel,
  parseLine,
  parsePcap
} from '../core/replay/index.js';
import { convert as runConvert } from '../core/kernel.js';
import { parseSigma, detectionImpact, detectionDiff } from '../core/detection/index.js';
import type { SyslogMessage } from '../core/simulate/syslog-message.js';
import type { Diagnostic, Severity } from '../core/diagnostics.js';

interface CliFlags {
  format: 'human' | 'github' | 'json';
  failOn: 'errors' | 'warnings' | 'never';
  entrypoint: string;
  testsDir?: string;
  inputFile?: string;
  /** Path to a file with newline-separated syslog lines (replay/diff). */
  linesFile?: string;
  /** Path to a libpcap classic file (replay/diff). */
  pcapFile?: string;
  /** For diff: directory holding the overlay's full file tree. */
  overlayDir?: string;
  /** For diff: list of file paths (relative to confDir) that have changed. */
  overlayFiles?: string[];
  /** For diff: fail when total route changes meet/exceed this absolute count. */
  maxRouteChanges?: number;
  /** For diff: fail when more than this percentage of messages change routing. */
  maxRouteChangePct?: number;
  /** For replay/diff: hard cap on processed messages. */
  maxMessages: number;
  /** For detection-impact / detection-diff: Sigma rule paths (collected). */
  sigmaFiles?: string[];
  /** For detection-diff: max fires regression delta before exit 1. */
  maxRegression?: number;
  /** For convert: target dialect ID. */
  target?: string;
  /** For convert: directory to write the converted files into. */
  outDir?: string;
  /** For convert: overwrite outDir even if non-empty. */
  force?: boolean;
  /** For convert/retag: source SIEM destination ID (defaults to auto-detect). */
  sourceSiem?: string;
  /** For convert/retag: target SIEM destination ID. */
  targetSiem?: string;
  quiet: boolean;
}

const DEFAULT_FLAGS: CliFlags = {
  format: 'human',
  failOn: 'errors',
  entrypoint: 'rsyslog.conf',
  maxMessages: 50_000,
  quiet: false
};

const VALID_FORMATS: CliFlags['format'][] = ['human', 'github', 'json'];
const VALID_FAIL_ON: CliFlags['failOn'][] = ['errors', 'warnings', 'never'];

function validatedFormat(v: string | undefined): CliFlags['format'] {
  if (v && (VALID_FORMATS as string[]).includes(v)) return v as CliFlags['format'];
  die(`Invalid --format value: ${v ?? '<empty>'} (expected one of: ${VALID_FORMATS.join(', ')})`, 3);
}
function validatedFailOn(v: string | undefined): CliFlags['failOn'] {
  if (v && (VALID_FAIL_ON as string[]).includes(v)) return v as CliFlags['failOn'];
  die(`Invalid --fail-on value: ${v ?? '<empty>'} (expected one of: ${VALID_FAIL_ON.join(', ')})`, 3);
}

function parseFlags(argv: string[]): { positional: string[]; flags: CliFlags } {
  const flags: CliFlags = { ...DEFAULT_FLAGS };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '-f') flags.format = validatedFormat(argv[++i]);
    else if (a.startsWith('--format=')) flags.format = validatedFormat(a.slice(9));
    else if (a === '--fail-on') flags.failOn = validatedFailOn(argv[++i]);
    else if (a.startsWith('--fail-on=')) flags.failOn = validatedFailOn(a.slice(10));
    else if (a === '--entrypoint' || a === '-e') flags.entrypoint = argv[++i] ?? flags.entrypoint;
    else if (a.startsWith('--entrypoint=')) flags.entrypoint = a.slice(13);
    else if (a === '--tests') flags.testsDir = argv[++i];
    else if (a.startsWith('--tests=')) flags.testsDir = a.slice(8);
    else if (a === '--input' || a === '-i') flags.inputFile = argv[++i];
    else if (a.startsWith('--input=')) flags.inputFile = a.slice(8);
    else if (a === '--lines') flags.linesFile = argv[++i];
    else if (a.startsWith('--lines=')) flags.linesFile = a.slice(8);
    else if (a === '--pcap') flags.pcapFile = argv[++i];
    else if (a.startsWith('--pcap=')) flags.pcapFile = a.slice(7);
    else if (a === '--overlay-dir') flags.overlayDir = argv[++i];
    else if (a.startsWith('--overlay-dir=')) flags.overlayDir = a.slice(14);
    else if (a === '--overlay-file') (flags.overlayFiles ??= []).push(argv[++i]);
    else if (a.startsWith('--overlay-file=')) (flags.overlayFiles ??= []).push(a.slice(15));
    else if (a === '--max-messages') flags.maxMessages = parseInt(argv[++i] ?? '50000', 10);
    else if (a.startsWith('--max-messages=')) flags.maxMessages = parseInt(a.slice(15), 10);
    else if (a === '--max-route-changes')
      flags.maxRouteChanges = parseInt(argv[++i] ?? '0', 10);
    else if (a.startsWith('--max-route-changes='))
      flags.maxRouteChanges = parseInt(a.slice(20), 10);
    else if (a === '--max-route-change-pct')
      flags.maxRouteChangePct = parseFloat(argv[++i] ?? '0');
    else if (a.startsWith('--max-route-change-pct='))
      flags.maxRouteChangePct = parseFloat(a.slice(23));
    else if (a === '--sigma') (flags.sigmaFiles ??= []).push(argv[++i]);
    else if (a.startsWith('--sigma=')) (flags.sigmaFiles ??= []).push(a.slice(8));
    else if (a === '--max-regression') flags.maxRegression = parseInt(argv[++i] ?? '0', 10);
    else if (a.startsWith('--max-regression=')) flags.maxRegression = parseInt(a.slice(17), 10);
    else if (a === '--target') flags.target = argv[++i];
    else if (a.startsWith('--target=')) flags.target = a.slice(9);
    else if (a === '--out-dir' || a === '-o') flags.outDir = argv[++i];
    else if (a.startsWith('--out-dir=')) flags.outDir = a.slice(10);
    else if (a === '--force') flags.force = true;
    else if (a === '--source-siem') flags.sourceSiem = argv[++i];
    else if (a.startsWith('--source-siem=')) flags.sourceSiem = a.slice(14);
    else if (a === '--target-siem') flags.targetSiem = argv[++i];
    else if (a.startsWith('--target-siem=')) flags.targetSiem = a.slice(14);
    else if (a === '--quiet' || a === '-q') flags.quiet = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('-')) {
      die(`Unknown flag: ${a}`, 3);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  process.stdout.write(`logflow-sim — explainable log-pipeline simulator

Usage:
  logflow-sim parse    <conf-dir> [--fail-on=errors|warnings|never] [--format=human|github|json]
  logflow-sim test     <conf-dir> [--tests=DIR] [--fail-on=…] [--format=…]
  logflow-sim simulate <conf-dir> --input=msg.json [--format=…]
  logflow-sim replay   <conf-dir> (--lines=FILE | --pcap=FILE) [--max-messages=N] [--format=…]
  logflow-sim convert  <conf-dir> --target=DIALECT --out-dir=PATH [--force]
                                  [--source-siem=ID] [--target-siem=ID]
  logflow-sim retag    <conf-dir> --target-siem=ID --out-dir=PATH [--force]
                                  [--source-siem=ID]
  logflow-sim detection-impact <conf-dir> --sigma=RULE.yml [--sigma=...]
                                          (--lines=FILE | --pcap=FILE) [--format=...]
  logflow-sim detection-diff   <conf-dir> --sigma=RULE.yml [--sigma=...]
                                          (--overlay-dir=DIR | --overlay-file=PATH)
                                          (--lines=FILE | --pcap=FILE)
                                          [--max-regression=N]
  logflow-sim diff     <conf-dir> (--overlay-dir=DIR | --overlay-file=PATH ...)
                                  (--lines=FILE | --pcap=FILE)
                                  [--max-route-changes=N] [--max-route-change-pct=PCT]
                                  [--max-messages=N] [--format=…]

Common flags:
  -e, --entrypoint=FILE   Path to entrypoint, relative to conf-dir (default: rsyslog.conf)
  -f, --format=FMT        human (default) | github | json
      --fail-on=LEVEL     errors (default) | warnings | never
  -q, --quiet             Suppress non-diagnostic chatter
  -h, --help              This text

Exit codes:
  0  success
  1  diagnostics threshold breached
  2  test cases failed
  3  bad invocation
`);
}

function die(msg: string, code: number): never {
  process.stderr.write(`logflow-sim: ${msg}\n`);
  process.exit(code);
}

async function getModel(confDir: string, entrypoint: string) {
  const abs = path.resolve(confDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    die(`Config directory not found: ${confDir}`, 3);
  }
  const vfs = new NodeVFS(abs);
  const entrypointVfs = '/' + entrypoint.replace(/^conf\//, '').replace(/^\/+/, '');
  const load = await loadConfig({ vfs, entrypoint: entrypointVfs });
  const diags: Diagnostic[] = [...load.diagnostics.items];
  const dialectResult = rsyslogDialect.parseFiles(
    load.files.map((f) => ({ path: f.path.replace(/^\/+/, ''), content: f.content }))
  );
  diags.push(...dialectResult.diagnostics);
  const model = dialectResult.model;
  const { data: lookupTables, diagnostics: ld } = await loadLookupTables(model.lookupTables, vfs);
  diags.push(...ld);
  return { vfs, model, lookupTables, diagnostics: diags, files: load.files };
}

function severityRank(s: Severity): number {
  return s === 'error' ? 3 : s === 'warning' ? 2 : 1;
}

function shouldFail(flags: CliFlags, diagnostics: Diagnostic[]): boolean {
  if (flags.failOn === 'never') return false;
  const threshold = flags.failOn === 'errors' ? 3 : 2;
  return diagnostics.some((d) => severityRank(d.severity) >= threshold);
}

function emitDiagnostics(flags: CliFlags, diagnostics: Diagnostic[]): void {
  if (flags.format === 'json') {
    process.stdout.write(JSON.stringify({ diagnostics }, null, 2) + '\n');
    return;
  }
  if (flags.format === 'github') {
    for (const d of diagnostics) {
      const cmd =
        d.severity === 'error'
          ? '::error'
          : d.severity === 'warning'
          ? '::warning'
          : '::notice';
      const file = d.source?.file ?? '';
      const line = d.source?.line ?? '';
      const col = d.source?.col ?? '';
      const title = d.code ?? '';
      const safeMessage = String(d.message).replace(/\r/g, '').replace(/\n/g, '%0A');
      process.stdout.write(
        `${cmd} file=${file},line=${line},col=${col},title=${title}::${safeMessage}\n`
      );
    }
    return;
  }
  // human
  if (diagnostics.length === 0) {
    process.stdout.write('No diagnostics.\n');
    return;
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  process.stdout.write(
    `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info(s)\n\n`
  );
  for (const d of diagnostics) {
    const loc = d.source ? `${d.source.file}:${d.source.line}:${d.source.col}` : '';
    const code = d.code ? ` [${d.code}]` : '';
    const sev = d.severity.toUpperCase().padEnd(7);
    process.stdout.write(`  ${sev} ${loc}${code}\n           ${d.message}\n`);
  }
}

async function cmdParse(confDir: string, flags: CliFlags): Promise<number> {
  const { model, diagnostics } = await getModel(confDir, flags.entrypoint);
  // Run the validator on the parsed IR and append its findings so static
  // analysis (dead code, silent-drop paths, undefined references) is part
  // of the standard parse output. The CI gate then trips on these the same
  // way it does on parser diagnostics.
  const validation = (await import('../core/validate/index.js')).validate(model);
  const combined = [...diagnostics, ...validation.findings];
  if (flags.format === 'json') {
    process.stdout.write(
      JSON.stringify(
        {
          summary: {
            inputs: model.inputs.length,
            rulesets: model.rulesets.length,
            templates: model.templates.length,
            lookupTables: model.lookupTables.length,
            modules: model.modules.length
          },
          diagnostics: combined,
          validation: validation.summary
        },
        null,
        2
      ) + '\n'
    );
  } else {
    if (!flags.quiet && flags.format !== 'github') {
      process.stdout.write(
        `Parsed: ${model.inputs.length} inputs · ${model.rulesets.length} rulesets · ` +
          `${model.templates.length} templates · ${model.lookupTables.length} lookup tables\n` +
          `Validator: ${validation.summary.errors} errors · ${validation.summary.warnings} warnings · ` +
          `${validation.summary.info} info\n\n`
      );
    }
    emitDiagnostics(flags, combined);
  }
  return shouldFail(flags, combined) ? 1 : 0;
}

interface TestCase {
  name: string;
  file: string;
  input: Record<string, unknown>;
  expect?: {
    ruleset?: string;
    stopped?: boolean;
    dropped?: boolean;
    outputsContains?: {
      kind?: string;
      pathContains?: string;
      target?: string;
      port?: number;
      protocol?: string;
    }[];
    structured?: Record<string, string>;
    localVars?: Record<string, string>;
  };
}

function readTestCases(dir: string): TestCase[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const out: TestCase[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const t of arr) {
        out.push({ name: t.name ?? f, file: f, input: t.input ?? {}, expect: t.expect });
      }
    } catch {
      // unparseable test files are surfaced via parse diagnostics later
    }
  }
  return out;
}

async function cmdTest(confDir: string, flags: CliFlags): Promise<number> {
  const { model, lookupTables, diagnostics } = await getModel(confDir, flags.entrypoint);
  const testsDir = flags.testsDir
    ? path.resolve(flags.testsDir)
    : path.resolve(confDir, 'tests');
  const cases = readTestCases(testsDir);
  const fallbackHostname = process.env.RSYSLOG_MYHOSTNAME ?? safeHostname();

  let pass = 0;
  let fail = 0;
  const failures: { name: string; checks: { name: string; want?: unknown; got?: unknown }[] }[] = [];

  for (const tc of cases) {
    const inputMsg = tc.input as Partial<SyslogMessage> & Record<string, unknown>;
    const msg: SyslogMessage = {
      ...(inputMsg as SyslogMessage),
      myhostname:
        typeof inputMsg.myhostname === 'string' ? inputMsg.myhostname : fallbackHostname
    };
    const result = simulate({ model, lookupTables, message: msg });
    const checks = runExpectations(tc.expect ?? {}, result);
    const ok = checks.every((c) => c.passed);
    if (ok) pass++;
    else {
      fail++;
      failures.push({
        name: `${tc.file} · ${tc.name}`,
        checks: checks.filter((c) => !c.passed)
      });
    }
  }

  if (flags.format === 'json') {
    process.stdout.write(
      JSON.stringify({ passed: pass, failed: fail, total: cases.length, failures, diagnostics }, null, 2) + '\n'
    );
  } else if (flags.format === 'github') {
    emitDiagnostics(flags, diagnostics);
    for (const f of failures) {
      for (const c of f.checks) {
        const msg =
          `${f.name}: ${c.name} mismatch — want ${JSON.stringify(c.want)}, ` +
          `got ${JSON.stringify(c.got)}`;
        process.stdout.write(`::error title=test failed::${msg.replace(/\n/g, '%0A')}\n`);
      }
    }
    process.stdout.write(
      `::notice::${pass}/${cases.length} test cases passed${fail ? `, ${fail} failed` : ''}\n`
    );
  } else {
    emitDiagnostics(flags, diagnostics);
    process.stdout.write(`\n${pass}/${cases.length} test cases passed`);
    if (fail) process.stdout.write(`, ${fail} failed`);
    process.stdout.write('\n');
    for (const f of failures) {
      process.stdout.write(`\n  FAIL ${f.name}\n`);
      for (const c of f.checks) {
        process.stdout.write(
          `    ${c.name}: want ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}\n`
        );
      }
    }
  }

  if (shouldFail(flags, diagnostics)) return 1;
  return fail > 0 ? 2 : 0;
}

async function cmdSimulate(confDir: string, flags: CliFlags): Promise<number> {
  if (!flags.inputFile) die('simulate requires --input=<json-file>', 3);
  const inputAbs = path.resolve(flags.inputFile);
  if (!fs.existsSync(inputAbs)) die(`Input file not found: ${flags.inputFile}`, 3);
  const input = JSON.parse(fs.readFileSync(inputAbs, 'utf8')) as Partial<SyslogMessage>;

  const { model, lookupTables, diagnostics } = await getModel(confDir, flags.entrypoint);
  const msg: SyslogMessage = {
    transport: input.transport === 'tcp' ? 'tcp' : 'udp',
    port: typeof input.port === 'number' ? input.port : 514,
    ...input,
    myhostname:
      typeof input.myhostname === 'string'
        ? input.myhostname
        : process.env.RSYSLOG_MYHOSTNAME ?? safeHostname()
  };
  const result = simulate({ model, lookupTables, message: msg });
  process.stdout.write(JSON.stringify({ ...result, diagnostics }, null, 2) + '\n');
  return shouldFail(flags, diagnostics) ? 1 : 0;
}

function runExpectations(
  expect: NonNullable<TestCase['expect']>,
  result: ReturnType<typeof simulate>
): { name: string; passed: boolean; want?: unknown; got?: unknown }[] {
  const checks: { name: string; passed: boolean; want?: unknown; got?: unknown }[] = [];
  if (expect.ruleset !== undefined) {
    checks.push({
      name: 'ruleset',
      want: expect.ruleset,
      got: result.selectedRuleset,
      passed: result.selectedRuleset === expect.ruleset
    });
  }
  if (expect.stopped !== undefined) {
    checks.push({
      name: 'stopped',
      want: expect.stopped,
      got: result.finalState.stopped,
      passed: result.finalState.stopped === expect.stopped
    });
  }
  if (expect.dropped !== undefined) {
    checks.push({
      name: 'dropped',
      want: expect.dropped,
      got: result.finalState.dropped,
      passed: result.finalState.dropped === expect.dropped
    });
  }
  if (expect.outputsContains) {
    for (const exp of expect.outputsContains) {
      const matched = result.finalState.outputs.some(
        (o) =>
          (exp.kind === undefined || o.kind === exp.kind) &&
          (exp.pathContains === undefined || (o.path ?? '').includes(exp.pathContains)) &&
          (exp.target === undefined || o.target === exp.target) &&
          (exp.port === undefined || o.port === exp.port) &&
          (exp.protocol === undefined || o.protocol === exp.protocol)
      );
      checks.push({
        name: 'outputsContains',
        want: exp,
        got: result.finalState.outputs,
        passed: matched
      });
    }
  }
  if (expect.structured) {
    for (const [k, v] of Object.entries(expect.structured)) {
      checks.push({
        name: `structured.${k}`,
        want: v,
        got: result.finalState.structured[k],
        passed: result.finalState.structured[k] === v
      });
    }
  }
  if (expect.localVars) {
    for (const [k, v] of Object.entries(expect.localVars)) {
      checks.push({
        name: `localVars.${k}`,
        want: v,
        got: result.finalState.localVars[k],
        passed: result.finalState.localVars[k] === v
      });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// replay + diff
// ---------------------------------------------------------------------------

function collectMessages(flags: CliFlags): SyslogMessage[] {
  if (!flags.linesFile && !flags.pcapFile) {
    die(`replay/diff requires --lines=FILE or --pcap=FILE`, 3);
  }
  if (flags.linesFile && flags.pcapFile) {
    die(`Use either --lines or --pcap, not both`, 3);
  }
  const messages: SyslogMessage[] = [];
  if (flags.linesFile) {
    const text = fs.readFileSync(path.resolve(flags.linesFile), 'utf8');
    for (const l of text.split(/\r?\n/)) {
      const m = parseLine(l);
      if (m) messages.push(m);
    }
  } else if (flags.pcapFile) {
    const buf = fs.readFileSync(path.resolve(flags.pcapFile));
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

function emitReport(flags: CliFlags, header: string, report: ReturnType<typeof runReplay>): void {
  if (flags.format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  process.stdout.write(`${header}\n`);
  process.stdout.write(
    `  processed=${report.processed}  delivered=${report.delivered}  unmatched=${report.noInputMatch}  noOutput=${report.noOutput}  errors=${report.errors}  in ${report.durationMs}ms\n`
  );
  if (report.perRuleset.length > 0) {
    process.stdout.write(`  per-ruleset:\n`);
    for (const r of report.perRuleset) {
      process.stdout.write(`    ${r.key.padEnd(24)}  ${String(r.count).padStart(8)}  ${r.pct}%\n`);
    }
  }
  if (report.perOutput.length > 0) {
    process.stdout.write(`  top output targets:\n`);
    for (const o of report.perOutput.slice(0, 8)) {
      process.stdout.write(
        `    ${o.kind.padEnd(8)} ${String(o.count).padStart(8)}  ${o.target}\n`
      );
    }
  }
}

async function cmdReplay(confDir: string, flags: CliFlags): Promise<number> {
  const ctx = await getModel(confDir, flags.entrypoint);
  if (shouldFail(flags, ctx.diagnostics)) {
    emitDiagnostics(flags, ctx.diagnostics);
    return 1;
  }
  const messages = collectMessages(flags);
  if (messages.length === 0) {
    die(`No messages parsed from ${flags.linesFile ?? flags.pcapFile}`, 3);
  }
  const report = runReplay({
    model: ctx.model,
    lookupTables: ctx.lookupTables,
    messages,
    options: { maxMessages: flags.maxMessages }
  });
  emitReport(flags, `Replayed ${messages.length} messages through ${confDir}`, report);
  return 0;
}

function collectOverlayBundle(
  flags: CliFlags,
  confDir: string
): Record<string, string> {
  const overlay: Record<string, string> = {};
  if (flags.overlayDir) {
    const base = path.resolve(flags.overlayDir);
    const stat = fs.statSync(base);
    if (!stat.isDirectory()) die(`--overlay-dir must point to a directory: ${flags.overlayDir}`, 3);
    walkFiles(base, base, overlay);
  }
  if (flags.overlayFiles) {
    const confAbs = path.resolve(confDir);
    for (const spec of flags.overlayFiles) {
      // The spec is a real path on disk. We derive the overlay key (the
      // conf-dir-relative slot the file should occupy) by stripping the
      // conf-dir prefix if the spec sits inside it, falling back to the
      // basename otherwise.
      const abs = path.isAbsolute(spec) ? spec : path.resolve(spec);
      if (!fs.existsSync(abs)) die(`overlay file not found: ${spec}`, 3);
      const content = fs.readFileSync(abs, 'utf8');
      const rel = path.relative(confAbs, abs);
      const key = rel.startsWith('..') ? path.basename(abs) : rel.replace(/\\/g, '/');
      overlay[key] = content;
    }
  }
  return overlay;
}

function walkFiles(root: string, dir: string, into: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, abs, into);
    else if (entry.isFile()) {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      into[rel] = fs.readFileSync(abs, 'utf8');
    }
  }
}

async function cmdDiff(confDir: string, flags: CliFlags): Promise<number> {
  const baseline = await getModel(confDir, flags.entrypoint);
  if (shouldFail(flags, baseline.diagnostics)) {
    emitDiagnostics(flags, baseline.diagnostics);
    return 1;
  }
  const overlay = collectOverlayBundle(flags, confDir);
  if (Object.keys(overlay).length === 0) {
    die(`diff requires --overlay-dir=DIR or one or more --overlay-file=PATH`, 3);
  }
  const messages = collectMessages(flags);
  if (messages.length === 0) {
    die(`No messages parsed from ${flags.linesFile ?? flags.pcapFile}`, 3);
  }
  const entrypointVfs = '/' + flags.entrypoint.replace(/^conf\//, '').replace(/^\/+/, '');
  const overlayed = await buildOverlayedModel(baseline.vfs, overlay, {
    entrypoint: entrypointVfs,
    dialect: 'rsyslog'
  });
  const diff = replayDiff({
    baseline: { model: baseline.model, lookupTables: baseline.lookupTables },
    overlay: overlayed,
    messages,
    options: { maxMessages: flags.maxMessages }
  });

  if (flags.format === 'json') {
    process.stdout.write(
      JSON.stringify({ overlayFiles: Object.keys(overlay), diff }, null, 2) + '\n'
    );
  } else if (flags.format === 'github') {
    emitGithubDiffSummary(diff, Object.keys(overlay));
  } else {
    emitHumanDiff(diff, Object.keys(overlay));
  }

  const pct =
    diff.baseline.processed > 0
      ? (diff.routeChanges / diff.baseline.processed) * 100
      : 0;
  if (flags.maxRouteChanges !== undefined && diff.routeChanges > flags.maxRouteChanges) {
    process.stderr.write(
      `logflow-sim: ${diff.routeChanges} route changes > --max-route-changes=${flags.maxRouteChanges}\n`
    );
    return 1;
  }
  if (
    flags.maxRouteChangePct !== undefined &&
    pct > flags.maxRouteChangePct
  ) {
    process.stderr.write(
      `logflow-sim: ${pct.toFixed(2)}% routes changed > --max-route-change-pct=${flags.maxRouteChangePct}\n`
    );
    return 1;
  }
  return 0;
}

function emitHumanDiff(
  diff: Awaited<ReturnType<typeof replayDiff>>,
  files: string[]
): void {
  const pct =
    diff.baseline.processed > 0
      ? ((diff.routeChanges / diff.baseline.processed) * 100).toFixed(2)
      : '0.00';
  process.stdout.write(
    `Diff verdict — overlaying ${files.length} file(s): ${files.join(', ')}\n`
  );
  process.stdout.write(
    `  routeChanges=${diff.routeChanges} (${pct}%)  movedToDelivered=+${diff.movedToDelivered}  movedToUnmatched=-${diff.movedToUnmatched}\n`
  );
  if (diff.outputDeltas.length > 0) {
    process.stdout.write(`  output deltas:\n`);
    for (const o of diff.outputDeltas.slice(0, 12)) {
      const sign = o.delta > 0 ? '+' : '';
      process.stdout.write(
        `    ${o.kind.padEnd(8)} ${String(`${sign}${o.delta}`).padStart(7)}  ${o.target}\n`
      );
    }
  }
}

function emitGithubDiffSummary(
  diff: Awaited<ReturnType<typeof replayDiff>>,
  files: string[]
): void {
  const pct =
    diff.baseline.processed > 0
      ? ((diff.routeChanges / diff.baseline.processed) * 100).toFixed(2)
      : '0.00';
  // GitHub annotations: emit a notice-level for the summary so it surfaces
  // in the PR check without painting the run red on its own.
  const tone = diff.routeChanges > 0 ? 'warning' : 'notice';
  process.stdout.write(
    `::${tone} title=logflow-sim diff::routeChanges=${diff.routeChanges} (${pct}%) movedToDelivered=+${diff.movedToDelivered} movedToUnmatched=-${diff.movedToUnmatched} files=${files.join(',')}\n`
  );
  // Also surface the top-3 output deltas as separate notices so reviewers
  // see the concrete impact inline.
  for (const o of diff.outputDeltas.slice(0, 3)) {
    const sign = o.delta > 0 ? '+' : '';
    process.stdout.write(
      `::notice title=logflow-sim output delta::${o.kind} ${sign}${o.delta} → ${o.target}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// detection-impact + detection-diff — Sigma rule coverage analysis
// ---------------------------------------------------------------------------

function loadSigmaRulesFromFlags(flags: CliFlags) {
  if (!flags.sigmaFiles || flags.sigmaFiles.length === 0) {
    die(`Sigma analysis requires one or more --sigma=PATH`, 3);
  }
  const allRules = [];
  const allDiags = [];
  for (const rel of flags.sigmaFiles ?? []) {
    const abs = path.resolve(rel);
    if (!fs.existsSync(abs)) die(`Sigma rule file not found: ${rel}`, 3);
    const content = fs.readFileSync(abs, 'utf8');
    const parsed = parseSigma({ path: rel, content });
    allRules.push(...parsed.rules);
    allDiags.push(...parsed.diagnostics);
  }
  if (allRules.length === 0) die(`No Sigma rules parsed from --sigma inputs`, 3);
  return { rules: allRules, diagnostics: allDiags };
}

async function cmdDetectionImpact(confDir: string, flags: CliFlags): Promise<number> {
  const ctx = await getModel(confDir, flags.entrypoint);
  if (shouldFail(flags, ctx.diagnostics)) {
    emitDiagnostics(flags, ctx.diagnostics);
    return 1;
  }
  const messages = collectMessages(flags);
  if (messages.length === 0) die(`No messages parsed from input`, 3);
  const { rules } = loadSigmaRulesFromFlags(flags);
  const report = detectionImpact({
    rules,
    messages,
    options: { maxMessages: flags.maxMessages }
  });
  if (flags.format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      `Detection impact: ${rules.length} rule(s) against ${messages.length} message(s) (${report.durationMs}ms)\n`
    );
    for (const r of report.rules) {
      const pct = report.processed > 0 ? ((r.fires / report.processed) * 100).toFixed(2) : '0.00';
      process.stdout.write(
        `  ${r.fires.toString().padStart(6)} fires (${pct}%)  ${r.level ? `[${r.level}] ` : ''}${r.title}\n`
      );
    }
  }
  return 0;
}

async function cmdDetectionDiff(confDir: string, flags: CliFlags): Promise<number> {
  const baseline = await getModel(confDir, flags.entrypoint);
  if (shouldFail(flags, baseline.diagnostics)) {
    emitDiagnostics(flags, baseline.diagnostics);
    return 1;
  }
  const messages = collectMessages(flags);
  if (messages.length === 0) die(`No messages parsed from input`, 3);
  const { rules } = loadSigmaRulesFromFlags(flags);
  const overlay = collectOverlayBundle(flags, confDir);
  if (Object.keys(overlay).length === 0) {
    die(`detection-diff requires --overlay-dir or --overlay-file(s)`, 3);
  }
  const entrypointVfs = '/' + flags.entrypoint.replace(/^conf\//, '').replace(/^\/+/, '');
  const overlayed = await (await import('../core/replay/index.js')).buildOverlayedModel(
    baseline.vfs,
    overlay,
    { entrypoint: entrypointVfs, dialect: 'rsyslog' }
  );

  // Enrich each side through its respective model so the Sigma matcher
  // sees post-routing properties (set $!sourcetype, lookup-derived tags).
  function enrich(model: typeof baseline.model, lookups: typeof baseline.lookupTables) {
    const { simulate } = require('../core/simulate/evaluator.js') as typeof import('../core/simulate/evaluator.js');
    return messages.map((m) => {
      try {
        const r = simulate({ model, lookupTables: lookups, message: m });
        return { ...m, structured: { ...(m.structured ?? {}), ...r.finalState.structured } };
      } catch {
        return m;
      }
    });
  }

  const diff = detectionDiff({
    rules,
    baselineMessages: enrich(baseline.model, baseline.lookupTables),
    overlayMessages: enrich(overlayed.model, overlayed.lookupTables),
    options: { maxMessages: flags.maxMessages }
  });

  if (flags.format === 'json') {
    process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
  } else if (flags.format === 'github') {
    const tone = diff.regressionsCount > 0 ? 'warning' : 'notice';
    process.stdout.write(
      `::${tone} title=logflow-sim detection-diff::${diff.regressionsCount} rule(s) regressed under overlay\n`
    );
    for (const e of diff.entries.slice(0, 10)) {
      if (e.delta === 0) continue;
      const sign = e.delta > 0 ? '+' : '';
      process.stdout.write(
        `::notice title=logflow-sim detection delta::${sign}${e.delta} fires (${e.pctChange}%) — ${e.title}\n`
      );
    }
  } else {
    process.stdout.write(
      `Detection diff — ${rules.length} rule(s), baseline vs overlay (${diff.baseline.durationMs + diff.overlay.durationMs}ms total)\n`
    );
    process.stdout.write(`  regressions: ${diff.regressionsCount}\n`);
    for (const e of diff.entries) {
      if (e.delta === 0) continue;
      const sign = e.delta > 0 ? '+' : '';
      process.stdout.write(
        `  ${sign}${String(e.delta).padStart(5)}  (${e.pctChange}%)  ${e.title}\n`
      );
    }
  }

  if (flags.maxRegression !== undefined && diff.regressionsCount > flags.maxRegression) {
    process.stderr.write(
      `logflow-sim: ${diff.regressionsCount} rule regressions > --max-regression=${flags.maxRegression}\n`
    );
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// convert — emit a whole config in another dialect, including lookup tables
// ---------------------------------------------------------------------------

async function cmdConvert(confDir: string, flags: CliFlags): Promise<number> {
  if (!flags.target) die(`convert requires --target=DIALECT`, 3);
  if (!flags.outDir) die(`convert requires --out-dir=PATH`, 3);
  const outAbs = path.resolve(flags.outDir);
  if (fs.existsSync(outAbs)) {
    const entries = fs.readdirSync(outAbs);
    if (entries.length > 0 && !flags.force) {
      die(`--out-dir is non-empty: ${outAbs} (use --force to overwrite)`, 3);
    }
  } else {
    fs.mkdirSync(outAbs, { recursive: true });
  }

  const ctx = await getModel(confDir, flags.entrypoint);
  if (shouldFail(flags, ctx.diagnostics)) {
    emitDiagnostics(flags, ctx.diagnostics);
    return 1;
  }

  const result = runConvert(ctx.model, flags.target, {
    lookupTables: ctx.lookupTables,
    sourceSiem: flags.sourceSiem,
    targetSiem: flags.targetSiem
  });

  // Write every emitted file. Paths are interpreted relative to outAbs and
  // path-traversal is rejected — an emitter shouldn't be writing outside
  // the user-specified output directory.
  const written: string[] = [];
  for (const f of result.files) {
    const abs = path.resolve(outAbs, f.path);
    if (!abs.startsWith(outAbs + path.sep) && abs !== outAbs) {
      die(`emitter tried to write outside --out-dir: ${f.path}`, 3);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    written.push(path.relative(outAbs, abs));
  }

  if (flags.format === 'json') {
    process.stdout.write(
      JSON.stringify(
        {
          sourceDialect: ctx.model.dialect,
          targetDialect: result.targetDialect,
          sourceSiem: result.sourceSiem,
          targetSiem: result.targetSiem,
          outDir: outAbs,
          files: written,
          diagnostics: result.diagnostics
        },
        null,
        2
      ) + '\n'
    );
  } else {
    const siemNote = result.targetSiem
      ? ` [SIEM ${result.sourceSiem ?? 'unknown'} → ${result.targetSiem}]`
      : '';
    process.stdout.write(
      `Converted ${confDir} (${ctx.model.dialect ?? 'auto'}) → ${result.targetDialect}${siemNote} into ${outAbs}\n`
    );
    for (const w of written) process.stdout.write(`  ${w}\n`);
    if (result.diagnostics.length > 0) {
      process.stdout.write(`\n${result.diagnostics.length} note(s):\n`);
      for (const d of result.diagnostics) {
        process.stdout.write(`  [${d.severity}] ${d.message}\n`);
      }
    }
  }
  return 0;
}

/**
 * `retag` — same as `convert` but keeps the source dialect, only rewrites
 * destination-side vocabulary. Useful when the user wants to translate
 * Splunk sourcetypes into ECS event.category without changing pipeline
 * syntax.
 */
async function cmdRetag(confDir: string, flags: CliFlags): Promise<number> {
  if (!flags.targetSiem) die(`retag requires --target-siem=ID`, 3);
  if (!flags.outDir) die(`retag requires --out-dir=PATH`, 3);
  const ctx = await getModel(confDir, flags.entrypoint);
  if (shouldFail(flags, ctx.diagnostics)) {
    emitDiagnostics(flags, ctx.diagnostics);
    return 1;
  }
  // Reuse the convert pipeline with the source dialect as target.
  return cmdConvert(confDir, { ...flags, target: ctx.model.dialect });
}

function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'localhost';
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const subcommand = positional[0];
  const confDir = positional[1];
  if (!subcommand) {
    printHelp();
    process.exit(3);
  }
  if (!confDir && subcommand !== 'help') die(`Missing <conf-dir> argument`, 3);

  switch (subcommand) {
    case 'parse':
      process.exit(await cmdParse(confDir, flags));
    case 'test':
      process.exit(await cmdTest(confDir, flags));
    case 'simulate':
      process.exit(await cmdSimulate(confDir, flags));
    case 'replay':
      process.exit(await cmdReplay(confDir, flags));
    case 'diff':
      process.exit(await cmdDiff(confDir, flags));
    case 'convert':
      process.exit(await cmdConvert(confDir, flags));
    case 'retag':
      process.exit(await cmdRetag(confDir, flags));
    case 'detection-impact':
      process.exit(await cmdDetectionImpact(confDir, flags));
    case 'detection-diff':
      process.exit(await cmdDetectionDiff(confDir, flags));
    case 'help':
      printHelp();
      process.exit(0);
    default:
      die(`Unknown subcommand: ${subcommand}`, 3);
  }
}

main().catch((e) => {
  process.stderr.write(`logflow-sim: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(3);
});
