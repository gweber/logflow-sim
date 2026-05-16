import express from 'express';
import { listDialects, convert } from '../../core/kernel.js';
import { BadRequestError } from '../../core/errors.js';
import { getPipeline } from '../pipeline.js';
import type { AppPaths } from '../context.js';
import { getConfRoot, dialectFromQuery } from '../context.js';
import { asyncHandler } from '../error-handler.js';
import type {
  DialectsListDTO,
  ConvertRequestDTO,
  ConvertResponseDTO
} from '../dto.js';

export function dialectsRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.get('/dialects', (_req, res) => {
    const body: DialectsListDTO = {
      dialects: listDialects().map((d) => ({
        id: d.id,
        displayName: d.displayName,
        fileExtensions: d.fileExtensions
      }))
    };
    res.json(body);
  });

  r.post(
    '/convert',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as ConvertRequestDTO;
      const target = String(body.target ?? '');
      if (!target) throw new BadRequestError('target dialect required');
      const pipeline = await getPipeline({
        confRoot: getConfRoot(paths),
        dialect: body.dialect
      });
      const result = convert(pipeline.model, target, {
        lookupTables: pipeline.lookupTables
      });
      const response: ConvertResponseDTO = {
        sourceDialect: pipeline.dialect,
        targetDialect: result.targetDialect,
        output: result.output,
        files: result.files,
        diagnostics: result.diagnostics
      };
      res.json(response);
    })
  );

  return r;
}
