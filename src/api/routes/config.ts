import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getPipeline, invalidatePipeline } from '../pipeline.js';
import { ForbiddenError, NotFoundError, BadRequestError } from '../../core/errors.js';
import {
  toParseSummaryDTO,
  toAnalysisSummaryDTO,
  toValidationSummaryDTO
} from '../mappers.js';
import { asyncHandler } from '../error-handler.js';
import { getConfRoot, dialectFromQuery } from '../context.js';
import type { AppPaths } from '../context.js';
import type {
  ParseResponseDTO,
  ConfigTreeDTO,
  ConfigBundleDTO,
  SearchResponseDTO,
  SearchMatchDTO
} from '../dto.js';

function walkFiles(root: string): { rel: string; abs: string; size: number }[] {
  const out: { rel: string; abs: string; size: number }[] = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          // size 0 is fine for "unreadable size"
        }
        out.push({ rel, abs, size });
      }
    }
  };
  walk(root);
  return out;
}

export function configRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.post('/invalidate', (req, res) => {
    // Gate the cache-invalidate call. Anyone could otherwise hot-loop it
    // and force re-parses on every request, defeating the cache. When
    // `LOGFLOW_INVALIDATE_TOKEN` is set, we require it as a bearer token.
    // When unset (default — dev mode), the endpoint is open.
    const expected = process.env.LOGFLOW_INVALIDATE_TOKEN;
    if (expected) {
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (presented !== expected) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token.' }
        });
        return;
      }
    }
    invalidatePipeline();
    res.json({ ok: true });
  });

  r.get(
    '/config/tree',
    asyncHandler(async (req, res) => {
      const confRoot = getConfRoot(paths);
      const pipeline = await getPipeline({ confRoot, dialect: dialectFromQuery(req.query) });
      const referenced = new Set(pipeline.files.map((f) => f.path));
      const body: ConfigTreeDTO = {
        confRoot,
        entrypoint: path.relative(confRoot, pipeline.entrypoint),
        files: walkFiles(confRoot).map((f) => ({
          path: f.rel,
          size: f.size,
          referenced: referenced.has(f.rel)
        }))
      };
      res.json(body);
    })
  );

  r.get('/config/file', (req, res) => {
    const rel = String(req.query.path ?? '');
    const confRoot = getConfRoot(paths);
    const abs = path.resolve(confRoot, rel);
    if (!abs.startsWith(confRoot + path.sep) && abs !== confRoot) {
      throw new ForbiddenError('Path traversal rejected', { path: rel });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new NotFoundError('File not found', { path: rel });
    }
    res.type('text/plain').send(fs.readFileSync(abs, 'utf8'));
  });

  r.get(
    '/config/search',
    asyncHandler(async (req, res) => {
      const q = String(req.query.q ?? '').trim();
      // ReDoS-mitigation: cap the query length. Real-world greps run on
      // identifiers ("10.254.0.5", "fw-paris", "linux:secure") that fit
      // well under 256 chars. A 50k-char malicious regex needs to come
      // from elsewhere.
      if (q.length > 256) {
        throw new BadRequestError(
          `Search query too long (${q.length} chars > 256). Narrow the query.`
        );
      }
      const caseSensitive = req.query.cs === '1' || req.query.cs === 'true';
      const useRegex = req.query.regex === '1' || req.query.regex === 'true';
      const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 5000);
      if (!q) {
        const empty: SearchResponseDTO = {
          query: q,
          caseSensitive,
          regex: useRegex,
          total: 0,
          truncated: false,
          matches: []
        };
        res.json(empty);
        return;
      }
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      let matcher: (line: string) => { idx: number; len: number } | null;
      try {
        if (useRegex) {
          const re = new RegExp(q, caseSensitive ? 'g' : 'gi');
          matcher = (line) => {
            re.lastIndex = 0;
            const m = re.exec(line);
            return m ? { idx: m.index, len: m[0].length } : null;
          };
        } else {
          const needle = caseSensitive ? q : q.toLowerCase();
          matcher = (line) => {
            const hay = caseSensitive ? line : line.toLowerCase();
            const idx = hay.indexOf(needle);
            return idx === -1 ? null : { idx, len: q.length };
          };
        }
      } catch (e) {
        throw new BadRequestError(`Invalid regex: ${(e as Error).message}`);
      }

      const matches: SearchMatchDTO[] = [];
      let truncated = false;
      outer: for (const [file, content] of Object.entries(pipeline.fileContent)) {
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          const m = matcher(ln);
          if (!m) continue;
          matches.push({
            file,
            line: i + 1,
            col: m.idx + 1,
            snippet: ln.length > 200 ? ln.slice(0, 200) + '…' : ln,
            matchStart: m.idx,
            matchLen: m.len
          });
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
        }
      }
      const body: SearchResponseDTO = {
        query: q,
        caseSensitive,
        regex: useRegex,
        total: matches.length,
        truncated,
        matches
      };
      res.json(body);
    })
  );

  r.get(
    '/config/parse',
    asyncHandler(async (req, res) => {
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const body: ParseResponseDTO = {
        dialect: pipeline.dialect,
        diagnostics: pipeline.model.diagnostics,
        summary: toParseSummaryDTO(pipeline.model),
        defaultRuleset: pipeline.model.globals.defaultRuleset ?? null,
        analysis: toAnalysisSummaryDTO(pipeline.analysis),
        validation: toValidationSummaryDTO(pipeline.validation)
      };
      res.json(body);
    })
  );

  r.get(
    '/model',
    asyncHandler(async (req, res) => {
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const m = pipeline.model;
      res.json({
        dialect: m.dialect,
        inputs: m.inputs,
        rulesets: m.rulesets,
        templates: m.templates,
        lookupTables: m.lookupTables.map((lt) => ({
          ...lt,
          loaded: !!pipeline.lookupTables[lt.name]?.loaded,
          size: pipeline.lookupTables[lt.name]?.size ?? 0,
          format: pipeline.lookupTables[lt.name]?.format ?? null,
          error: pipeline.lookupTables[lt.name]?.error ?? null
        })),
        modules: m.modules,
        globals: m.globals,
        outputs: m.outputs,
        filters: m.filters,
        routes: m.routes,
        diagnostics: m.diagnostics,
        files: m.files
      });
    })
  );

  r.get(
    '/config/bundle',
    asyncHandler(async (req, res) => {
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: dialectFromQuery(req.query)
      });
      const files: Record<string, string> = {};
      for (const f of pipeline.files) files[f.path] = f.content;
      // Include lookup-table files so the browser can resolve them.
      for (const lt of Object.values(pipeline.lookupTables)) {
        if (lt.loaded && lt.filePath) {
          try {
            const rel = path.relative(pipeline.confRoot, path.resolve(lt.filePath));
            if (!rel.startsWith('..') && !files[rel]) {
              files[rel] = fs.readFileSync(lt.filePath, 'utf8');
            }
          } catch {
            // Best-effort: tolerate per-file read errors.
          }
        }
      }
      const body: ConfigBundleDTO = {
        dialect: pipeline.dialect,
        entrypoint: path.relative(pipeline.confRoot, pipeline.entrypoint),
        files
      };
      res.json(body);
    })
  );

  return r;
}
