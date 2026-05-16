import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getPipeline } from '../pipeline.js';
import { simulate } from '../../core/simulate/evaluator.js';
import type { SyslogMessage } from '../../core/simulate/syslog-message.js';
import { asyncHandler } from '../error-handler.js';
import { getConfRoot, dialectFromQuery, safeHostname } from '../context.js';
import type { AppPaths } from '../context.js';
import type {
  TestCaseDTO,
  TestRunResponseDTO,
  TestRunResultDTO,
  TestRunCheckDTO
} from '../dto.js';
import { toSimulateResponseDTO } from '../mappers.js';

export function testsRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.get('/tests', (_req, res) => {
    const dir = path.join(getConfRoot(paths), 'tests');
    res.json({ tests: readTestCases(dir) });
  });

  r.post(
    '/tests/run',
    asyncHandler(async (req, res) => {
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const dir = path.join(getConfRoot(paths), 'tests');
      const cases = readTestCases(dir);
      const fallbackHostname = process.env.RSYSLOG_MYHOSTNAME ?? safeHostname();

      const results: TestRunResultDTO[] = cases.map((tc) => {
        const inputMsg = tc.input as Partial<SyslogMessage> & Record<string, unknown>;
        const msg: SyslogMessage = {
          ...(inputMsg as SyslogMessage),
          myhostname:
            typeof inputMsg.myhostname === 'string' ? inputMsg.myhostname : fallbackHostname
        };
        const simResult = simulate({
          model: pipeline.model,
          lookupTables: pipeline.lookupTables,
          message: msg
        });
        const checks = runExpectations(tc.expect ?? {}, simResult);
        const dto = toSimulateResponseDTO(simResult);
        return {
          name: tc.name,
          file: tc.file,
          passed: checks.every((c) => c.passed),
          checks,
          result: {
            selectedRuleset: dto.selectedRuleset,
            finalState: dto.finalState,
            trace: dto.trace
          }
        };
      });

      const body: TestRunResponseDTO = {
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        results
      };
      res.json(body);
    })
  );

  return r;
}

function readTestCases(dir: string): TestCaseDTO[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const out: TestCaseDTO[] = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const t of arr as TestCaseDTO[]) {
      out.push({
        name: t.name ?? f,
        file: f,
        input: t.input ?? {},
        expect: t.expect
      });
    }
  }
  return out;
}

interface Expectation {
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
}

function runExpectations(
  expect: Record<string, unknown>,
  result: ReturnType<typeof simulate>
): TestRunCheckDTO[] {
  const e = expect as Expectation;
  const checks: TestRunCheckDTO[] = [];
  if (e.ruleset !== undefined) {
    checks.push({
      name: 'ruleset',
      want: e.ruleset,
      got: result.selectedRuleset,
      passed: result.selectedRuleset === e.ruleset
    });
  }
  if (e.stopped !== undefined) {
    checks.push({
      name: 'stopped',
      want: e.stopped,
      got: result.finalState.stopped,
      passed: result.finalState.stopped === e.stopped
    });
  }
  if (e.dropped !== undefined) {
    checks.push({
      name: 'dropped',
      want: e.dropped,
      got: result.finalState.dropped,
      passed: result.finalState.dropped === e.dropped
    });
  }
  if (e.outputsContains) {
    for (const exp of e.outputsContains) {
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
  if (e.structured) {
    for (const [k, v] of Object.entries(e.structured)) {
      checks.push({
        name: `structured.${k}`,
        want: v,
        got: result.finalState.structured[k],
        passed: result.finalState.structured[k] === v
      });
    }
  }
  if (e.localVars) {
    for (const [k, v] of Object.entries(e.localVars)) {
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
