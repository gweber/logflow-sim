import path from 'node:path';
import { NodeVFS } from '../vfs/node.js';
import { load, analyze, validate } from '../core/kernel.js';
import type { IRModel } from '../core/ir/model.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { LookupTableData } from '../core/lookups/types.js';
import type { AnalysisReport, ValidationReport } from '../core/kernel.js';

export interface PipelineResult {
  confRoot: string;
  entrypoint: string;
  files: { path: string; absPath: string; size: number; content: string }[];
  fileContent: Record<string, string>;
  model: IRModel;
  lookupTables: Record<string, LookupTableData>;
  diagnostics: Diagnostic[];
  analysis: AnalysisReport;
  validation: ValidationReport;
  dialect: string;
  mtime: number;
}

let cache: { key: string; mtime: number; result: PipelineResult } | null = null;

export async function getPipeline(opts: {
  confRoot: string;
  entrypoint?: string;
  dialect?: string;
}): Promise<PipelineResult> {
  const confRoot = path.resolve(opts.confRoot);
  const entrypointName =
    opts.entrypoint ?? process.env.RSYSLOG_CONF_ENTRYPOINT ?? 'rsyslog.conf';
  const entrypoint = '/' + entrypointName.replace(/^conf\//, '').replace(/^\/+/, '');
  const key = `${confRoot}::${entrypoint}::${opts.dialect ?? 'auto'}`;

  const vfs = new NodeVFS(confRoot);
  const mtime = vfs.maxMtimeSync();
  if (cache && cache.key === key && cache.mtime === mtime) return cache.result;

  const loaded = await load(vfs, { entrypoint, dialect: opts.dialect });
  const analysis = analyze(loaded.model);
  const validation = validate(loaded.model);

  const files = loaded.files.map((f) => ({
    path: f.path,
    absPath: vfs.toHost('/' + f.path.replace(/^\/+/, '')),
    size: f.content.length,
    content: f.content
  }));
  const fileContent: Record<string, string> = {};
  for (const f of files) fileContent[f.path] = f.content;

  const result: PipelineResult = {
    confRoot,
    entrypoint: vfs.toHost(entrypoint),
    files,
    fileContent,
    model: loaded.model,
    lookupTables: loaded.lookupTables,
    diagnostics: [...loaded.diagnostics, ...validation.findings],
    analysis,
    validation,
    dialect: loaded.dialect,
    mtime
  };
  cache = { key, mtime, result };
  return result;
}

export function invalidatePipeline(): void {
  cache = null;
}
